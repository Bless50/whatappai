-- ============================================================
-- 038_add_agent_auto_pause.sql — Add Auto-Pause Configurations to AI Agents
--
-- Enables system-level auto-pausing when incoming user messages match 
-- defined keywords/phrases (e.g., "stop", "talk to human", etc.).
-- ============================================================

DO $$
BEGIN
    -- Add auto_pause_enabled column if not exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'ai_agents' 
          AND column_name = 'auto_pause_enabled'
    ) THEN
        ALTER TABLE public.ai_agents ADD COLUMN auto_pause_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;

    -- Add auto_pause_keywords column if not exists
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'ai_agents' 
          AND column_name = 'auto_pause_keywords'
    ) THEN
        ALTER TABLE public.ai_agents ADD COLUMN auto_pause_keywords TEXT[] NOT NULL DEFAULT '{stop,unsubscribe,pause,human,"talk to a human","talk to a real person","speak to a human","speak to a real person","pass me on to a boss","chat with a human","talk to human","human agent","real person","speak to human","talk to person","talk to a person","stop bot","pause bot","stop the bot","pause the bot"}';
    END IF;
END $$;
