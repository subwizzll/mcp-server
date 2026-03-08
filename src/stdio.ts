// ─── Open Brain MCP: stdio transport ─────────────────────────────────────────
// Entry point for Cursor, Claude Desktop, and any MCP client using stdio.
//
// Usage in .cursor/mcp.json:
//   { "command": "npx", "args": ["tsx", "mcp-server/src/stdio.ts"] }
// Or after npm install:
//   { "command": "node", "args": ["mcp-server/dist/stdio.js"] }

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrainServer } from "./server.js";
import { SupabaseAdapter, PostgresAdapter } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

const backend = process.env["DB_BACKEND"] ?? "supabase";

const db =
  backend === "postgres"
    ? new PostgresAdapter(requireEnv("DATABASE_URL"))
    : new SupabaseAdapter(
        requireEnv("SUPABASE_URL"),
        requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      );

const config = {
  db,
  openrouterApiKey: requireEnv("OPENROUTER_API_KEY"),
  embeddingModel: process.env["EMBEDDING_MODEL"],
  embeddingDimensions: process.env["EMBEDDING_DIMENSIONS"]
    ? parseInt(process.env["EMBEDDING_DIMENSIONS"], 10)
    : undefined,
  cursorTranscriptsDir: process.env["CURSOR_TRANSCRIPTS_DIR"],
};

const server = createBrainServer(config);
const transport = new StdioServerTransport();

await server.connect(transport);
