/**
 * Create Deal skill — lets the AI agent create a deal in the sales pipeline.
 *
 * The LLM calls this when it identifies a qualified lead or the
 * customer expresses interest in a product/service.
 */

import type { SkillDefinition, SkillContext, SkillResult } from '../types'
import { supabaseAdmin } from '../admin-client'

export const createDealSkill: SkillDefinition = {
  type: 'create_deal',
  tool: {
    type: 'function',
    function: {
      name: 'create_deal',
      description:
        'Create a new deal in the sales pipeline. Use this when a customer ' +
        'shows clear interest in a product or service, or when you identify ' +
        'a qualified lead. The deal will appear in the CRM pipeline.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short title for the deal, e.g. "Website redesign for John"',
          },
          value: {
            type: 'number',
            description: 'Estimated deal value in the account\'s default currency. Use 0 if unknown.',
          },
          notes: {
            type: 'string',
            description: 'Context about the deal — what the customer needs, discussed pricing, etc.',
          },
        },
        required: ['title'],
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const db = supabaseAdmin()
    const title = params.title as string
    const value = (params.value as number) ?? 0
    const notes = (params.notes as string) ?? ''

    try {
      // Find the first pipeline and its first stage for this account.
      // The agent doesn't need to know pipeline details — it just
      // creates the deal in the default pipeline's first stage.
      const { data: pipelines } = await db
        .from('pipelines')
        .select('id, pipeline_stages(id, name, position)')
        .eq('account_id', context.accountId)
        .order('created_at', { ascending: true })
        .limit(1)

      if (!pipelines || pipelines.length === 0) {
        return {
          success: false,
          data: 'No sales pipeline found. Please set up a pipeline in the CRM first.',
        }
      }

      const pipeline = pipelines[0]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stages = (pipeline as any).pipeline_stages as Array<{
        id: string
        name: string
        position: number
      }>

      if (!stages || stages.length === 0) {
        return {
          success: false,
          data: 'Pipeline has no stages configured.',
        }
      }

      // Sort stages by position and use the first one
      const firstStage = stages.sort((a, b) => a.position - b.position)[0]

      // Look up the user_id for this account (needed for the FK)
      const { data: account } = await db
        .from('accounts')
        .select('owner_user_id')
        .eq('id', context.accountId)
        .single()

      if (!account) {
        return { success: false, data: 'Account not found.' }
      }

      const { data: deal, error } = await db
        .from('deals')
        .insert({
          user_id: account.owner_user_id,
          account_id: context.accountId,
          pipeline_id: pipeline.id,
          stage_id: firstStage.id,
          contact_id: context.contactId,
          conversation_id: context.conversationId,
          title,
          value,
          notes,
          status: 'open',
        })
        .select('id, title, value')
        .single()

      if (error) {
        return {
          success: false,
          data: `Failed to create deal: ${error.message}`,
        }
      }

      return {
        success: true,
        data:
          `Deal created successfully!\n` +
          `Title: ${deal.title}\n` +
          `Value: ${deal.value}\n` +
          `Stage: ${firstStage.name}\n` +
          `The deal has been added to the sales pipeline.`,
        metadata: { deal_id: deal.id },
      }
    } catch (err) {
      return {
        success: false,
        data: `Failed to create deal: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
}
