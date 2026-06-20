-- ============================================================
-- 026_ai_knowledge_search.sql — Vector similarity search
--
-- Adds the Postgres function (RPC) required to search the
-- ai_knowledge_chunks table for semantic similarity.
-- 
-- The function takes an embedding vector, an agent ID, and
-- returns the closest text chunks from the specific knowledge
-- bases assigned to that agent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
    query_embedding vector(1536),
    match_agent_id uuid,
    match_count int DEFAULT 5,
    similarity_threshold float DEFAULT 0.70
)
RETURNS TABLE (
    id uuid,
    knowledge_base_id uuid,
    content text,
    metadata jsonb,
    source_type text,
    source_name text,
    similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER -- Run as definer to bypass RLS for the LLM backend
AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id,
        c.knowledge_base_id,
        c.content,
        c.metadata,
        c.source_type,
        c.source_name,
        1 - (c.embedding <=> query_embedding) AS similarity
    FROM public.ai_knowledge_chunks c
    -- Only search chunks in knowledge bases assigned to this specific agent
    JOIN public.ai_agent_knowledge_bases akb ON c.knowledge_base_id = akb.knowledge_base_id
    WHERE akb.agent_id = match_agent_id
      AND 1 - (c.embedding <=> query_embedding) > similarity_threshold
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
