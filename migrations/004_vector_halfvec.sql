-- ═══════════════════════════════════════════════════════════════════════
-- GravityClaw — Open Brain: Vector Column Optimization
-- Converts embedding from vector(1536) to halfvec(1536) — 50% space savings.
-- Also updates the match_memories RPC function signature accordingly.
--
-- WARNING: ALTER COLUMN TYPE rewrites every row (AccessExclusiveLock).
-- Run during off-peak hours. For large tables, use the Supabase CLI
-- (supabase db push) to avoid the SQL editor's 2-minute timeout.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Drop HNSW index first — required before column type change
DROP INDEX IF EXISTS brain_memories_embedding_idx;

-- 2. Rewrite embedding column from 4-byte floats to 2-byte floats
ALTER TABLE brain_memories
  ALTER COLUMN embedding TYPE halfvec(1536)
  USING embedding::halfvec(1536);

-- 3. Update match_memories RPC: parameter type changes from vector to halfvec.
--    App callers (MCP server, bot) pass bracket-notation strings e.g. "[0.1,...]"
--    which PostgreSQL casts via halfvec_in — no client code changes required.
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding halfvec(1536),
  match_threshold FLOAT    DEFAULT 0.3,
  match_count     INT      DEFAULT 10,
  filter_source   TEXT     DEFAULT NULL,
  filter_tags     TEXT[]   DEFAULT NULL
)
RETURNS TABLE (
  id              UUID,
  content         TEXT,
  source          TEXT,
  source_metadata JSONB,
  tags            TEXT[],
  created_at      TIMESTAMPTZ,
  similarity      FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    bm.id,
    bm.content,
    bm.source,
    bm.source_metadata,
    bm.tags,
    bm.created_at,
    1 - (bm.embedding <=> query_embedding) AS similarity
  FROM brain_memories bm
  WHERE
    bm.embedding IS NOT NULL
    AND 1 - (bm.embedding <=> query_embedding) >= match_threshold
    AND (filter_source IS NULL OR bm.source = filter_source)
    AND (filter_tags IS NULL OR bm.tags && filter_tags)
  ORDER BY bm.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Re-grant after function recreation (signature changed, so previous grant is dropped)
GRANT EXECUTE ON FUNCTION match_memories TO anon;

COMMIT;

-- 4. Recreate HNSW index with halfvec cosine ops.
--    NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
--    This blocking form is compatible with the migration system.
--    For a zero-impact rebuild on a live table, run the CONCURRENTLY version
--    separately in the Supabase SQL editor after this migration completes:
--
--    CREATE INDEX CONCURRENTLY brain_memories_embedding_idx
--      ON brain_memories USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX brain_memories_embedding_idx
  ON brain_memories USING hnsw (embedding halfvec_cosine_ops);
