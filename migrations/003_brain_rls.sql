-- ═══════════════════════════════════════════════════════════════════════
-- GravityClaw — Open Brain: RLS Policies
-- Enables Row Level Security on brain_memories and grants read access
-- to the anon role (used by mission-control's publishable key).
-- The service_role key (used by mcp-server and the bot) bypasses RLS.
-- ═══════════════════════════════════════════════════════════════════════

-- Enable RLS on brain_memories
ALTER TABLE brain_memories ENABLE ROW LEVEL SECURITY;

-- Allow anon (publishable key / mission-control) to read all memories
CREATE POLICY "anon_read"
  ON brain_memories
  FOR SELECT
  TO anon
  USING (true);

-- Allow anon to call match_memories RPC
GRANT EXECUTE ON FUNCTION match_memories TO anon;

-- Allow anon to read the brain_stats view
GRANT SELECT ON brain_stats TO anon;

-- Allow anon to read brain_memories directly (for the brain page)
GRANT SELECT ON brain_memories TO anon;

-- ═══════════════════════════════════════════════════════════════════════
-- Done. Anon role can now read brain_memories and call match_memories.
-- Service role continues to bypass RLS for writes from the bot and MCP.
-- ═══════════════════════════════════════════════════════════════════════
