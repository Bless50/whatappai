-- Add vision_prompt column to ai_agents table
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS vision_prompt TEXT;
