/**
 * Update Contact skill — lets the AI agent update contact details.
 *
 * The LLM calls this when the customer shares new information
 * (email, company name, etc.) during conversation.
 */

import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'

export const updateContactSkill: SkillDefinition = {
  type: 'update_contact',
  tool: {
    type: 'function',
    function: {
      name: 'update_contact',
      description:
        'Update the current contact\'s information in the CRM. Use this when ' +
        'the customer shares their name, email, company, or other details ' +
        'during conversation.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The contact\'s full name.',
          },
          email: {
            type: 'string',
            description: 'The contact\'s email address.',
          },
          company: {
            type: 'string',
            description: 'The contact\'s company or business name.',
          },
        },
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()

    try {
      // Build the update object with only provided fields
      const updates: Record<string, unknown> = {}
      const updatedFields: string[] = []

      if (params.name) {
        updates.name = params.name
        updatedFields.push(`Name → ${params.name}`)
      }
      if (params.email) {
        updates.email = params.email
        updatedFields.push(`Email → ${params.email}`)
      }
      if (params.company) {
        updates.company = params.company
        updatedFields.push(`Company → ${params.company}`)
      }

      if (Object.keys(updates).length === 0) {
        return { success: false, data: 'No fields provided to update.' }
      }

      const { error } = await db
        .from('contacts')
        .update(updates)
        .eq('id', context.contactId)

      if (error) {
        return {
          success: false,
          data: `Failed to update contact: ${error.message}`,
        }
      }

      return {
        success: true,
        data: `Contact updated successfully:\n${updatedFields.join('\n')}`,
      }
    } catch (err) {
      return {
        success: false,
        data: `Contact update failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
