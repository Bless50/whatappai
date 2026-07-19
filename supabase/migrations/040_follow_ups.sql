-- ============================================================
-- 040: Follow-ups Table for AI Drip Campaigns
-- ============================================================
CREATE TABLE IF NOT EXISTS follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  task_description TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_pending 
  ON follow_ups(scheduled_at) 
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_follow_ups_account 
  ON follow_ups(account_id);

ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;

-- Allow system (service role) full access
-- For clients, they can view/manage their account's follow-ups
DROP POLICY IF EXISTS follow_ups_select ON follow_ups;
CREATE POLICY follow_ups_select ON follow_ups FOR SELECT
  USING (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS follow_ups_insert ON follow_ups;
CREATE POLICY follow_ups_insert ON follow_ups FOR INSERT
  WITH CHECK (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS follow_ups_update ON follow_ups;
CREATE POLICY follow_ups_update ON follow_ups FOR UPDATE
  USING (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS follow_ups_delete ON follow_ups;
CREATE POLICY follow_ups_delete ON follow_ups FOR DELETE
  USING (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );
