-- ═══════════════════════════════════════════════════════════════════════
-- GravityClaw — Open Brain: Physical Column Reorder
-- PostgreSQL has no ALTER TABLE REORDER COLUMNS. The only way to change
-- physical column order is to recreate the table. This script:
--   1. Creates brain_memories_new with fixed-width columns first
--   2. Copies all data
--   3. Recreates all constraints, indexes, trigger, and RLS
--   4. Atomically swaps the tables via RENAME
--   5. Drops the old table
--
-- Assumes migrations 004 (halfvec) and 005 (gen_random_uuid) have run.
-- If running this independently, adjust column types accordingly.
--
-- WARNING: The INSERT ... SELECT holds an AccessExclusiveLock on the old
-- table for the full duration. For a zero-downtime migration on a live
-- high-traffic table, use pg_repack instead.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Create new table with fixed-width columns first to minimise alignment padding
CREATE TABLE brain_memories_new (
  -- Fixed-width (8–16 bytes each, aligned together)
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  created_at  timestamptz          DEFAULT NOW(),
  updated_at  timestamptz          DEFAULT NOW(),
  -- Variable-width (varlena / TOAST-able) at the end
  source      text        NOT NULL DEFAULT 'manual',
  content     text        NOT NULL,
  tags        text[]               DEFAULT '{}'::text[],
  source_metadata jsonb            DEFAULT '{}'::jsonb,
  embedding   halfvec(1536)
) WITH (fillfactor = 90);

-- 2. Copy all existing data preserving every column value
INSERT INTO brain_memories_new (
  id, created_at, updated_at, source, content, tags, source_metadata, embedding
)
SELECT
  id, created_at, updated_at, source, content, tags, source_metadata, embedding
FROM brain_memories;

-- 3. Primary key constraint
ALTER TABLE brain_memories_new
  ADD CONSTRAINT brain_memories_pkey PRIMARY KEY (id);

-- 4. Explicit EXTENDED storage on large columns
ALTER TABLE brain_memories_new ALTER COLUMN content         SET STORAGE EXTENDED;
ALTER TABLE brain_memories_new ALTER COLUMN source_metadata SET STORAGE EXTENDED;
ALTER TABLE brain_memories_new ALTER COLUMN embedding       SET STORAGE EXTENDED;

-- 5. Atomic table swap — both renames happen in the same transaction
ALTER TABLE brain_memories     RENAME TO brain_memories_old;
ALTER TABLE brain_memories_new RENAME TO brain_memories;

-- 6. Recreate all indexes on the new table
CREATE INDEX brain_memories_source_idx
  ON brain_memories (source);

CREATE INDEX brain_memories_created_idx
  ON brain_memories (created_at DESC);

CREATE INDEX brain_memories_tags_idx
  ON brain_memories USING gin (tags);

-- HNSW index for approximate cosine similarity (halfvec_cosine_ops since migration 004)
-- NOTE: For a live table, consider running the CONCURRENTLY version instead:
--   CREATE INDEX CONCURRENTLY brain_memories_embedding_idx
--     ON brain_memories USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX brain_memories_embedding_idx
  ON brain_memories USING hnsw (embedding halfvec_cosine_ops);

-- 7. Recreate updated_at trigger (function trigger_set_updated_at defined in 001)
CREATE TRIGGER set_updated_at_brain_memories
  BEFORE UPDATE ON brain_memories
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- 8. Recreate RLS and grants (mirrors 003_brain_rls.sql)
ALTER TABLE brain_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read"
  ON brain_memories
  FOR SELECT
  TO anon
  USING (true);

GRANT SELECT   ON brain_memories            TO anon;
GRANT EXECUTE  ON FUNCTION match_memories   TO anon;
GRANT SELECT   ON brain_stats               TO anon;

-- 9. Drop the old table — all data is in brain_memories at this point
--    brain_stats view references brain_memories by name and requires no change.
DROP TABLE brain_memories_old;

COMMIT;
