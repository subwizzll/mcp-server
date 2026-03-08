-- ═══════════════════════════════════════════════════════════════════════
-- GravityClaw — Open Brain: Storage Attributes & Fillfactor
-- Explicitly sets EXTENDED storage on large columns (enabling compression
-- and TOAST offloading) and reserves 10% of each heap page for in-place
-- updates, avoiding row migrations that inflate table size over time.
--
-- EXTENDED is already the PostgreSQL default for text/jsonb/halfvec,
-- but making it explicit ensures it survives future type alterations
-- and documents intent clearly.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- EXTENDED: compress in-line first, TOAST if still too large
ALTER TABLE brain_memories ALTER COLUMN content         SET STORAGE EXTENDED;
ALTER TABLE brain_memories ALTER COLUMN source_metadata SET STORAGE EXTENDED;
ALTER TABLE brain_memories ALTER COLUMN embedding       SET STORAGE EXTENDED;

-- Reserve 10% of each page for HOT updates (avoids dead-row bloat on
-- updated_at / source_metadata edits without needing VACUUM as often)
ALTER TABLE brain_memories SET (fillfactor = 90);

-- Rewrite pages to apply the new fillfactor and collect fresh statistics
VACUUM ANALYZE brain_memories;

COMMIT;
