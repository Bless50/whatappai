-- ============================================================
-- 056: Enable search_products skill for existing AI agents
-- ============================================================

DO $$
DECLARE
  v_agent record;
BEGIN
  FOR v_agent IN SELECT id FROM ai_agents LOOP
    INSERT INTO ai_agent_skills (agent_id, skill_type, is_enabled, skill_config)
    VALUES (v_agent.id, 'search_products', true, '{}'::jsonb)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
