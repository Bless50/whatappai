/**
 * AI Agent dispatcher — routes inbound messages to the right agent.
 *
 * Called by the webhook after Flows and Automations have had their
 * chance. The dispatch logic:
 *
 *   1. Check if the conversation already has an assigned AI agent
 *   2. If not, find an active agent for this channel on this account
 *   3. Check the conversation's ai_status (active/paused/disabled)
 *   4. If paused, check if the timeout has expired → maybe resume
 *   5. If active → execute the agent engine
 *
 * The dispatcher is the single entry point for the webhook. It
 * handles all the routing and status checks; the engine handles
 * the actual LLM call and reply.
 */

import type {
  AIAgent,
  AIAgentChannel,
  AIDispatchInput,
  AIDispatchResult,
} from './types'
import { executeAgent } from './agent-engine'
import { supabaseAdmin } from './admin-client'

// ============================================================
// Public API
// ============================================================

/**
 * Dispatch an inbound message to the appropriate AI agent.
 *
 * Must never throw — the webhook calls this fire-and-forget.
 */
export async function dispatchToAIAgent(
  input: AIDispatchInput,
): Promise<AIDispatchResult> {
  try {
    const db = supabaseAdmin()
    const channel: AIAgentChannel = input.channel ?? 'whatsapp'

    // ============ 1. CHECK CONVERSATION AI STATUS ============
    const { data: conversation, error: convError } = await db
      .from('conversations')
      .select('ai_status, ai_paused_until, ai_agent_id')
      .eq('id', input.conversationId)
      .single()

    if (convError || !conversation) {
      console.error('[ai/dispatcher] Failed to fetch conversation:', convError)
      return { handled: false, reason: 'error' }
    }

    // AI explicitly disabled for this conversation
    if (conversation.ai_status === 'disabled') {
      return { handled: false, reason: 'ai_disabled' }
    }

    // AI paused — check if timeout has expired
    if (conversation.ai_status === 'paused') {
      if (conversation.ai_paused_until) {
        const pausedUntil = new Date(conversation.ai_paused_until)
        if (pausedUntil > new Date()) {
          // Still within the pause window
          return { handled: false, reason: 'ai_paused' }
        }
        // Timeout expired — resume AI
        await db
          .from('conversations')
          .update({
            ai_status: 'active',
            ai_paused_until: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.conversationId)
      } else {
        // Paused with no timeout (manual takeover mode) — stay paused
        return { handled: false, reason: 'ai_paused' }
      }
    }

    // ============ 2. FIND THE AGENT ============
    let agent: AIAgent | null = null

    // First, check if the conversation already has an assigned agent
    if (conversation.ai_agent_id) {
      const { data: assignedAgent } = await db
        .from('ai_agents')
        .select('*')
        .eq('id', conversation.ai_agent_id)
        .eq('is_active', true)
        .maybeSingle()

      if (assignedAgent) {
        agent = assignedAgent as AIAgent
      }
    }

    // If no assigned agent, find the first active agent for this channel
    if (!agent) {
      const { data: agents, error: agentError } = await db
        .from('ai_agents')
        .select('*')
        .eq('account_id', input.accountId)
        .eq('is_active', true)
        .contains('channels', [channel])
        .order('created_at', { ascending: true })
        .limit(1)

      if (agentError) {
        console.error('[ai/dispatcher] Failed to find agents:', agentError)
        return { handled: false, reason: 'error' }
      }

      if (!agents || agents.length === 0) {
        return { handled: false, reason: 'no_agent' }
      }

      agent = agents[0] as AIAgent

      // Assign this agent to the conversation for future messages
      await db
        .from('conversations')
        .update({
          ai_agent_id: agent.id,
          ai_status: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('id', input.conversationId)
    }

    // ============ 3. CHECK API KEY ============
    const apiKey = agent.openrouter_api_key ?? agent.openrouter_key
    if (!apiKey) {
      console.warn(
        `[ai/dispatcher] Agent "${agent.name}" (${agent.id}) has no API key`,
      )
      return { handled: false, agentId: agent.id, reason: 'no_api_key' }
    }

    // ============ 4. EXECUTE ============
    const reply = await executeAgent(agent, input)

    return {
      handled: reply !== null,
      agentId: agent.id,
      reason: reply === null ? 'error' : undefined,
    }
  } catch (err) {
    console.error('[ai/dispatcher] Unhandled error:', err)
    return { handled: false, reason: 'error' }
  }
}

// ============================================================
// Takeover Controls (called by the inbox UI)
// ============================================================

/**
 * Pause AI for a conversation (human takes over).
 *
 * Called when an agent clicks "Take Over" in the inbox. The behavior
 * depends on the agent's takeover_mode:
 *   - 'timeout': Sets ai_paused_until to now + timeout minutes
 *   - 'manual': Sets ai_paused_until to null (stays paused until handback)
 *   - 'on_close': Same as manual, but the AI resumes when the
 *     conversation status changes to 'closed' (handled separately)
 */
export async function pauseAI(
  conversationId: string,
  agentId?: string,
): Promise<void> {
  const db = supabaseAdmin()

  let pausedUntil: string | null = null

  // Look up the agent's takeover mode to determine behavior
  if (agentId) {
    const { data: agent } = await db
      .from('ai_agents')
      .select('takeover_mode, takeover_timeout_minutes')
      .eq('id', agentId)
      .maybeSingle()

    if (agent?.takeover_mode === 'timeout') {
      const timeoutMs = (agent.takeover_timeout_minutes ?? 120) * 60 * 1000
      pausedUntil = new Date(Date.now() + timeoutMs).toISOString()
    }
    // 'manual' and 'on_close' → pausedUntil stays null
  }

  await db
    .from('conversations')
    .update({
      ai_status: 'paused',
      ai_paused_until: pausedUntil,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
}

/**
 * Resume AI for a conversation (hand back from human).
 *
 * Called when an agent clicks "Hand Back to AI" in the inbox.
 */
export async function resumeAI(conversationId: string): Promise<void> {
  const db = supabaseAdmin()

  await db
    .from('conversations')
    .update({
      ai_status: 'active',
      ai_paused_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
}
