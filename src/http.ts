// ─── Open Brain MCP: Streamable HTTP transport ────────────────────────────────
// Network-accessible MCP server using MCP Streamable HTTP transport.
// Default port: 3100 (override with MCP_HTTP_PORT env var).
//
// Endpoints:
//   GET/POST/DELETE /mcp  — MCP Streamable HTTP transport
//   GET  /health          — Health check

import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

const PORT = parseInt(process.env["MCP_HTTP_PORT"] ?? "3100", 10);

const app = express();
app.use(express.json());

// Active transports keyed by session id
const transports: Map<string, StreamableHTTPServerTransport> = new Map();

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "open-brain-mcp", sessions: transports.size });
});

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // No session ID — treat as a new initialization request
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
    }
  };

  const server = createBrainServer(config);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Open Brain MCP server (Streamable HTTP) running on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:  http://localhost:${PORT}/mcp`);
  console.log(`  Health:        http://localhost:${PORT}/health`);
});
