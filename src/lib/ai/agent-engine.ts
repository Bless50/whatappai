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
  ChatMessage,
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
import { sendText } from '@/lib/whatsapp/meta-api'

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

    if (kbLinks && kbLinks.length > 0) {
      const kbIds = kbLinks.map(
        (r: { knowledge_base_id: string }) => r.knowledge_base_id,
      )
      knowledgeContext = await searchKnowledgeBases(kbIds, input.messageText)
    }

    // ============ 4. BUILD PROMPT ============
    const messages = await buildPrompt({
      systemPrompt: agent.system_prompt,
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
    let currentMessages = [...messages]
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
      const waAccessToken = decrypt(waConfig.access_token)

      // Send the message via Meta API
      const sendResult = await sendText({
        phoneNumberId: waConfig.phone_number_id,
        accessToken: waAccessToken,
        to: await getContactPhone(input.contactId),
        text: replyText,
      })

      // Insert the bot's message into the messages table
      if (sendResult?.messages?.[0]?.id) {
        await db.from('messages').insert({
          conversation_id: input.conversationId,
          sender_type: 'bot',
          content_type: 'text',
          content_text: replyText,
          message_id: sendResult.messages[0].id,
          status: 'sent',
        })

        // Update conversation's last message
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
 * Returns a formatted string of the top results.
 *
 * For now, uses simple text search (ILIKE) as a fallback when
 * embeddings are not yet populated. Once the embedding pipeline
 * is complete (Step 11), this will use pgvector cosine similarity.
 */
async function searchKnowledgeBases(
  kbIds: string[],
  query: string,
): Promise<string | undefined> {
  const db = supabaseAdmin()

  // Text search fallback — find chunks containing query keywords.
  // This is a temporary approach until the full RAG pipeline (Step 11)
  // is built with pgvector embeddings.
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5)

  if (keywords.length === 0) return undefined

  // Build an OR query for keyword matching
  const likePattern = keywords.map((k) => `%${k}%`).join('')
  void likePattern // Will be used when we implement proper search

  const { data: chunks, error } = await db
    .from('ai_knowledge_chunks')
    .select('content, source_type, source_name')
    .in('knowledge_base_id', kbIds)
    .or(keywords.map((k) => `content.ilike.%${k}%`).join(','))
    .limit(5)

  if (error || !chunks || chunks.length === 0) return undefined

  const formatted = chunks.map(
    (c: { content: string; source_type: string; source_name: string | null }) => {
      const source = c.source_name ? ` (Source: ${c.source_name})` : ''
      return `${c.content}${source}`
    },
  )

  return formatted.join('\n\n---\n\n')
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
