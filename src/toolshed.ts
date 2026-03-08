// ─── Toolshed MCP Extension ───────────────────────────────────────────
// Adds a `discover_tools` tool to the Open Brain MCP server.
// The Toolshed solves the "token explosion" problem: instead of injecting
// all ~N MCP tool schemas into the agent's context, the agent calls
// discover_tools with a natural language query and gets back only the
// handful of tools relevant to its current task.
//
// Implementation: tool descriptions are embedded into the brain's
// brain_memories table (source="toolshed"). On query, the Toolshed does
// a semantic similarity search and returns matching tool entries.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DbAdapter } from "./db.js";
import { z } from "zod";
import { generateEmbedding, vectorLiteral } from "./embeddings.js";
import type { ServerConfig } from "./server.js";

// ─── Tool Registry Entry ──────────────────────────────────────────────

interface ToolRegistryEntry {
  name: string;
  server: string;
  description: string;
  category: string;
  tags: string[];
}

// ─── Index Tools into Brain ───────────────────────────────────────────
// Called once on server startup to ensure all tool registry entries are
// embedded. Idempotent — skips entries that are already stored.

export async function indexToolRegistry(
  registry: ToolRegistryEntry[],
  db: DbAdapter,
  embeddingConfig: Parameters<typeof generateEmbedding>[1],
): Promise<void> {
  const count = await db.countBySource("toolshed");

  if (count >= registry.length) {
    return;
  }

  console.log(`[Toolshed] Indexing ${registry.length} tools into brain…`);

  for (const tool of registry) {
    const content = [
      `Tool: ${tool.name}`,
      `Server: ${tool.server}`,
      `Category: ${tool.category}`,
      `Description: ${tool.description}`,
      `Tags: ${tool.tags.join(", ")}`,
    ].join("\n");

    try {
      const embedding = await generateEmbedding(content, embeddingConfig);
      const vector = vectorLiteral(embedding);

      await db.upsertMemory({
        content,
        embedding: vector,
        source: "toolshed",
        tags: ["toolshed", tool.category, ...tool.tags],
        source_metadata: {
          tool_name: tool.name,
          server: tool.server,
          category: tool.category,
        },
      });
    } catch (err) {
      console.warn(`[Toolshed] Failed to index tool ${tool.name}:`, err);
    }
  }

  console.log(`[Toolshed] Tool registry indexed.`);
}

// ─── Add discover_tools to MCP Server ────────────────────────────────

export function addToolshedTools(
  server: McpServer,
  db: DbAdapter,
  config: ServerConfig,
): void {
  const embeddingConfig = {
    apiKey: config.openrouterApiKey,
    model: config.embeddingModel ?? "openai/text-embedding-3-small",
    dimensions: config.embeddingDimensions ?? 1536,
  };

  server.tool(
    "discover_tools",
    "Discover which MCP tools are available for a given task. Returns the most relevant tool names, servers, and descriptions based on your natural language query. Call this before using an unfamiliar tool to find the right one.",
    {
      query: z
        .string()
        .min(1)
        .describe(
          "Natural language description of what you want to do (e.g. 'read a file', 'search the web', 'create a pull request')",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe("Number of tools to return (default 5)"),
      category: z
        .string()
        .optional()
        .describe(
          "Optional category filter: filesystem, git, github, testing, quality, memory, research, database, execution",
        ),
    },
    async ({ query, limit, category }) => {
      try {
        const embedding = await generateEmbedding(query, embeddingConfig);
        const vector = vectorLiteral(embedding);

        const tools = await db.searchMemories(
          vector,
          0.2,
          limit ?? 5,
          "toolshed",
          category ? [category] : undefined,
        );

        if (tools.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No tools found for query: "${query}". Try a different description or remove the category filter.`,
              },
            ],
          };
        }

        const text = [
          `${tools.length} tool(s) matching "${query}":`,
          "",
          ...tools.map((t, i) => {
            const meta = t.source_metadata as Record<string, string>;
            return [
              `[${i + 1}] ${meta?.tool_name ?? "unknown"} (server: ${meta?.server ?? "unknown"})`,
              `    ${t.content.split("\n").find((l) => l.startsWith("Description:"))?.replace("Description: ", "") ?? ""}`,
              `    Match: ${((t.similarity ?? 0) * 100).toFixed(0)}%`,
            ].join("\n");
          }),
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `discover_tools failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
