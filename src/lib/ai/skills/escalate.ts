/**
 * Escalate skill — hands the conversation over to a human agent.
 *
 * The LLM calls this when it can't handle a request, the customer
 * asks to speak to a human, or the conversation needs specialized
 * attention. This pauses the AI and optionally notifies the team.
 */

import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'

export const escalateSkill: SkillDefinition = {
  type: 'escalate',
  tool: {
    type: 'function',
    function: {
      name: 'escalate',
      description:
        'Hand the conversation over to a human agent. Use this when:\n' +
        '- The customer explicitly asks to speak to a human\n' +
        '- You cannot answer the question and the knowledge base has no answer\n' +
        '- The issue requires human judgment (refunds, complaints, sensitive topics)\n' +
        '- The customer is frustrated or dissatisfied\n' +
        'After escalating, the AI will stop replying until a human hands it back.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              'Brief reason for the escalation, e.g. "Customer requested human agent" ' +
              'or "Unable to process refund request". This is shown to the human agent.',
          },
        },
        required: ['reason'],
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()
    const reason = (params.reason as string) ?? 'Escalated by AI agent'

    try {
      // Look up the agent's takeover mode
      const { data: agent } = await db
        .from('ai_agents')
        .select('takeover_mode, takeover_timeout_minutes')
        .eq('id', context.agentId)
        .maybeSingle()

      // Determine pause behavior based on takeover mode
      let pausedUntil: string | null = null
      if (agent?.takeover_mode === 'timeout') {
        const timeoutMs = (agent.takeover_timeout_minutes ?? 120) * 60 * 1000
        pausedUntil = new Date(Date.now() + timeoutMs).toISOString()
      }
      // 'manual' and 'on_close' → pausedUntil stays null (indefinite)

      // Pause the AI on this conversation
      await db
        .from('conversations')
        .update({
          ai_status: 'paused',
          ai_paused_until: pausedUntil,
          status: 'open', // Ensure it shows in the inbox
          updated_at: new Date().toISOString(),
        })
        .eq('id', context.conversationId)

      // Insert a system-level note so the human agent sees the reason.
      // We use sender_type 'bot' with a prefixed message to make it
      // visible in the inbox conversation thread.
      await db.from('messages').insert({
        conversation_id: context.conversationId,
        sender_type: 'bot',
        content_type: 'text',
        content_text: `⚠️ AI Escalation: ${reason}`,
        status: 'delivered',
      })

      return {
        success: true,
        data:
          'Conversation has been escalated to a human agent. ' +
          'The AI will stop replying until a team member takes over. ' +
          'Let the customer know that a human will assist them shortly.',
      }
    } catch (err) {
      return {
        success: false,
        data: `Escalation failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
