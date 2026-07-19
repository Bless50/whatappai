/**
 * Schedule Follow-up skill — schedules a future action for the AI.
 *
 * The LLM calls this when a customer says "I'll think about it" or
 * when the prompt dictates a drip campaign (e.g., Touch 1 in 3 hours).
 * It calculates the future date based on `delay_hours` and inserts a 
 * record into the `follow_ups` table, which is processed by a Cron Job.
 */

import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'

export const scheduleFollowupSkill: SkillDefinition = {
  type: 'schedule_followup',
  tool: {
    type: 'function',
    function: {
      name: 'schedule_followup',
      description:
        'Schedule a future follow-up message to the customer. Use this when:\n' +
        '- The prompt instructions dictate a follow-up (e.g. Touch 1, Touch 2).\n' +
        '- The customer asks you to remind them later or says they will think about it.\n' +
        '- You are awaiting a response but want to check in proactively if they go silent.\n' +
        'This creates a background task that will wake you up at the specified time.',
      parameters: {
        type: 'object',
        properties: {
          delay_hours: {
            type: 'number',
            description: 'How many hours from now to schedule the follow-up (e.g. 3, 24, 48). Can be decimals like 0.5 for 30 minutes.',
          },
          task_description: {
            type: 'string',
            description: 'What you need to do when you wake up. E.g., "Execute Touch 1: send a soft reservation nudge." or "Ask if they have decided on the shoes."',
          },
        },
        required: ['delay_hours', 'task_description'],
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()
    const delayHours = (params.delay_hours as number) || 24
    const taskDescription = (params.task_description as string) || 'Follow up with customer'

    try {
      const scheduledAt = new Date(Date.now() + delayHours * 60 * 60 * 1000)

      // Get contactId from conversation
      const { data: conv } = await db
        .from('conversations')
        .select('contact_id')
        .eq('id', context.conversationId)
        .single()

      if (!conv?.contact_id) {
        throw new Error('Could not find contact for this conversation.')
      }

      await db.from('follow_ups').insert({
        account_id: context.accountId,
        agent_id: context.agentId,
        conversation_id: context.conversationId,
        contact_id: conv.contact_id,
        task_description: taskDescription,
        scheduled_at: scheduledAt.toISOString(),
        status: 'pending',
      })

      // We also log a quiet message in the chat history for the admin
      await db.from('messages').insert({
        conversation_id: context.conversationId,
        sender_type: 'bot',
        content_type: 'text',
        content_text: `⏱️ AI scheduled a follow-up in ${delayHours} hours: "${taskDescription}"`,
        status: 'delivered',
      })

      return {
        success: true,
        data: `Follow-up successfully scheduled for ${delayHours} hours from now. Note: Do not send the follow-up message right now.`,
      }
    } catch (err) {
      console.error('[skill/schedule-followup] Error:', err)
      return {
        success: false,
        data: `Failed to schedule follow-up: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
