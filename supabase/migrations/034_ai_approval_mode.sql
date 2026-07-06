-- ============================================================
-- Migration: 034_ai_approval_mode.sql
-- Add Human Approval Mode, AI feedback fields, allow pending_approval status, and add metadata.
-- ============================================================

-- 1. Add approval_mode to ai_agents table
ALTER TABLE public.ai_agents
ADD COLUMN IF NOT EXISTS approval_mode BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Add feedback/rating fields to messages table
ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS ai_feedback_rating TEXT CHECK (ai_feedback_rating IN ('good', 'bad')),
ADD COLUMN IF NOT EXISTS ai_feedback_text TEXT,
ADD COLUMN IF NOT EXISTS ai_corrected_text TEXT;

-- 3. Modify check constraint for messages status
ALTER TABLE public.messages
DROP CONSTRAINT IF EXISTS messages_status_check;

ALTER TABLE public.messages
ADD CONSTRAINT messages_status_check
CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed', 'pending_approval'));

-- 4. Add JSONB metadata to conversations and messages
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
