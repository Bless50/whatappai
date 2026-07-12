-- ============================================================
-- 037: Add response_delay_seconds to public.ai_agents
--
-- This migration adds a column response_delay_seconds to the
-- ai_agents table to configure a human-like delay before
-- sending the AI response.
-- ============================================================

ALTER TABLE public.ai_agents
  ADD COLUMN IF NOT EXISTS response_delay_seconds INTEGER NOT NULL DEFAULT 0;
