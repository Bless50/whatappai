/**
 * Tag Contact skill — lets the AI agent add or remove tags on contacts.
 *
 * The LLM calls this to categorize leads, mark interests, or flag
 * contacts for follow-up (e.g., "interested", "VIP", "needs callback").
 */

import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'

export const tagContactSkill: SkillDefinition = {
  type: 'tag_contact',
  tool: {
    type: 'function',
    function: {
      name: 'tag_contact',
      description:
        'Add or remove a tag on the current contact. Use this to categorize ' +
        'leads (e.g., "interested", "VIP", "needs-callback", "hot-lead"). ' +
        'Tags help the sales team prioritize follow-ups.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'remove'],
            description: 'Whether to add or remove the tag.',
          },
          tag_name: {
            type: 'string',
            description:
              'The tag name. If adding and the tag doesn\'t exist, it will be created.',
          },
        },
        required: ['action', 'tag_name'],
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()
    const action = params.action as string
    const tagName = params.tag_name as string

    try {
      // Look up the account owner for user_id FK
      const { data: account } = await db
        .from('accounts')
        .select('owner_user_id')
        .eq('id', context.accountId)
        .single()

      if (!account) {
        return { success: false, data: 'Account not found.' }
      }

      if (action === 'add') {
        // Find or create the tag
        let tagId: string

        const { data: existingTag } = await db
          .from('tags')
          .select('id')
          .eq('account_id', context.accountId)
          .ilike('name', tagName)
          .maybeSingle()

        if (existingTag) {
          tagId = existingTag.id
        } else {
          // Create the tag
          const { data: newTag, error: createErr } = await db
            .from('tags')
            .insert({
              user_id: account.owner_user_id,
              account_id: context.accountId,
              name: tagName,
              color: '#3b82f6', // Default blue
            })
            .select('id')
            .single()

          if (createErr || !newTag) {
            return {
              success: false,
              data: `Failed to create tag: ${createErr?.message ?? 'Unknown error'}`,
            }
          }
          tagId = newTag.id
        }

        // Add the tag to the contact (upsert to avoid duplicates)
        const { error: linkErr } = await db
          .from('contact_tags')
          .upsert(
            { contact_id: context.contactId, tag_id: tagId },
            { onConflict: 'contact_id,tag_id' },
          )

        if (linkErr) {
          return {
            success: false,
            data: `Failed to add tag: ${linkErr.message}`,
          }
        }

        return {
          success: true,
          data: `Tag "${tagName}" added to contact successfully.`,
        }
      } else if (action === 'remove') {
        // Find the tag
        const { data: tag } = await db
          .from('tags')
          .select('id')
          .eq('account_id', context.accountId)
          .ilike('name', tagName)
          .maybeSingle()

        if (!tag) {
          return { success: true, data: `Tag "${tagName}" not found — nothing to remove.` }
        }

        await db
          .from('contact_tags')
          .delete()
          .eq('contact_id', context.contactId)
          .eq('tag_id', tag.id)

        return {
          success: true,
          data: `Tag "${tagName}" removed from contact.`,
        }
      }

      return { success: false, data: `Unknown action: ${action}` }
    } catch (err) {
      return {
        success: false,
        data: `Tag operation failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
