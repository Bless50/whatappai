/**
 * CRM Lookup skill — lets the AI agent search contacts, view
 * conversation history, and check deal status.
 *
 * The LLM calls this when the customer asks about their account,
 * order status, previous conversations, etc.
 */

import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'

export const crmLookupSkill: SkillDefinition = {
  type: 'crm_lookup',
  tool: {
    type: 'function',
    function: {
      name: 'crm_lookup',
      description:
        'Look up information in the CRM. Can search for contact details, ' +
        'view recent conversation messages, or check deal/pipeline status. ' +
        'Use this when the customer asks about their account, order status, ' +
        'or previous interactions.',
      parameters: {
        type: 'object',
        properties: {
          lookup_type: {
            type: 'string',
            enum: ['contact_info', 'conversation_history', 'deals'],
            description:
              'What to look up: "contact_info" for the current contact\'s profile, ' +
              '"conversation_history" for recent messages, "deals" for active deals.',
          },
          query: {
            type: 'string',
            description:
              'Optional search query. For contact_info, searches by name/phone/email. ' +
              'For conversation_history, returns recent messages. For deals, filters by title.',
          },
        },
        required: ['lookup_type'],
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()
    const lookupType = params.lookup_type as string

    try {
      switch (lookupType) {
        case 'contact_info': {
          const { data: contact } = await db
            .from('contacts')
            .select('name, phone, email, company, created_at')
            .eq('id', context.contactId)
            .single()

          if (!contact) {
            return { success: true, data: 'No contact information found.' }
          }

          const info = [
            contact.name && `Name: ${contact.name}`,
            contact.phone && `Phone: ${contact.phone}`,
            contact.email && `Email: ${contact.email}`,
            contact.company && `Company: ${contact.company}`,
            `Customer since: ${new Date(contact.created_at).toLocaleDateString()}`,
          ]
            .filter(Boolean)
            .join('\n')

          return { success: true, data: info }
        }

        case 'conversation_history': {
          const { data: messages } = await db
            .from('messages')
            .select('sender_type, content_text, content_type, created_at')
            .eq('conversation_id', context.conversationId)
            .order('created_at', { ascending: false })
            .limit(10)

          if (!messages || messages.length === 0) {
            return { success: true, data: 'No previous messages found.' }
          }

          const history = messages
            .reverse()
            .map((m: Record<string, unknown>) => {
              const sender = m.sender_type === 'customer' ? 'Customer' : 'Agent'
              const text = m.content_text || `[${m.content_type}]`
              return `${sender}: ${text}`
            })
            .join('\n')

          return { success: true, data: `Recent messages:\n${history}` }
        }

        case 'deals': {
          const { data: deals } = await db
            .from('deals')
            .select('title, value, currency, status, pipeline_stages(name)')
            .eq('contact_id', context.contactId)
            .order('created_at', { ascending: false })
            .limit(5)

          if (!deals || deals.length === 0) {
            return { success: true, data: 'No deals found for this contact.' }
          }

          const dealList = deals
            .map((d: Record<string, unknown>) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const stage = (d as any).pipeline_stages?.name ?? 'Unknown'
              return `- ${d.title}: ${d.currency ?? 'USD'} ${d.value} (${d.status}, Stage: ${stage})`
            })
            .join('\n')

          return { success: true, data: `Active deals:\n${dealList}` }
        }

        default:
          return { success: false, data: `Unknown lookup type: ${lookupType}` }
      }
    } catch (err) {
      return {
        success: false,
        data: `CRM lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
