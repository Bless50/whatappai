-- ============================================================
-- 056: Enable search_products skill for existing AI agents
-- ============================================================

DO $$
DECLARE
  v_agent record;
BEGIN
  -- First, update the check constraint to allow 'search_products'
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
      'notify_owner',
      'schedule_followup',
      'send_product',
      'search_products'
    ));

  -- Next, insert the new skill for all existing agents
  FOR v_agent IN SELECT id FROM ai_agents LOOP
    INSERT INTO ai_agent_skills (agent_id, skill_type, is_enabled, skill_config)
    VALUES (v_agent.id, 'search_products', true, '{}'::jsonb)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
