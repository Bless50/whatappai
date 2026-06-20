-- ============================================================
-- 024_ai_agents_v2.sql — Multi-agent AI system (v2)
--
-- Restructures the existing ai_agents table (created in 023) for
-- multi-agent support and creates the full AI agent ecosystem:
--   - Knowledge bases + vector chunks (RAG)
--   - Agent skills (CRM actions)
--   - Calendars + appointments
--   - Conversation-level AI logs (cost tracking)
--
-- Design decisions:
--   - ai_agents drops its UNIQUE(account_id) constraint so one
--     account can have multiple specialised agents.
--   - Knowledge bases are account-scoped, then linked to agents
--     via a junction table (many-to-many). This lets the same KB
--     be shared across agents.
--   - Skills are per-agent and UNIQUE(agent_id, skill_type) so
--     each agent can only have one config per skill type.
--   - Calendars are account-scoped; appointments reference a
--     calendar, contact, agent, and conversation for full audit.
--   - ai_conversation_logs tracks per-message LLM usage for
--     cost dashboards and rate-limit enforcement.
--
-- Idempotent — safe to run multiple times. Uses IF NOT EXISTS
-- for tables/indexes, DO $$ blocks for conditional column adds,
-- and DROP POLICY IF EXISTS before CREATE POLICY (Postgres has
-- no CREATE POLICY IF NOT EXISTS).
-- ============================================================

-- ============================================================
-- 1. ENABLE PGVECTOR EXTENSION
-- Required for embedding storage and similarity search on
-- ai_knowledge_chunks.embedding column.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- 2. ALTER ai_agents — MULTI-AGENT SUPPORT
--
-- Migration 023 created ai_agents with UNIQUE(account_id),
-- limiting each account to a single agent. We drop that
-- constraint and add columns for agent identity, model tuning,
-- channel routing, and takeover behaviour.
-- ============================================================

-- Drop the one-agent-per-account constraint
ALTER TABLE public.ai_agents DROP CONSTRAINT IF EXISTS ai_agents_account_id_key;

-- Add new columns (each guarded by IF NOT EXISTS)
DO $$
BEGIN
    -- Agent display name
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_agents' AND column_name = 'name') THEN
        ALTER TABLE public.ai_agents ADD COLUMN name TEXT NOT NULL DEFAULT 'AI Assistant';
    END IF;

    -- Agent description / purpose
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_agents' AND column_name = 'description') THEN
        ALTER TABLE public.ai_agents ADD COLUMN description TEXT;
    END IF;

    -- Agent avatar for chat UI
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_agents' AND column_name = 'avatar_url') THEN
        ALTER TABLE public.ai_agents ADD COLUMN avatar_url TEXT;
    END IF;

    -- LLM temperature (0.00–1.00 range enforced by NUMERIC(3,2))
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_agents' AND column_name = 'temperature') THEN
        ALTER TABLE public.ai_agents ADD COLUMN temperature NUMERIC(3,2) NOT NULL DEFAULT 0.70;
    END IF;

    -- Max tokens per completion
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_agents' AND column_name = 'max_tokens') THEN
        ALTER TABLE public.ai_agents ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 1024;
    END IF;

    -- Which messaging channels this agent handles
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_agents' AND column_name = 'channels') THEN
        ALTER TABLE public.ai_agents ADD COLUMN channels TEXT[] NOT NULL DEFAULT '{whatsapp}';
    END IF;

    -- How human takeover is triggered
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_agents' AND column_name = 'takeover_mode') THEN
        ALTER TABLE public.ai_agents ADD COLUMN takeover_mode TEXT NOT NULL DEFAULT 'timeout'
            CHECK (takeover_mode IN ('timeout', 'manual', 'on_close'));
    END IF;

    -- LLM provider (future-proofing for direct OpenAI, Anthropic, etc.)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_agents' AND column_name = 'provider') THEN
        ALTER TABLE public.ai_agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'openrouter';
    END IF;
END $$;

-- Index for the now non-unique account_id (list agents per account)
CREATE INDEX IF NOT EXISTS idx_ai_agents_account ON public.ai_agents(account_id);

-- ============================================================
-- 3. AI_KNOWLEDGE_BASES — Account-scoped knowledge containers
--
-- Each knowledge base groups related chunks (FAQ docs, PDFs,
-- web scrapes). Linked to agents via the junction table below.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_knowledge_bases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_bases_account ON public.ai_knowledge_bases(account_id);

ALTER TABLE public.ai_knowledge_bases ENABLE ROW LEVEL SECURITY;

-- RLS: full CRUD for account members
DROP POLICY IF EXISTS ai_knowledge_bases_select ON public.ai_knowledge_bases;
DROP POLICY IF EXISTS ai_knowledge_bases_insert ON public.ai_knowledge_bases;
DROP POLICY IF EXISTS ai_knowledge_bases_update ON public.ai_knowledge_bases;
DROP POLICY IF EXISTS ai_knowledge_bases_delete ON public.ai_knowledge_bases;

CREATE POLICY ai_knowledge_bases_select ON public.ai_knowledge_bases FOR SELECT
    USING (public.is_account_member(account_id));
CREATE POLICY ai_knowledge_bases_insert ON public.ai_knowledge_bases FOR INSERT
    WITH CHECK (public.is_account_member(account_id, 'agent'));
CREATE POLICY ai_knowledge_bases_update ON public.ai_knowledge_bases FOR UPDATE
    USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY ai_knowledge_bases_delete ON public.ai_knowledge_bases FOR DELETE
    USING (public.is_account_member(account_id, 'admin'));

-- updated_at trigger
DROP TRIGGER IF EXISTS set_updated_at ON public.ai_knowledge_bases;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ai_knowledge_bases
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 4. AI_KNOWLEDGE_CHUNKS — Embeddings for RAG retrieval
--
-- Each chunk is a segment of a knowledge source (paragraph,
-- FAQ entry, PDF page) with its vector embedding for cosine
-- similarity search. The ivfflat index enables fast approximate
-- nearest-neighbor lookups.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    knowledge_base_id UUID NOT NULL REFERENCES public.ai_knowledge_bases(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding vector(1536),
    source_type TEXT NOT NULL DEFAULT 'text'
        CHECK (source_type IN ('text', 'pdf', 'url', 'faq', 'gdoc')),
    source_name TEXT,
    token_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_kb ON public.ai_knowledge_chunks(knowledge_base_id);

-- IVFFlat index for vector similarity search.
-- Uses cosine distance (vector_cosine_ops) which is standard for
-- OpenAI / text-embedding-3-small embeddings. The lists=100 parameter
-- balances recall vs speed for datasets up to ~100k chunks.
-- NOTE: This index requires at least some rows to exist before it
-- becomes effective; Postgres will build it empty and backfill.
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_embedding
    ON public.ai_knowledge_chunks
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

ALTER TABLE public.ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;

-- RLS: parent-join through ai_knowledge_bases → account_id
DROP POLICY IF EXISTS ai_knowledge_chunks_select ON public.ai_knowledge_chunks;
DROP POLICY IF EXISTS ai_knowledge_chunks_insert ON public.ai_knowledge_chunks;
DROP POLICY IF EXISTS ai_knowledge_chunks_update ON public.ai_knowledge_chunks;
DROP POLICY IF EXISTS ai_knowledge_chunks_delete ON public.ai_knowledge_chunks;

CREATE POLICY ai_knowledge_chunks_select ON public.ai_knowledge_chunks FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.ai_knowledge_bases kb
        WHERE kb.id = ai_knowledge_chunks.knowledge_base_id
          AND public.is_account_member(kb.account_id)
    ));
CREATE POLICY ai_knowledge_chunks_insert ON public.ai_knowledge_chunks FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.ai_knowledge_bases kb
        WHERE kb.id = ai_knowledge_chunks.knowledge_base_id
          AND public.is_account_member(kb.account_id, 'agent')
    ));
CREATE POLICY ai_knowledge_chunks_update ON public.ai_knowledge_chunks FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM public.ai_knowledge_bases kb
        WHERE kb.id = ai_knowledge_chunks.knowledge_base_id
          AND public.is_account_member(kb.account_id, 'agent')
    ));
CREATE POLICY ai_knowledge_chunks_delete ON public.ai_knowledge_chunks FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM public.ai_knowledge_bases kb
        WHERE kb.id = ai_knowledge_chunks.knowledge_base_id
          AND public.is_account_member(kb.account_id, 'admin')
    ));

-- ============================================================
-- 5. AI_AGENT_KNOWLEDGE_BASES — Many-to-many junction
--
-- Links agents to knowledge bases. An agent can draw from
-- multiple KBs, and a KB can serve multiple agents (e.g. a
-- shared product FAQ used by both Sales and Support agents).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_agent_knowledge_bases (
    agent_id UUID NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES public.ai_knowledge_bases(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, knowledge_base_id)
);

ALTER TABLE public.ai_agent_knowledge_bases ENABLE ROW LEVEL SECURITY;

-- RLS: parent-join through ai_agents → account_id
DROP POLICY IF EXISTS ai_agent_knowledge_bases_select ON public.ai_agent_knowledge_bases;
DROP POLICY IF EXISTS ai_agent_knowledge_bases_insert ON public.ai_agent_knowledge_bases;
DROP POLICY IF EXISTS ai_agent_knowledge_bases_delete ON public.ai_agent_knowledge_bases;

CREATE POLICY ai_agent_knowledge_bases_select ON public.ai_agent_knowledge_bases FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.ai_agents a
        WHERE a.id = ai_agent_knowledge_bases.agent_id
          AND public.is_account_member(a.account_id)
    ));
CREATE POLICY ai_agent_knowledge_bases_insert ON public.ai_agent_knowledge_bases FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.ai_agents a
        WHERE a.id = ai_agent_knowledge_bases.agent_id
          AND public.is_account_member(a.account_id, 'agent')
    ));
CREATE POLICY ai_agent_knowledge_bases_delete ON public.ai_agent_knowledge_bases FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM public.ai_agents a
        WHERE a.id = ai_agent_knowledge_bases.agent_id
          AND public.is_account_member(a.account_id, 'agent')
    ));

-- ============================================================
-- 6. AI_AGENT_SKILLS — Per-agent CRM action capabilities
--
-- Each skill represents an action the agent can perform during
-- conversation (look up CRM data, create a deal, tag a contact,
-- etc.). skill_config holds type-specific parameters (e.g.
-- which pipeline for create_deal, which tags are allowed, etc.).
-- UNIQUE(agent_id, skill_type) prevents duplicate skill configs.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_agent_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
    skill_type TEXT NOT NULL
        CHECK (skill_type IN ('crm_lookup', 'create_deal', 'tag_contact', 'book_appointment', 'escalate', 'update_contact')),
    skill_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_id, skill_type)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_skills_agent ON public.ai_agent_skills(agent_id);

ALTER TABLE public.ai_agent_skills ENABLE ROW LEVEL SECURITY;

-- RLS: parent-join through ai_agents → account_id
DROP POLICY IF EXISTS ai_agent_skills_select ON public.ai_agent_skills;
DROP POLICY IF EXISTS ai_agent_skills_insert ON public.ai_agent_skills;
DROP POLICY IF EXISTS ai_agent_skills_update ON public.ai_agent_skills;
DROP POLICY IF EXISTS ai_agent_skills_delete ON public.ai_agent_skills;

CREATE POLICY ai_agent_skills_select ON public.ai_agent_skills FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.ai_agents a
        WHERE a.id = ai_agent_skills.agent_id
          AND public.is_account_member(a.account_id)
    ));
CREATE POLICY ai_agent_skills_insert ON public.ai_agent_skills FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.ai_agents a
        WHERE a.id = ai_agent_skills.agent_id
          AND public.is_account_member(a.account_id, 'agent')
    ));
CREATE POLICY ai_agent_skills_update ON public.ai_agent_skills FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM public.ai_agents a
        WHERE a.id = ai_agent_skills.agent_id
          AND public.is_account_member(a.account_id, 'agent')
    ));
CREATE POLICY ai_agent_skills_delete ON public.ai_agent_skills FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM public.ai_agents a
        WHERE a.id = ai_agent_skills.agent_id
          AND public.is_account_member(a.account_id, 'admin')
    ));

-- ============================================================
-- 7. AI_CALENDARS — Account-scoped booking calendars
--
-- Each calendar defines availability rules (working hours per
-- day-of-week, slot duration, buffer between appointments).
-- The working_hours JSONB stores { "mon": ["09:00","17:00"], … }
-- for quick front-end rendering and server-side slot computation.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_calendars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Main Calendar',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    working_hours JSONB NOT NULL DEFAULT '{"mon":["09:00","17:00"],"tue":["09:00","17:00"],"wed":["09:00","17:00"],"thu":["09:00","17:00"],"fri":["09:00","17:00"]}'::jsonb,
    slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
    buffer_minutes INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_calendars_account ON public.ai_calendars(account_id);

ALTER TABLE public.ai_calendars ENABLE ROW LEVEL SECURITY;

-- RLS: full CRUD for account members
DROP POLICY IF EXISTS ai_calendars_select ON public.ai_calendars;
DROP POLICY IF EXISTS ai_calendars_insert ON public.ai_calendars;
DROP POLICY IF EXISTS ai_calendars_update ON public.ai_calendars;
DROP POLICY IF EXISTS ai_calendars_delete ON public.ai_calendars;

CREATE POLICY ai_calendars_select ON public.ai_calendars FOR SELECT
    USING (public.is_account_member(account_id));
CREATE POLICY ai_calendars_insert ON public.ai_calendars FOR INSERT
    WITH CHECK (public.is_account_member(account_id, 'agent'));
CREATE POLICY ai_calendars_update ON public.ai_calendars FOR UPDATE
    USING (public.is_account_member(account_id, 'agent'));
CREATE POLICY ai_calendars_delete ON public.ai_calendars FOR DELETE
    USING (public.is_account_member(account_id, 'admin'));

-- updated_at trigger
DROP TRIGGER IF EXISTS set_updated_at ON public.ai_calendars;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ai_calendars
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 8. AI_APPOINTMENTS — Booked appointment slots
--
-- Represents a confirmed/cancelled/completed appointment on a
-- calendar. Links to the contact, the AI agent that booked it,
-- and the conversation where booking occurred — providing full
-- audit trail from chat to calendar event.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    calendar_id UUID NOT NULL REFERENCES public.ai_calendars(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    agent_id UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT 'Appointment',
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_appointments_calendar ON public.ai_appointments(calendar_id);
CREATE INDEX IF NOT EXISTS idx_ai_appointments_starts_at ON public.ai_appointments(starts_at);

ALTER TABLE public.ai_appointments ENABLE ROW LEVEL SECURITY;

-- RLS: parent-join through ai_calendars → account_id
DROP POLICY IF EXISTS ai_appointments_select ON public.ai_appointments;
DROP POLICY IF EXISTS ai_appointments_insert ON public.ai_appointments;
DROP POLICY IF EXISTS ai_appointments_update ON public.ai_appointments;
DROP POLICY IF EXISTS ai_appointments_delete ON public.ai_appointments;

CREATE POLICY ai_appointments_select ON public.ai_appointments FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.ai_calendars cal
        WHERE cal.id = ai_appointments.calendar_id
          AND public.is_account_member(cal.account_id)
    ));
CREATE POLICY ai_appointments_insert ON public.ai_appointments FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.ai_calendars cal
        WHERE cal.id = ai_appointments.calendar_id
          AND public.is_account_member(cal.account_id, 'agent')
    ));
CREATE POLICY ai_appointments_update ON public.ai_appointments FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM public.ai_calendars cal
        WHERE cal.id = ai_appointments.calendar_id
          AND public.is_account_member(cal.account_id, 'agent')
    ));
CREATE POLICY ai_appointments_delete ON public.ai_appointments FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM public.ai_calendars cal
        WHERE cal.id = ai_appointments.calendar_id
          AND public.is_account_member(cal.account_id, 'admin')
    ));

-- updated_at trigger
DROP TRIGGER IF EXISTS set_updated_at ON public.ai_appointments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ai_appointments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 9. AI_CONVERSATION_LOGS — LLM usage tracking per message
--
-- Records every LLM call: which model, token counts, cost, and
-- latency. Powers the cost dashboard and helps detect runaway
-- agents. message_id is nullable because some calls (e.g.
-- function-calling rounds) don't produce a user-facing message.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ai_conversation_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
    model_used TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversation_logs_agent ON public.ai_conversation_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversation_logs_conversation ON public.ai_conversation_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversation_logs_created_at ON public.ai_conversation_logs(created_at);

ALTER TABLE public.ai_conversation_logs ENABLE ROW LEVEL SECURITY;

-- RLS: parent-join through ai_agents → account_id
DROP POLICY IF EXISTS ai_conversation_logs_select ON public.ai_conversation_logs;
DROP POLICY IF EXISTS ai_conversation_logs_insert ON public.ai_conversation_logs;

CREATE POLICY ai_conversation_logs_select ON public.ai_conversation_logs FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM public.ai_agents a
        WHERE a.id = ai_conversation_logs.agent_id
          AND public.is_account_member(a.account_id)
    ));
-- Logs are insert-only from the service role (server-side AI pipeline).
-- No client INSERT/UPDATE/DELETE policies — service_role bypasses RLS.
CREATE POLICY ai_conversation_logs_insert ON public.ai_conversation_logs FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.ai_agents a
        WHERE a.id = ai_conversation_logs.agent_id
          AND public.is_account_member(a.account_id, 'agent')
    ));

-- ============================================================
-- 10. ADD ai_agent_id TO CONVERSATIONS
--
-- Links a conversation to the specific AI agent handling it.
-- SET NULL on delete so conversation history isn't lost when
-- an agent is removed.
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'ai_agent_id') THEN
        ALTER TABLE public.conversations ADD COLUMN ai_agent_id UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ============================================================
-- 11. ENABLE REALTIME for ai_agents
--
-- Adds ai_agents to the supabase_realtime publication so the
-- front-end can subscribe to agent status changes in real time.
-- Idempotent: checks pg_publication_tables before adding.
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'ai_agents'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_agents;
    END IF;
END $$;
