// ─── Open Brain MCP: SSE/HTTP transport ──────────────────────────────────────
// Network-accessible MCP server for tools that support SSE or HTTP.
// Default port: 3100 (override with MCP_HTTP_PORT env var).
//
// Endpoints:
//   GET  /sse        — SSE stream (MCP SSE transport)
//   POST /messages   — MCP message endpoint
//   GET  /health     — Health check

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createBrainServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

const config = {
  supabaseUrl: requireEnv("SUPABASE_URL"),
  supabaseKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
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

const brainServer = createBrainServer(config);

// Active SSE transports keyed by session id
const transports: Map<string, SSEServerTransport> = new Map();

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "open-brain-mcp", sessions: transports.size });
});

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    transports.delete(transport.sessionId);
  });

  await brainServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query["sessionId"] as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`Open Brain MCP server (SSE) running on http://localhost:${PORT}`);
  console.log(`  SSE endpoint:   http://localhost:${PORT}/sse`);
  console.log(`  Messages:       http://localhost:${PORT}/messages`);
  console.log(`  Health:         http://localhost:${PORT}/health`);
});
