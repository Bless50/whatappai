-- ============================================================
-- 036: Add notify_owner to the ai_agent_skills.skill_type CHECK
--
-- This migration extends the existing CHECK constraint on the
-- skill_type column to include the new 'notify_owner' skill,
-- which allows the AI agent to send collected customer info
-- to the business owner's WhatsApp number.
-- ============================================================

-- Drop the existing CHECK constraint and re-create it with
-- the additional value. Postgres doesn't support ALTER CHECK
-- directly, so we drop and re-add.
ALTER TABLE public.ai_agent_skills
  DROP CONSTRAINT IF EXISTS ai_agent_skills_skill_type_check;

ALTER TABLE public.ai_agent_skills
  ADD CONSTRAINT ai_agent_skills_skill_type_check
  CHECK (skill_type IN (
    'crm_lookup',
    'create_deal',
    'tag_contact',
    'book_appointment',
    'escalate',
    'update_contact',
    'notify_owner'
  ));
