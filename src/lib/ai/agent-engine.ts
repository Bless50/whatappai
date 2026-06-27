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
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import { generateEmbeddings } from './embedding-client'

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

  try {
    // ============ 1. DECRYPT API KEY ============
    const apiKey = agent.openrouter_api_key ?? agent.openrouter_key
    if (!apiKey) {
      console.warn(`[ai/engine] Agent ${agent.id} has no API key configured`)
      return null
    }
    const decryptedKey = decrypt(apiKey)

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
    })

    // ============ 5. CALL LLM (with tool-use loop) ============
    const modelConfig: ModelConfig = {
      model: agent.model_name,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      apiKey: decryptedKey,
    }

    let response: ModelResponse | null = null
    const currentMessages = [...messages]
    let totalPromptTokens = 0
    let totalCompletionTokens = 0
    let totalCost = 0

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
      return null
    }

    // ============ 6. SEND REPLY VIA WHATSAPP ============
    const replyText = response.content

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

        // Generate a messageId FIRST so we can insert it into the database immediately.
        // This completely eliminates the race condition where the WhatsApp echo
        // arrives at the webhook before the HTTP request returns.
        messageId = `3EB0${crypto.randomUUID().replace(/-/g, '').substring(0, 18).toUpperCase()}`

        // Insert the AI's reply into the DB BEFORE sending it!
        await db.from('messages').insert({
          conversation_id: input.conversationId,
          sender_type: 'bot',
          content_type: 'text',
          content_text: replyText,
          message_id: messageId,
          status: 'sent',
          channel: 'whatsapp',
        })

        const gatewayRes = await fetch(sendUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: input.accountId,
            to: sanitizedPhone,
            text: replyText,
            messageId: messageId,
          }),
        })

        if (!gatewayRes.ok) {
          const errData = await gatewayRes.json().catch(() => ({ error: 'Unknown gateway error' }))
          console.error('[ai/engine] Gateway send failed:', errData.error)
          
          // Update the message to failed
          await db.from('messages').update({ status: 'failed' }).eq('message_id', messageId)
          return null
        }

        // ============ UPDATE REAL MESSAGE ID FROM GATEWAY ============
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

        // Send the message via Meta API
        const sendResult = await sendTextMessage({
          phoneNumberId: waConfig.phone_number_id,
          accessToken: waAccessToken,
          to: sanitizedPhone,
          text: replyText,
        })
        messageId = sendResult?.messageId ?? ''

        // Insert the bot's message into the messages table (only for Meta API, since linked-phone inserts before sending)
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

      // Update conversation's last message
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

    // ============ 7. LOG USAGE ============
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

    return replyText
  } catch (err) {
    console.error(`[ai/engine] Agent ${agent.id} execution failed:`, err)
    return null
  }
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
