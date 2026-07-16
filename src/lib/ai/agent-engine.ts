/**
 * AI Agent engine — the core execution loop.
 *
 * When the webhook receives an inbound message that wasn't consumed
 * by Flows or Automations, the dispatcher calls `executeAgent()`.
 * The engine:
 *   1. Loads the agent config (prompt, model, skills, knowledge bases)
 *   2. Searches knowledge bases for relevant context (RAG)
 *   3. Builds the full prompt (system + CRM context + history + KB)
 *   4. Calls the LLM via OpenRouter
 *   5. If the LLM returns tool calls → executes skills → feeds results
 *      back → calls LLM again (tool-use loop, max 3 iterations)
 *   6. Sends the final text reply via WhatsApp
 *   7. Logs everything (tokens, cost, latency) to ai_conversation_logs
 *
 * Must never throw — the webhook calls this fire-and-forget. All
 * errors are caught and logged.
 */

import type {
  AIAgent,
  AIAgentSkill,
  AIDispatchInput,
  ModelConfig,
  ModelResponse,
  SkillContext,
  ToolDefinition,
} from './types'
import { callModel } from './model-client'
import { buildPrompt } from './prompt-builder'
import { getSkillDefinition } from './skills'
import { supabaseAdmin } from './admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTextMessage, getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { generateEmbeddings } from './embedding-client'
import { replyToComment, sendDirectMessage } from '@/lib/tiktok/tiktok-api'

// ============================================================
// Constants
// ============================================================

/** Maximum tool-call → re-call iterations to prevent infinite loops. */
const MAX_TOOL_ITERATIONS = 3

// ============================================================
// Public API
// ============================================================

/**
 * Execute the AI agent for a single inbound message.
 *
 * Called by the dispatcher after confirming the agent is active and
 * the conversation is not paused. Returns the agent's reply text
 * (or null if the agent couldn't respond).
 */
export async function executeAgent(
  agent: AIAgent,
  input: AIDispatchInput,
): Promise<string | null> {
  const startMs = Date.now()
  const db = supabaseAdmin()
  let isLinkedPhone = false

  let isAutoPause = false
  let replyText = ''

  try {
    // ============ DYNAMIC AUDIO TRANSCRIPTION (SYSTEM LEVEL via Groq) ============
    if (input.mediaUrl && input.mediaType && input.mediaType.startsWith('audio/')) {
      const groqApiKey = process.env.GROQ_API_KEY
      if (!groqApiKey) {
        console.warn('[ai/engine] GROQ_API_KEY is not configured. Skipping audio transcription.')
      } else {
        try {
          console.log(`[ai/engine] Downloading audio for transcription: ${input.mediaUrl}`)
          const isDirectUrl = input.mediaUrl.startsWith('http://') || input.mediaUrl.startsWith('https://')
          const mediaId = isDirectUrl ? 'direct-' + Date.now() : input.mediaUrl.split('/').pop()
          if (mediaId) {
            let buffer: Buffer
            let contentType: string

            if (isDirectUrl) {
              const res = await fetch(input.mediaUrl)
              if (!res.ok) throw new Error(`Failed to fetch media directly: ${res.statusText}`)
              const arrayBuffer = await res.arrayBuffer()
              buffer = Buffer.from(arrayBuffer)
              contentType = res.headers.get('content-type') || input.mediaType
            } else {
              const mediaInfo = await getMediaUrl({ mediaId, accessToken: input.accessToken })
              const downloaded = await downloadMedia({
                downloadUrl: mediaInfo.url,
                accessToken: input.accessToken
              })
              buffer = downloaded.buffer
              contentType = downloaded.contentType
            }

            const transcription = await transcribeAudioWithGroq(
              buffer,
              `voice-${mediaId}.ogg`,
              contentType || input.mediaType,
              groqApiKey
            )

            if (transcription) {
              console.log(`[ai/engine] Transcribed text: "${transcription}"`)
              input.messageText = transcription

              // Update the messages table in DB with the transcription text for Inbox view
              const { data: lastMsg } = await db
                .from('messages')
                .select('id')
                .eq('conversation_id', input.conversationId)
                .eq('sender_type', 'customer')
                .eq('content_type', 'audio')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()

              if (lastMsg?.id) {
                await db
                  .from('messages')
                  .update({ content_text: `🎙️ Transcription: ${transcription}` })
                  .eq('id', lastMsg.id)
              }
            }
          }
        } catch (transcribeErr) {
          console.error('[ai/engine] Audio transcription failed:', transcribeErr)
        }
      }
    }

    // ============ IMAGE VISION PREPARATION (SYSTEM LEVEL) ============
    let inboundImageBase64: string | null = null
    let inboundImageMimeType: string | null = null

    if (input.mediaUrl && input.mediaType && input.mediaType.startsWith('image/')) {
      try {
        console.log(`[ai/engine] Downloading image for vision analysis: ${input.mediaUrl}`)
        const isDirectUrl = input.mediaUrl.startsWith('http://') || input.mediaUrl.startsWith('https://')
        const mediaId = isDirectUrl ? 'direct-' + Date.now() : input.mediaUrl.split('/').pop()
        if (mediaId) {
          let buffer: Buffer
          let contentType: string

          if (isDirectUrl) {
            const res = await fetch(input.mediaUrl)
            if (!res.ok) throw new Error(`Failed to fetch media directly: ${res.statusText}`)
            const arrayBuffer = await res.arrayBuffer()
            buffer = Buffer.from(arrayBuffer)
            contentType = res.headers.get('content-type') || input.mediaType
          } else {
            const mediaInfo = await getMediaUrl({ mediaId, accessToken: input.accessToken })
            const downloaded = await downloadMedia({
              downloadUrl: mediaInfo.url,
              accessToken: input.accessToken
            })
            buffer = downloaded.buffer
            contentType = downloaded.contentType
          }

          inboundImageBase64 = buffer.toString('base64')
          inboundImageMimeType = contentType || input.mediaType
        }
      } catch (imageErr) {
        console.error('[ai/engine] Image download for vision failed:', imageErr)
      }
    }

    const hasInboundImage = !!inboundImageBase64

    // ============ DYNAMIC IMAGE DESCRIPTION FOR TEXT-ONLY MODELS ============
    if (inboundImageBase64 && inboundImageMimeType) {
      const activeModelName = agent.model_name
      if (activeModelName.includes('deepseek')) {
        console.log(`[ai/engine] Active model ${activeModelName} is text-only. Describing image via llama-3.2-11b-vision-instruct...`)
        try {
          const apiKey = agent.openrouter_api_key ?? agent.openrouter_key
          if (apiKey) {
            const decryptedKey = decrypt(apiKey)
            const visionConfig: ModelConfig = {
              model: 'meta-llama/llama-3.2-11b-vision-instruct',
              temperature: 0.2,
              max_tokens: 1000,
              apiKey: decryptedKey,
            }
            
            const visionMessages = [
              {
                role: 'user' as const,
                content: [
                  { type: 'text' as const, text: 'Describe the contents of this image in detail. Be precise and cover any readable text, objects, and visual layout.' },
                  {
                    type: 'image_url' as const,
                    image_url: {
                      url: `data:${inboundImageMimeType};base64,${inboundImageBase64}`
                    }
                  }
                ]
              }
            ]
            
            const visionRes = await callModel(visionConfig, visionMessages)
            const imageDescription = visionRes.content
            if (imageDescription) {
              console.log('[ai/engine] Vision analysis description:', imageDescription)
              const originalText = input.messageText || ''
              input.messageText = `${originalText}\n\n[Attached Image Description: ${imageDescription}]`.trim()
              
              // Clear these so we don't pass base64 payload to text-only DeepSeek
              inboundImageBase64 = null
              inboundImageMimeType = null
            }
          }
        } catch (visionErr) {
          console.error('[ai/engine] Vision analysis description failed:', visionErr)
        }
      }
    }

    // ============ AUTO-PAUSE CHECK (SYSTEM LEVEL) ============
    const autoPauseEnabled = agent.auto_pause_enabled !== false // defaults to true
    if (autoPauseEnabled) {
      const keywords = agent.auto_pause_keywords && agent.auto_pause_keywords.length > 0
        ? agent.auto_pause_keywords
        : [
            "stop", "unsubscribe", "pause", "human", "talk to a human", 
            "talk to a real person", "speak to a human", "speak to a real person", 
            "pass me on to a boss", "chat with a human", "talk to human", 
            "human agent", "real person", "speak to human", "talk to person", 
            "talk to a person", "stop bot", "pause bot", "stop the bot", "pause the bot"
          ]

      const autoPauseResult = shouldAutoPause(input.messageText, keywords)
      if (autoPauseResult.matches) {
        isAutoPause = true
        console.log(`[ai/engine] Auto-pause triggered by keyword: "${autoPauseResult.matchedKeyword}"`)

        // Determine pause behavior based on agent's takeover mode
        let pausedUntil: string | null = null
        if (agent.takeover_mode === 'timeout') {
          const timeoutMs = (agent.takeover_timeout_minutes ?? 120) * 60 * 1000
          pausedUntil = new Date(Date.now() + timeoutMs).toISOString()
        }

        // 1. Pause the AI on this conversation
        await db
          .from('conversations')
          .update({
            ai_status: 'paused',
            ai_paused_until: pausedUntil,
            status: 'open', // Ensure it shows in the inbox
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.conversationId)

        // 2. Insert a system-level note so the owner/agent knows why it was paused
        await db.from('messages').insert({
          conversation_id: input.conversationId,
          sender_type: 'bot',
          content_type: 'text',
          content_text: `⚠️ AI Auto-Escalation: Conversation paused due to user keyword "${autoPauseResult.matchedKeyword}".`,
          status: 'delivered',
        })

        replyText = `Understood. I have paused the AI assistant. A team member will follow up with you shortly.`
      }
    }

    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalCost = 0
    let response: ModelResponse | null = null

    if (!isAutoPause) {
      // ============ 1. DECRYPT API KEY ============
      const apiKey = agent.openrouter_api_key ?? agent.openrouter_key
      if (!apiKey) {
        console.warn(`[ai/engine] Agent ${agent.id} has no API key configured`)
        return null
      }
      const decryptedKey = decrypt(apiKey)

      // ============ TRIGGER TYPING STATUS ============
      const isWhatsApp = !input.channel || input.channel === 'whatsapp'
      if (isWhatsApp) {
        const { data: waConfig } = await db
          .from('whatsapp_config')
          .select('phone_number_id')
          .eq('account_id', input.accountId)
          .maybeSingle()
        if (waConfig?.phone_number_id === 'linked-phone') {
          isLinkedPhone = true
        }
      }

      const delaySeconds = agent.response_delay_seconds ?? 0
      // Trigger typing immediately ONLY if there is no response delay configured.
      // If a delay is set, we wait silently first and trigger typing right before sending.
      if (isLinkedPhone && delaySeconds === 0) {
        void setGatewayPresence(input.accountId, input.contactId, 'composing')
      }

      // ============ 2. LOAD AGENT SKILLS ============
      const { data: skillRows } = await db
        .from('ai_agent_skills')
        .select('*')
        .eq('agent_id', agent.id)
        .eq('is_enabled', true)

      const skills: AIAgentSkill[] = skillRows ?? []
      const toolDefs: ToolDefinition[] = []
      for (const skill of skills) {
        const def = getSkillDefinition(skill.skill_type)
        if (def) toolDefs.push(def.tool)
      }

      // ============ 3. RAG — SEARCH KNOWLEDGE BASES ============
      let knowledgeContext: string | undefined
      const { data: kbLinks } = await db
        .from('ai_agent_knowledge_bases')
        .select('knowledge_base_id')
        .eq('agent_id', agent.id)
        .limit(1)

      if (kbLinks && kbLinks.length > 0) {
        knowledgeContext = await searchKnowledgeBases(agent.id, input.messageText, decryptedKey)
      }

      // ============ 4. BUILD PROMPT ============
      let masterPrompt = agent.system_prompt
      
      // Stitch the GHL-style structured prompt fields together if any are present
      if (agent.prompt_personality || agent.prompt_goal || agent.prompt_general_info) {
        const parts = []
        if (agent.prompt_personality) parts.push(`## Personality\n${agent.prompt_personality}`)
        if (agent.prompt_goal) parts.push(`## Goal\n${agent.prompt_goal}`)
        if (agent.prompt_general_info) parts.push(`## General Information\n${agent.prompt_general_info}`)
        masterPrompt = parts.join('\n\n')
      }

      const messages = await buildPrompt({
        systemPrompt: masterPrompt,
        contactId: input.contactId,
        conversationId: input.conversationId,
        accountId: input.accountId,
        inboundText: input.messageText,
        knowledgeContext,
        inboundImageBase64,
        inboundImageMimeType,
      })

      // ============ 5. CALL LLM (with tool-use loop) ============
      const activeModelName = agent.model_name

      const modelConfig: ModelConfig = {
        model: activeModelName,
        temperature: agent.temperature,
        max_tokens: agent.max_tokens,
        apiKey: decryptedKey,
      }

      const currentMessages = [...messages]

      for (let iteration = 0; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
        response = await callModel(
          modelConfig,
          currentMessages,
          toolDefs.length > 0 ? toolDefs : undefined,
        )

        totalPromptTokens += response.usage.prompt_tokens
        totalCompletionTokens += response.usage.completion_tokens
        totalCost += response.cost_usd

        // If no tool calls, we have the final response
        if (!response.tool_calls || response.tool_calls.length === 0) {
          break
        }

        // If this is the last iteration, break to prevent infinite loops
        if (iteration === MAX_TOOL_ITERATIONS) {
          console.warn(
            `[ai/engine] Agent ${agent.id} hit max tool iterations (${MAX_TOOL_ITERATIONS})`,
          )
          break
        }

        // ============ EXECUTE TOOL CALLS ============
        const skillContext: SkillContext = {
          accountId: input.accountId,
          contactId: input.contactId,
          conversationId: input.conversationId,
          agentId: agent.id,
        }

        // Add assistant's tool-call message to history
        currentMessages.push({
          role: 'assistant',
          content: response.content,
          tool_calls: response.tool_calls,
        })

        // Execute each tool call and add results
        for (const toolCall of response.tool_calls) {
          const skillType = toolCall.function.name
          const def = getSkillDefinition(skillType)

          let resultText: string
          if (!def) {
            resultText = `Error: Unknown tool "${skillType}"`
            console.warn(`[ai/engine] LLM called unknown tool: ${skillType}`)
          } else {
            try {
              const params = JSON.parse(toolCall.function.arguments)
              const result = await def.execute(params, skillContext)
              resultText = result.data
            } catch (err) {
              resultText = `Error executing ${skillType}: ${err instanceof Error ? err.message : String(err)}`
              console.error(`[ai/engine] Skill ${skillType} failed:`, err)
            }
          }

          currentMessages.push({
            role: 'tool',
            content: resultText,
            tool_call_id: toolCall.id,
            name: skillType,
          })
        }
      }

      if (!response?.content) {
        console.warn(`[ai/engine] Agent ${agent.id} produced no response content`)
        if (isLinkedPhone) {
          void setGatewayPresence(input.accountId, input.contactId, 'paused')
        }
        return null
      }

      // ============ HUMAN-LIKE RESPONSE DELAY ============
      if (delaySeconds > 0) {
        const safeDelay = Math.min(delaySeconds, 45) // Cap at 45s for serverless stability
        const typingTime = Math.min(3, safeDelay) // Typing indicator active for up to 3s
        const silentDelay = safeDelay - typingTime

        if (silentDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, silentDelay * 1000))
        }

        if (isLinkedPhone) {
          void setGatewayPresence(input.accountId, input.contactId, 'composing')
        }

        if (typingTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, typingTime * 1000))
        }
      }

      replyText = response.content
    }

    // ============ 6. SEND REPLY (WITH APPROVAL & CHANNEL ROUTING) ============
    if (agent.approval_mode && !isAutoPause && response) {
      // Create a pending approval message instead of sending it
      const messageId = `draft-${crypto.randomUUID()}`
      await db.from('messages').insert({
        conversation_id: input.conversationId,
        sender_type: 'bot',
        content_type: 'text',
        content_text: replyText,
        message_id: messageId,
        status: 'pending_approval',
        channel: input.channel ?? 'whatsapp',
      })

      // Update conversation's last message text to show as draft
      await db
        .from('conversations')
        .update({
          last_message_text: `[Draft] ${replyText.substring(0, 60)}...`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', input.conversationId)

      // Still log usage so we track latency/tokens for the draft generation
      const latencyMs = Date.now() - startMs
      await db.from('ai_conversation_logs').insert({
        agent_id: agent.id,
        conversation_id: input.conversationId,
        model_used: response.model,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        total_cost_usd: totalCost,
        latency_ms: latencyMs,
      })

      if (isLinkedPhone) {
        void setGatewayPresence(input.accountId, input.contactId, 'paused')
      }
      return replyText
    }

    if (input.channel === 'facebook' || input.channel === 'instagram') {
      const { data: connAcc } = await db
        .from('connected_accounts')
        .select('access_token')
        .eq('account_id', input.accountId)
        .eq('provider', input.channel)
        .maybeSingle()

      if (!connAcc || !connAcc.access_token) {
        console.error(`[ai/engine] No access token found for channel ${input.channel}`)
        return null
      }

      // Decrypt Meta Page Access Token safely
      let token = connAcc.access_token
      try {
        token = decrypt(connAcc.access_token)
      } catch {
        // Plain text
      }

      const { data: lastCustMsg } = await db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', input.conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const isComment = lastCustMsg?.message_id.startsWith('comment:') || false
      const parentId = isComment && lastCustMsg
        ? lastCustMsg.message_id.slice('comment:'.length)
        : lastCustMsg?.message_id.startsWith('dm:') && lastCustMsg
          ? lastCustMsg.message_id.slice('dm:'.length)
          : lastCustMsg?.message_id

      let messageId = ''
      if (isComment && parentId) {
        // Reply to the post comment
        const url = `https://graph.facebook.com/v19.0/${parentId}/comments?access_token=${token}`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: replyText })
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          console.error('[ai/engine] Meta Comment send failed:', err)
          return null
        }
        const resData = await res.json()
        messageId = resData.id || ''
      } else {
        // Send DM (Messenger or Instagram DM)
        const contactPhone = await getContactPhone(input.contactId)
        const recipientId = contactPhone.includes(':')
          ? contactPhone.split(':')[1]
          : contactPhone
        
        const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text: replyText }
          })
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          console.error('[ai/engine] Meta Message send failed:', err)
          return null
        }
        const resData = await res.json()
        messageId = resData.message_id || ''
      }

      if (messageId) {
        const prefixedBotMsgId = isComment ? `comment:${messageId}` : `dm:${messageId}`

        await db.from('messages').insert({
          conversation_id: input.conversationId,
          sender_type: 'bot',
          content_type: 'text',
          content_text: replyText,
          message_id: prefixedBotMsgId,
          status: 'sent',
          channel: input.channel,
        })

        await db
          .from('conversations')
          .update({
            last_message_text: replyText,
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.conversationId)
      }
    } else if (input.channel === 'tiktok') {
      // ============ TIKTOK CHANNEL ROUTING ============
      const { data: connAcc } = await db
        .from('connected_accounts')
        .select('access_token, provider_account_id')
        .eq('account_id', input.accountId)
        .eq('provider', 'tiktok')
        .maybeSingle()

      if (!connAcc || !connAcc.access_token) {
        console.error('[ai/engine] No access token found for TikTok channel')
        return null
      }

      // Decrypt the stored access token safely
      let token = connAcc.access_token
      try {
        token = decrypt(connAcc.access_token)
      } catch {
        // Plain text — use as-is
      }

      const businessId = connAcc.provider_account_id || ''

      // Determine whether the last customer message was a comment or DM
      const { data: lastCustMsg } = await db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', input.conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const isComment = lastCustMsg?.message_id.startsWith('comment:') || false
      let videoId = ''
      let parentCommentId = ''
      if (isComment && lastCustMsg) {
        const parts = lastCustMsg.message_id.split(':')
        videoId = parts[1] || ''
        parentCommentId = parts[2] || ''
      } else if (lastCustMsg) {
        parentCommentId = lastCustMsg.message_id.startsWith('dm:')
          ? lastCustMsg.message_id.slice('dm:'.length)
          : lastCustMsg.message_id
      }

      let messageId = ''

      if (isComment && parentCommentId && videoId) {
        // Reply to a TikTok video comment
        const result = await replyToComment({
          accessToken: token,
          businessId,
          videoId,
          commentId: parentCommentId,
          text: replyText,
        })
        if (!result.success) {
          console.error('[ai/engine] TikTok comment reply failed:', result.error)
          return null
        }
        messageId = result.commentId || `tiktok-reply-${Date.now()}`
      } else {
        // Send a TikTok DM
        const contactPhone = await getContactPhone(input.contactId)
        // contactPhone format is "tiktok:<open_id>" — extract the open_id
        const recipientOpenId = contactPhone.startsWith('tiktok:')
          ? contactPhone.slice('tiktok:'.length)
          : contactPhone

        const result = await sendDirectMessage({
          accessToken: token,
          businessId,
          recipientOpenId,
          text: replyText,
        })
        if (!result.success) {
          console.error('[ai/engine] TikTok DM send failed:', result.error)
          return null
        }
        messageId = result.messageId || `tiktok-dm-${Date.now()}`
      }

      // Insert bot message into database
      if (messageId) {
        const prefixedBotMsgId = isComment 
          ? `comment:${videoId}:${messageId}` 
          : `dm:${messageId}`

        await db.from('messages').insert({
          conversation_id: input.conversationId,
          sender_type: 'bot',
          content_type: 'text',
          content_text: replyText,
          message_id: prefixedBotMsgId,
          status: 'sent',
          channel: 'tiktok',
        })

        // Update conversation timestamps
        await db
          .from('conversations')
          .update({
            last_message_text: replyText,
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.conversationId)
      }
    } else {
      // Find the WhatsApp config for this account to get the phone_number_id
      const { data: waConfig } = await db
        .from('whatsapp_config')
        .select('phone_number_id, access_token')
        .eq('account_id', input.accountId)
        .maybeSingle()

      if (waConfig) {
        const contactPhone = await getContactPhone(input.contactId)
        const sanitizedPhone = contactPhone.replace(/\D/g, '')

        let messageId = ''

        if (waConfig.phone_number_id === 'linked-phone') {
          const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL
          if (!gatewayUrl) {
            console.error('[ai/engine] WHATSAPP_GATEWAY_URL environment variable is not defined')
            return null
          }

          const sendUrl = gatewayUrl.endsWith('/api/messages/send')
            ? gatewayUrl
            : `${gatewayUrl.replace(/\/$/, '')}/api/messages/send`

          messageId = `3EB0${crypto.randomUUID().replace(/-/g, '').substring(0, 18).toUpperCase()}`

          await db.from('messages').insert({
            conversation_id: input.conversationId,
            sender_type: 'bot',
            content_type: 'text',
            content_text: replyText,
            message_id: messageId,
            status: 'sent',
            channel: 'whatsapp',
          })

          let gatewayRes: Response
          try {
            gatewayRes = await fetch(sendUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accountId: input.accountId,
                to: sanitizedPhone,
                text: replyText,
              }),
            })
          } catch (fetchErr: unknown) {
            console.error('[ai/engine] Gateway send failed (fetch error):', fetchErr instanceof Error ? fetchErr.message : fetchErr)
            await db.from('messages').update({ status: 'failed' }).eq('message_id', messageId)
            return null
          }

          if (!gatewayRes.ok) {
            const errData = await gatewayRes.json().catch(() => ({ error: 'Unknown gateway error' }))
            console.error('[ai/engine] Gateway send failed:', errData.error)
            await db.from('messages').update({ status: 'failed' }).eq('message_id', messageId)
            return null
          }

          const resData = await gatewayRes.json().catch(() => null)
          if (resData?.success && resData.messageId && resData.messageId !== messageId) {
            console.log(`[ai/engine] Updating message_id from generated ${messageId} to real ${resData.messageId}`)
            await db
              .from('messages')
              .update({ message_id: resData.messageId })
              .eq('message_id', messageId)
            messageId = resData.messageId
          }
        } else {
          const waAccessToken = decrypt(waConfig.access_token)

          const sendResult = await sendTextMessage({
            phoneNumberId: waConfig.phone_number_id,
            accessToken: waAccessToken,
            to: sanitizedPhone,
            text: replyText,
          })
          messageId = sendResult?.messageId ?? ''

          if (messageId) {
            await db.from('messages').insert({
              conversation_id: input.conversationId,
              sender_type: 'bot',
              content_type: 'text',
              content_text: replyText,
              message_id: messageId,
              status: 'sent',
            })
          }
        }

        if (messageId) {
          await db
            .from('conversations')
            .update({
              last_message_text: replyText,
              last_message_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', input.conversationId)
        }
      }
    }

    // ============ 7. LOG USAGE ============
    if (!isAutoPause && response) {
      const latencyMs = Date.now() - startMs

      await db.from('ai_conversation_logs').insert({
        agent_id: agent.id,
        conversation_id: input.conversationId,
        model_used: response.model,
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        total_cost_usd: totalCost,
        latency_ms: latencyMs,
      })

      console.log(
        `[ai/engine] Agent "${agent.name}" replied in ${latencyMs}ms ` +
        `(${totalPromptTokens}+${totalCompletionTokens} tokens, $${totalCost.toFixed(6)})`,
      )
    } else if (isAutoPause) {
      console.log(`[ai/engine] Bypassed usage logging for auto-paused conversation ${input.conversationId}.`)
    }

    return replyText
  } catch (err) {
    console.error(`[ai/engine] Agent ${agent.id} execution failed:`, err)
    if (isLinkedPhone) {
      void setGatewayPresence(input.accountId, input.contactId, 'paused')
    }
    return null
  }
}

/**
 * Check if the user message matches any auto-pause keywords/phrases.
 * Handles exact word matches for short words, and substring matches for phrases.
 */
export function shouldAutoPause(
  text: string,
  keywords: string[],
): { matches: boolean; matchedKeyword?: string } {
  if (!text) return { matches: false }
  
  const normalized = text.toLowerCase().trim()
  
  // Clean punctuation from start/end for exact matching (e.g. "stop!" -> "stop")
  const cleanExact = normalized.replace(/^[.,\/#!$%\^&\*;:{}=\-_`~()?]+|[.,\/#!$%\^&\*;:{}=\-_`~()?]+$/g, "")

  for (const rawKeyword of keywords) {
    const keyword = rawKeyword.toLowerCase().trim()
    if (!keyword) continue

    // If the keyword is short (5 chars or less, or a single word), check for exact match
    // to avoid false positives (like "I will stop by" matching "stop").
    if (keyword.length <= 5 || !keyword.includes(" ")) {
      if (cleanExact === keyword) {
        return { matches: true, matchedKeyword: rawKeyword }
      }
    } else {
      // For longer phrases, check if the phrase exists as a substring
      if (normalized.includes(keyword)) {
        return { matches: true, matchedKeyword: rawKeyword }
      }
    }
  }

  return { matches: false }
}

/**
 * Transcribe an audio file using Groq Whisper API.
 */
async function transcribeAudioWithGroq(
  audioBuffer: Buffer,
  filename: string,
  mimeType: string,
  apiKey: string
): Promise<string> {
  const formData = new FormData()
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType })
  formData.append('file', blob, filename)
  formData.append('model', 'whisper-large-v3-turbo')

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Groq Whisper failed: ${response.status} - ${errorText}`)
  }

  const result = await response.json()
  return result.text || ''
}

// ============================================================
// Helpers
// ============================================================

/**
 * Search multiple knowledge bases for chunks relevant to the query.
 * Generates an embedding for the user's query and calls the pgvector RPC.
 */
async function searchKnowledgeBases(
  agentId: string,
  query: string,
  openrouterKey: string
): Promise<string | undefined> {
  if (!query.trim()) return undefined

  try {
    const db = supabaseAdmin()

    // 1. Generate vector for the user's query
    const results = await generateEmbeddings([query], openrouterKey)
    if (!results || results.length === 0) return undefined
    
    // pgvector requires strings in "[val,val]" format
    const queryVector = `[${results[0].embedding.join(',')}]`

    // 2. Perform vector similarity search
    const { data: chunks, error } = await db.rpc('match_knowledge_chunks', {
      query_embedding: queryVector,
      match_agent_id: agentId,
      match_count: 5,
      similarity_threshold: 0.65 // Reasonable default for text-embedding-3-small
    })

    if (error) {
      console.error('[ai/engine] Vector search error:', error)
      return undefined
    }

    if (!chunks || chunks.length === 0) return undefined

    // 3. Format results for the LLM
    const formatted = chunks.map(
      (c: { content: string; source_type: string; source_name: string | null; similarity: number }) => {
        const source = c.source_name ? ` (Source: ${c.source_name})` : ''
        // Include source attribution and similarity score (optional but good for debugging)
        return `${c.content}${source}`
      },
    )

    return formatted.join('\n\n---\n\n')
  } catch (err) {
    console.error('[ai/engine] Knowledge base search failed:', err)
    return undefined
  }
}

/**
 * Get a contact's phone number for sending WhatsApp replies.
 */
async function getContactPhone(contactId: string): Promise<string> {
  const db = supabaseAdmin()
  const { data } = await db
    .from('contacts')
    .select('phone')
    .eq('id', contactId)
    .single()

  return data?.phone ?? ''
}

/**
 * Set the presence state (e.g. typing / composing) on the WhatsApp gateway.
 */
async function setGatewayPresence(
  accountId: string,
  contactId: string,
  presence: 'composing' | 'paused'
): Promise<void> {
  try {
    const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL
    if (!gatewayUrl) return

    const presenceUrl = gatewayUrl.endsWith('/api/messages/presence')
      ? gatewayUrl
      : `${gatewayUrl.replace(/\/$/, '')}/api/messages/presence`

    const contactPhone = await getContactPhone(contactId)
    const sanitizedPhone = contactPhone.replace(/\D/g, '')

    await fetch(presenceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        to: sanitizedPhone,
        presence,
      }),
    })
  } catch (err) {
    console.error('[ai/engine] Failed to update gateway presence:', err)
  }
}
