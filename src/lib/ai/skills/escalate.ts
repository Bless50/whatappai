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



      // Notify account owners/admins via the notifications dashboard
      const { data: members } = await db
        .from('profiles')
        .select('user_id')
        .eq('account_id', context.accountId)
        .in('account_role', ['owner', 'admin'])

      if (members && members.length > 0) {
        const notifications = members.map((m) => ({
          account_id: context.accountId,
          user_id: m.user_id,
          type: 'agent_escalation',
          conversation_id: context.conversationId,
          title: 'AI Agent Escalation',
          body: reason,
        }))
        await db.from('notifications').insert(notifications)
      }

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
