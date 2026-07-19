-- ============================================================
-- 039: AI Notifications Table & Realtime
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Recipient — the agent this notification is for.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'conversation_assigned'
    CHECK (type IN ('conversation_assigned', 'agent_escalation', 'notify_owner')),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Who triggered the notification. NULL means an automation / the
  -- system did it rather than a signed-in teammate.
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id)
  WHERE read_at IS NULL;

-- Full replica identity so realtime UPDATE payloads include old column
-- values. Without this, payload.old only carries the primary key, which
-- makes it impossible to derive whether a row was unread before the update.
ALTER TABLE notifications REPLICA IDENTITY FULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Recipients can read and mark their own notifications as read.
-- No client INSERT/DELETE policy — rows are created exclusively by
-- the server (AI agent) or triggers.
DROP POLICY IF EXISTS notifications_select ON notifications;
DROP POLICY IF EXISTS notifications_update ON notifications;
CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (auth.uid() = user_id);
-- Only read_at updates are meaningful from the client; restrict via a
-- column-level security policy so other fields cannot be rewritten.
CREATE POLICY notifications_update ON notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Restrict to read_at column only at the column-privilege level so
-- clients cannot overwrite title, body, or other immutable fields.
REVOKE UPDATE ON notifications FROM authenticated;
GRANT UPDATE (read_at) ON notifications TO authenticated;

-- ============================================================
-- ENABLE REALTIME
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
END $$;
