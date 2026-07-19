-- Migration to add 'tiktok' to the channels check constraint on conversations and messages.

-- 1. Drop existing constraints if they exist
DO $$
DECLARE
    constraint_name_conv TEXT;
    constraint_name_msg TEXT;
BEGIN
    -- Find and drop constraint for conversations
    SELECT conname INTO constraint_name_conv
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' 
      AND rel.relname = 'conversations' 
      AND con.contype = 'c' 
      AND pg_get_constraintdef(con.oid) LIKE '%channel%';

    IF constraint_name_conv IS NOT NULL THEN
        EXECUTE 'ALTER TABLE public.conversations DROP CONSTRAINT ' || quote_ident(constraint_name_conv);
    END IF;

    -- Find and drop constraint for messages
    SELECT conname INTO constraint_name_msg
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' 
      AND rel.relname = 'messages' 
      AND con.contype = 'c' 
      AND pg_get_constraintdef(con.oid) LIKE '%channel%';

    IF constraint_name_msg IS NOT NULL THEN
        EXECUTE 'ALTER TABLE public.messages DROP CONSTRAINT ' || quote_ident(constraint_name_msg);
    END IF;
END $$;

-- 2. Add new constraints containing 'tiktok'
ALTER TABLE public.conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('whatsapp', 'facebook', 'instagram', 'tiktok'));
ALTER TABLE public.messages ADD CONSTRAINT messages_channel_check CHECK (channel IN ('whatsapp', 'facebook', 'instagram', 'tiktok'));
