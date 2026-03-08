-- ═══════════════════════════════════════════════════════════════════════
-- GravityClaw — Open Brain: UUID Default Optimization
-- Switches id default from uuid_generate_v4() (uuid-ossp extension) to
-- the built-in gen_random_uuid(). Both produce random v4 UUIDs, but
-- gen_random_uuid() requires no extension and is available in all PG 13+.
--
-- For true time-ordered (v7) UUIDs — which reduce B-tree index fragmentation
-- by appending to the end rather than inserting randomly — uncomment the
-- pg_uuidv7 block below if your Supabase plan supports the extension.
--
-- NOTE: Only affects new rows. Existing UUIDs are unchanged.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- Switch to built-in UUID generation (no extension dependency)
ALTER TABLE brain_memories
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Optional: true time-ordered UUIDs via pg_uuidv7 extension.
-- Uncomment if available on your Supabase plan (Pro/Team+):
--
-- CREATE EXTENSION IF NOT EXISTS pg_uuidv7;
-- ALTER TABLE brain_memories ALTER COLUMN id SET DEFAULT uuid_generate_v7();

COMMIT;
