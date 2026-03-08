-- ═══════════════════════════════════════════════════════════════════════
-- GravityClaw — Open Brain: pgvector Semantic Memory
-- Run this against your Supabase PostgreSQL instance
-- ═══════════════════════════════════════════════════════════════════════

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── brain_memories ───────────────────────────────────────────────────
-- Persistent semantic knowledge base. Stores raw content + vector embedding.
-- source: 'manual' | 'telegram' | 'cursor' | 'api' | 'conversations' | 'knowledge'
CREATE TABLE IF NOT EXISTS brain_memories (
  id           UUID         DEFAULT uuid_generate_v4() PRIMARY KEY,
  content      TEXT         NOT NULL,
  embedding    vector(1536),
  source       TEXT         NOT NULL DEFAULT 'manual',
  source_metadata JSONB     DEFAULT '{}'::jsonb,
  tags         TEXT[]       DEFAULT '{}'::text[],
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- HNSW index for fast approximate cosine similarity search
CREATE INDEX IF NOT EXISTS brain_memories_embedding_idx
  ON brain_memories USING hnsw (embedding vector_cosine_ops);

-- Indexes for filtered queries
CREATE INDEX IF NOT EXISTS brain_memories_source_idx   ON brain_memories(source);
CREATE INDEX IF NOT EXISTS brain_memories_created_idx  ON brain_memories(created_at DESC);
CREATE INDEX IF NOT EXISTS brain_memories_tags_idx     ON brain_memories USING gin(tags);

-- updated_at trigger (reuses function from migration 001)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_updated_at_brain_memories') THEN
    CREATE TRIGGER set_updated_at_brain_memories
      BEFORE UPDATE ON brain_memories
      FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
  END IF;
END $$;

-- ─── match_memories RPC ───────────────────────────────────────────────
-- Cosine similarity search. Called by the MCP server and the UI.
-- Returns memories ranked by descending similarity, above a threshold.
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(1536),
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

-- ─── brain_stats view ─────────────────────────────────────────────────
-- Aggregate stats for the dashboard.
CREATE OR REPLACE VIEW brain_stats AS
SELECT
  COUNT(*)                                            AS total_memories,
  COUNT(*) FILTER (WHERE embedding IS NOT NULL)       AS embedded_count,
  COUNT(*) FILTER (WHERE embedding IS NULL)           AS pending_embedding,
  COUNT(DISTINCT source)                              AS source_count,
  MAX(created_at)                                     AS last_ingested_at
FROM brain_memories;

-- ─── Migrate existing brain facts from data_store ─────────────────────
-- Copies fact_* rows into brain_memories (source='manual', no embedding yet).
-- Embeddings are generated lazily or via a backfill job.
INSERT INTO brain_memories (content, source, source_metadata, tags, created_at)
SELECT
  value                                              AS content,
  'manual'                                           AS source,
  jsonb_build_object('original_key', key)            AS source_metadata,
  ARRAY[
    CASE
      WHEN key LIKE 'fact_url_%'  THEN 'url'
      WHEN key LIKE 'fact_file_%' THEN 'file'
      ELSE 'note'
    END
  ]                                                  AS tags,
  COALESCE(created_at, NOW())                        AS created_at
FROM data_store
WHERE key LIKE 'fact_%'
  AND value IS NOT NULL
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- Done. brain_memories table, match_memories RPC, and brain_stats view created.
-- Existing fact_* rows migrated (embeddings pending generation).
-- ═══════════════════════════════════════════════════════════════════════
