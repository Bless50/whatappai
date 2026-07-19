/**
 * Skills registry — maps skill types to their definitions.
 *
 * Each skill provides:
 *   1. An OpenAI-compatible function definition (sent to the LLM)
 *   2. An execute() function (called when the LLM invokes the tool)
 *
 * The engine loads enabled skills for the agent, sends their tool
 * definitions to the model, and calls execute() when the model
 * returns a tool_call.
 */

import type { AISkillType, SkillDefinition } from '../types'

// Import individual skill implementations
import { crmLookupSkill } from './crm-lookup'
import { createDealSkill } from './create-deal'
import { tagContactSkill } from './tag-contact'
import { updateContactSkill } from './update-contact'
import { bookAppointmentSkill } from './book-appointment'
import { escalateSkill } from './escalate'
import { notifyOwnerSkill } from './notify-owner'
import { scheduleFollowupSkill } from './schedule-followup'
import { sendProductSkill } from './send-product'

// ============================================================
// Skill Registry
// ============================================================

const SKILL_REGISTRY: Map<AISkillType, SkillDefinition> = new Map([
  ['crm_lookup', crmLookupSkill],
  ['create_deal', createDealSkill],
  ['tag_contact', tagContactSkill],
  ['update_contact', updateContactSkill],
  ['book_appointment', bookAppointmentSkill],
  ['escalate', escalateSkill],
  ['notify_owner', notifyOwnerSkill],
  ['schedule_followup', scheduleFollowupSkill],
  ['send_product', sendProductSkill],
])

/**
 * Look up a skill definition by type.
 * Returns undefined if the skill type is not registered.
 */
export function getSkillDefinition(
  type: string,
): SkillDefinition | undefined {
  return SKILL_REGISTRY.get(type as AISkillType)
}

/**
 * Get all registered skill definitions.
 * Used by the UI to display available skills when configuring an agent.
 */
export function getAllSkillDefinitions(): SkillDefinition[] {
  return Array.from(SKILL_REGISTRY.values())
}
