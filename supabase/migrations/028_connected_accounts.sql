-- ============================================================
-- 1. CONNECTED ACCOUNTS TABLE
-- Stores OAuth credentials for external integrations (e.g. Google Calendar)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.connected_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    provider TEXT NOT NULL, -- e.g., 'google'
    provider_account_id TEXT NOT NULL, -- Google's user ID or email
    access_token TEXT,
    refresh_token TEXT,
    expires_at TIMESTAMPTZ,
    scopes TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_connected_accounts_account_id ON public.connected_accounts(account_id);

ALTER TABLE public.connected_accounts ENABLE ROW LEVEL SECURITY;

-- Allow read access to members of the account
CREATE POLICY connected_accounts_select ON public.connected_accounts FOR SELECT
    USING (public.is_account_member(account_id));

-- Allow modifications only to members with 'owner' or 'admin' roles
CREATE POLICY connected_accounts_all ON public.connected_accounts FOR ALL
    USING (public.is_account_member(account_id, 'admin') OR public.is_account_member(account_id, 'owner'));

-- updated_at trigger
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.connected_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
