-- Migration: Add structured prompt fields to ai_agents

ALTER TABLE public.ai_agents
ADD COLUMN IF NOT EXISTS prompt_personality TEXT,
ADD COLUMN IF NOT EXISTS prompt_goal TEXT,
ADD COLUMN IF NOT EXISTS prompt_general_info TEXT;
