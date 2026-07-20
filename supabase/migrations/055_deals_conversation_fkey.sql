-- ============================================================
-- Fix deals.conversation_id foreign key constraint
-- It was preventing conversation deletion when clearing chats.
-- ============================================================

DO $$
BEGIN
  -- Drop the existing constraint that prevents deletion
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deals_conversation_id_fkey'
  ) THEN
    ALTER TABLE deals DROP CONSTRAINT deals_conversation_id_fkey;
  END IF;

  -- Re-add it with ON DELETE SET NULL
  ALTER TABLE deals
    ADD CONSTRAINT deals_conversation_id_fkey
    FOREIGN KEY (conversation_id)
    REFERENCES conversations(id)
    ON DELETE SET NULL;
END $$;
