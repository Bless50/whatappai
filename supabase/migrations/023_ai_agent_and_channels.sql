-- Migration to add AI Agent configuration and omnichannel/takeover columns to conversations and messages.

-- Create ai_agents table
CREATE TABLE IF NOT EXISTS public.ai_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    system_prompt TEXT NOT NULL DEFAULT '',
    openrouter_key TEXT, -- Encrypted OpenRouter key
    model_name TEXT NOT NULL DEFAULT 'deepseek/deepseek-chat',
    booking_link TEXT,
    takeover_timeout_minutes INTEGER NOT NULL DEFAULT 120,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row-Level Security on ai_agents
ALTER TABLE public.ai_agents ENABLE ROW LEVEL SECURITY;

-- Create RLS Policies for ai_agents
CREATE POLICY "Users can view ai_agents for their accounts" ON public.ai_agents
    FOR SELECT
    USING (public.is_account_member(account_id));

CREATE POLICY "Users can insert ai_agents for their accounts" ON public.ai_agents
    FOR INSERT
    WITH CHECK (public.is_account_member(account_id));

CREATE POLICY "Users can update ai_agents for their accounts" ON public.ai_agents
    FOR UPDATE
    USING (public.is_account_member(account_id))
    WITH CHECK (public.is_account_member(account_id));

CREATE POLICY "Users can delete ai_agents for their accounts" ON public.ai_agents
    FOR DELETE
    USING (public.is_account_member(account_id));

-- Add channel check constraint to conversations if not present, and AI takeover status fields
DO $$
BEGIN
    -- Add ai_status column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'ai_status') THEN
        ALTER TABLE public.conversations ADD COLUMN ai_status TEXT NOT NULL DEFAULT 'active' CHECK (ai_status IN ('active', 'paused', 'disabled'));
    END IF;

    -- Add ai_paused_until column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'ai_paused_until') THEN
        ALTER TABLE public.conversations ADD COLUMN ai_paused_until TIMESTAMPTZ;
    END IF;

    -- Add channel column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'channel') THEN
        ALTER TABLE public.conversations ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'facebook', 'instagram'));
    END IF;
END $$;

-- Add channel to messages
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'channel') THEN
        ALTER TABLE public.messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'facebook', 'instagram'));
    END IF;
END $$;

-- Trigger to update updated_at on ai_agents
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER set_ai_agents_updated_at
    BEFORE UPDATE ON public.ai_agents
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();
