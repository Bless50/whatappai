-- ============================================================
-- 055_add_products.sql — Create products table and policies
-- ============================================================

CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  image_url TEXT,
  sku TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for searching products
CREATE INDEX IF NOT EXISTS idx_products_account_name ON public.products(account_id, name);

-- RLS policies
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON public.products;
DROP POLICY IF EXISTS products_insert ON public.products;
DROP POLICY IF EXISTS products_update ON public.products;
DROP POLICY IF EXISTS products_delete ON public.products;

CREATE POLICY products_select ON public.products FOR SELECT
    USING (public.is_account_member(account_id));
CREATE POLICY products_insert ON public.products FOR INSERT
    WITH CHECK (public.is_account_member(account_id, 'agent'));
CREATE POLICY products_update ON public.products FOR UPDATE
    USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY products_delete ON public.products FOR DELETE
    USING (public.is_account_member(account_id, 'admin'));

-- trigger for updated_at
DROP TRIGGER IF EXISTS set_updated_at ON public.products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Update skills CHECK constraint to include schedule_followup and send_product
ALTER TABLE public.ai_agent_skills
  DROP CONSTRAINT IF EXISTS ai_agent_skills_skill_type_check;

ALTER TABLE public.ai_agent_skills
  ADD CONSTRAINT ai_agent_skills_skill_type_check
  CHECK (skill_type IN (
    'crm_lookup',
    'create_deal',
    'tag_contact',
    'book_appointment',
    'escalate',
    'update_contact',
    'notify_owner',
    'schedule_followup',
    'send_product'
  ));
