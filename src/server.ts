// ─── Open Brain MCP Server ────────────────────────────────────────────────────
// Exposes semantic brain memory as MCP tools for Cursor, Claude Desktop,
// and any other AI tool that speaks MCP.
//
// Tools:
//   search_brain  — semantic similarity search
//   add_memory    — ingest new knowledge
//   recall        — filtered list retrieval (no embedding needed)
//   forget        — delete a memory by id
//   brain_stats   — counts and source breakdown of the knowledge base

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateEmbedding, vectorLiteral } from "./embeddings.js";
import { addToolshedTools, indexToolRegistry } from "./toolshed.js";
import {
  indexCursorChats,
  searchTranscriptsRaw,
  WORK_HISTORY_SOURCE,
} from "./chat-indexer.js";
import type { DbAdapter, BrainMemory } from "./db.js";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config (resolved from environment) ──────────────────────────────
export interface ServerConfig {
  db: DbAdapter;
  openrouterApiKey: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  /** Path to Cursor agent-transcripts directory for work history indexing */
  cursorTranscriptsDir?: string;
}

function formatMemory(m: BrainMemory, index?: number): string {
  const prefix = index != null ? `[${index + 1}]` : "•";
  const sim = m.similarity != null ? ` (${(m.similarity * 100).toFixed(0)}% match)` : "";
  const tags = m.tags?.length ? `  tags: ${m.tags.join(", ")}` : "";
  const source = `  source: ${m.source}`;
  const date = `  added: ${new Date(m.created_at).toLocaleDateString()}`;
  return `${prefix} ${m.content}${sim}\n${source}${tags}\n${date}\n  id: ${m.id}`;
}

// ─── Build and return the configured MCP server instance ──────────────
export function createBrainServer(config: ServerConfig): McpServer {
  const { db } = config;

  const embeddingConfig = {
    apiKey: config.openrouterApiKey,
    model: config.embeddingModel ?? "openai/text-embedding-3-small",
    dimensions: config.embeddingDimensions ?? 1536,
  };

  const server = new McpServer({
    name: "open-brain",
    version: "1.0.0",
  });

  // ── Tool: search_brain ──────────────────────────────────────────────
  server.tool(
    "search_brain",
    "Search personal knowledge base by meaning. Returns memories ranked by semantic similarity to the query.",
    {
      query: z.string().min(1).describe("Natural language search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(8)
        .describe("Max results to return (default 8)"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.3)
        .describe("Minimum similarity score 0–1 (default 0.3)"),
      source: z
        .string()
        .optional()
        .describe(
          "Filter by source: manual, telegram, cursor, api, conversations, knowledge",
        ),
    },
    async ({ query, limit, threshold, source }) => {
      try {
        const embedding = await generateEmbedding(query, embeddingConfig);
        const vector = vectorLiteral(embedding);

        const memories = await db.searchMemories(vector, threshold, limit, source);

        if (memories.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No memories found matching "${query}" (threshold: ${threshold}).`,
              },
            ],
          };
        }

        const text = [
          `Found ${memories.length} memories for: "${query}"`,
          "",
          ...memories.map((m, i) => formatMemory(m, i)),
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `search_brain failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: add_memory ───────────────────────────────────────────────
  server.tool(
    "add_memory",
    "Add new knowledge to the personal brain. Content is embedded and stored for future semantic retrieval.",
    {
      content: z
        .string()
        .min(1)
        .describe("The text content to remember"),
      source: z
        .string()
        .optional()
        .default("cursor")
        .describe("Source of the memory (cursor, api, manual, telegram, etc.)"),
      tags: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Optional tags to categorize the memory"),
      source_metadata: z
        .record(z.string(), z.string())
        .optional()
        .default({})
        .describe("Optional structured source_metadata (e.g., URL, file path, context)"),
    },
    async ({ content, source, tags, source_metadata }) => {
      try {
        const embedding = await generateEmbedding(content, embeddingConfig);
        const vector = vectorLiteral(embedding);

        const row = await db.insertMemory({
          content,
          embedding: vector,
          source,
          tags,
          source_metadata,
        });

        return {
          content: [
            {
              type: "text",
              text: `Stored memory (id: ${row.id})\ntags: ${row.tags.join(", ") || "none"}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `add_memory failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: recall ───────────────────────────────────────────────────
  server.tool(
    "recall",
    "List memories with optional filtering by source, tags, or date range. No semantic search — returns raw filtered results.",
    {
      source: z
        .string()
        .optional()
        .describe("Filter by source (manual, telegram, cursor, api, etc.)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter by tags (any match)"),
      since: z
        .string()
        .optional()
        .describe("ISO date string: return memories created after this date"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(20)
        .describe("Max results (default 20)"),
    },
    async ({ source, tags, since, limit }) => {
      try {
        const memories = await db.recallMemories({ source, tags, since, limit: limit ?? 20 });

        if (memories.length === 0) {
          return {
            content: [{ type: "text", text: "No memories found with those filters." }],
          };
        }

        const text = [
          `${memories.length} memories:`,
          "",
          ...memories.map((m) => formatMemory(m)),
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `recall failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: forget ───────────────────────────────────────────────────
  server.tool(
    "forget",
    "Delete a memory from the brain by its ID.",
    {
      id: z
        .string()
        .uuid()
        .describe("UUID of the memory to delete"),
    },
    async ({ id }) => {
      try {
        await db.deleteMemory(id);
        return {
          content: [{ type: "text", text: `Memory ${id} deleted.` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `forget failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: brain_stats ──────────────────────────────────────────────
  server.tool(
    "brain_stats",
    "Get statistics about the personal knowledge base: total memories, embedding coverage, breakdown by source.",
    {},
    async () => {
      try {
        const [stats, bySource] = await Promise.all([
          db.getStats(),
          db.getSourceCounts(),
        ]);

        const sourceBreakdown = Object.entries(bySource)
          .sort((a, b) => b[1] - a[1])
          .map(([src, count]) => `  ${src}: ${count}`)
          .join("\n");

        const lastAdded = stats?.last_ingested_at
          ? new Date(stats.last_ingested_at).toLocaleString()
          : "never";

        const text = [
          `Open Brain Statistics`,
          `─────────────────────`,
          `Total memories:     ${stats?.total_memories ?? 0}`,
          `With embeddings:    ${stats?.embedded_count ?? 0}`,
          `Pending embedding:  ${stats?.pending_embedding ?? 0}`,
          `Unique sources:     ${stats?.source_count ?? 0}`,
          `Last ingested:      ${lastAdded}`,
          "",
          "By source:",
          sourceBreakdown || "  (none)",
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `brain_stats failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: index_cursor_chats ──────────────────────────────────────
  server.tool(
    "index_cursor_chats",
    `Index Cursor agent transcripts into the brain as searchable work history. Reads JSONL transcripts from the configured transcripts directory and stores each session as a memory with source="${WORK_HISTORY_SOURCE}". Skips already-indexed sessions by default. Search them afterward with search_brain using source="work_history".`,
    {
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe("Re-index already-indexed sessions (default false)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max number of most-recent sessions to process (default: all)"),
    },
    async ({ force, limit }) => {
      const transcriptsDir = config.cursorTranscriptsDir;
      if (!transcriptsDir) {
        return {
          content: [
            {
              type: "text",
              text: "CURSOR_TRANSCRIPTS_DIR is not configured. Set it in your environment and restart the MCP server.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await indexCursorChats(
          transcriptsDir,
          db,
          embeddingConfig,
          { force: force ?? false, limit },
        );

        const lines = [
          `Chat indexing complete.`,
          `  Indexed:  ${result.indexed}`,
          `  Skipped:  ${result.skipped} (already in brain)`,
          `  Total:    ${result.total}`,
        ];

        if (result.errors.length > 0) {
          lines.push(`  Errors:   ${result.errors.length}`);
          lines.push(...result.errors.map((e) => `    • ${e}`));
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `index_cursor_chats failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: search_work_history ─────────────────────────────────────
  server.tool(
    "search_work_history",
    "Search through raw Cursor agent transcript files by keyword. Complements semantic search_brain by allowing exact keyword matching across all work sessions. Returns matching excerpts with surrounding context.",
    {
      query: z
        .string()
        .min(1)
        .describe("Keyword or phrase to search for across all transcripts"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe("Max number of sessions to return (default 5)"),
    },
    async ({ query, limit }) => {
      const transcriptsDir = config.cursorTranscriptsDir;
      if (!transcriptsDir) {
        return {
          content: [
            {
              type: "text",
              text: "CURSOR_TRANSCRIPTS_DIR is not configured. Set it in your environment and restart the MCP server.",
            },
          ],
          isError: true,
        };
      }

      try {
        const results = await searchTranscriptsRaw(transcriptsDir, query, limit);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No transcripts found containing "${query}".`,
              },
            ],
          };
        }

        const text = [
          `Found "${query}" in ${results.length} work session(s):`,
          "",
          ...results.flatMap((r) => [
            `▸ Session: ${r.transcript_id} (${r.date})`,
            ...r.matches.map((m) => `  [${m.role}] ${m.excerpt}`),
            "",
          ]),
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `search_work_history failed: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Toolshed: dynamic tool discovery ──────────────────────────────
  addToolshedTools(server, db, config);

  // Index tool registry on startup (fire-and-forget, idempotent)
  const registryPath = join(__dirname, "../../tool-registry.json");
  readFile(registryPath, "utf-8")
    .then((raw) => {
      const registry = JSON.parse(raw) as Array<{
        name: string;
        server: string;
        description: string;
        category: string;
        tags: string[];
      }>;
      return indexToolRegistry(registry, db, embeddingConfig);
    })
    .catch((err) => {
      console.warn("[Toolshed] Registry indexing skipped:", err instanceof Error ? err.message : err);
    });

  return server;
}
