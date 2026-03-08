# Open Brain MCP Server

A personal semantic knowledge base exposed as MCP tools. Store, search, and retrieve memories using natural language across Cursor, Claude Desktop, or any MCP-compatible client.

## Tools

| Tool | Description |
|---|---|
| `search_brain` | Semantic similarity search across all memories |
| `add_memory` | Embed and store a new piece of knowledge |
| `recall` | Filtered list retrieval by source, tags, or date — no embedding needed |
| `forget` | Delete a memory by UUID |
| `brain_stats` | Counts and breakdown by source |
| `discover_tools` | Semantic search across the tool registry (Toolshed) |
| `index_cursor_chats` | Index Cursor agent transcripts as searchable work history |
| `search_work_history` | Keyword search across raw Cursor transcript files |

---

## Setup

```bash
cd mcp-server
npm install
cp .env.example .env
# edit .env with your credentials
```

---

## Configuration

All configuration is via environment variables in `.env`.

### Required (always)

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | Used to generate embeddings via OpenRouter |

### Database backend

The server supports two database backends. Set `DB_BACKEND` to choose (default: `supabase`).

#### Supabase (default)

```env
DB_BACKEND=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

#### Raw Postgres

Point the server at any Postgres instance with the `pgvector` extension and the `brain_memories` schema applied.

```env
DB_BACKEND=postgres
DATABASE_URL=postgresql://user:password@host:5432/dbname
```

> Both backends use the same schema and the same `match_memories` SQL function. See [Database Schema](#database-schema) below.

### Optional

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | OpenRouter embedding model |
| `EMBEDDING_DIMENSIONS` | `1536` | Must match the model output and schema |
| `MCP_HTTP_PORT` | `3100` | Port for the HTTP/SSE transport |
| `CURSOR_TRANSCRIPTS_DIR` | — | Path to Cursor agent-transcripts directory; enables `index_cursor_chats` and `search_work_history` |

---

## Running

### stdio transport (Cursor / Claude Desktop)

```bash
npm run dev:stdio       # development (tsx)
npm run start:stdio     # production (compiled JS)
```

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "open-brain": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-server/src/stdio.ts"],
      "env": {
        "DB_BACKEND": "supabase",
        "SUPABASE_URL": "...",
        "SUPABASE_SERVICE_ROLE_KEY": "...",
        "OPENROUTER_API_KEY": "..."
      }
    }
  }
}
```

To use raw Postgres instead, swap the env block:

```json
{
  "env": {
    "DB_BACKEND": "postgres",
    "DATABASE_URL": "postgresql://user:pass@host:5432/dbname",
    "OPENROUTER_API_KEY": "..."
  }
}
```

### HTTP / SSE transport (network-accessible)

```bash
npm run dev:http        # development
npm run start:http      # production
```

Endpoints:

| Endpoint | Description |
|---|---|
| `GET /sse` | SSE stream (MCP SSE transport) |
| `POST /messages` | MCP message handling |
| `GET /health` | Health check |

---

## Database Schema

Both backends require the following on the Postgres instance:

- `pgvector` extension (for `halfvec` type)
- `brain_memories` table
- `match_memories` SQL function
- `brain_stats` view

Schema is managed via the migrations in `supabase/migrations/`. For a raw Postgres instance, run the migration files in order against your database:

```
001_initial_schema.sql
002_open_brain.sql
003_brain_rls.sql
004_vector_halfvec.sql
005_uuid_default.sql
006_storage_fillfactor.sql
007_column_reorder.sql
```

### brain_memories table

```sql
CREATE TABLE brain_memories (
  id              uuid          NOT NULL DEFAULT gen_random_uuid(),
  created_at      timestamptz            DEFAULT NOW(),
  updated_at      timestamptz            DEFAULT NOW(),
  source          text          NOT NULL DEFAULT 'manual',
  content         text          NOT NULL,
  tags            text[]                 DEFAULT '{}',
  source_metadata jsonb                  DEFAULT '{}',
  embedding       halfvec(1536)
);
```

Valid `source` values: `manual`, `telegram`, `cursor`, `api`, `conversations`, `knowledge`, `work_history`, `toolshed`.

---

## Toolshed

The Toolshed (`discover_tools`) solves the "tool explosion" problem. Instead of injecting hundreds of MCP tool schemas into the agent context, the agent calls `discover_tools` with a natural language query and gets back only the tools relevant to the current task.

Tool descriptions are loaded from `tool-registry.json` and embedded into `brain_memories` (source `toolshed`) at startup. Indexing is idempotent.

---

## Work History Indexing

When `CURSOR_TRANSCRIPTS_DIR` is set, two additional tools are enabled:

- **`index_cursor_chats`** — reads JSONL transcript files from the directory, embeds each session summary, and stores it as a `work_history` memory. Re-running is idempotent (already-indexed sessions are skipped).
- **`search_work_history`** — keyword search across raw transcript files for exact phrase matching. Complements the semantic `search_brain`.

```env
CURSOR_TRANSCRIPTS_DIR=/Users/you/.cursor/projects/.../agent-transcripts
```

---

## Development

```bash
npm run build           # compile TypeScript to dist/
npm run dev:stdio       # run stdio server with tsx (hot reload)
npm run dev:http        # run HTTP server with tsx (hot reload)
```
