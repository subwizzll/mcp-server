// ─── DB Adapter ────────────────────────────────────────────────────────────────
// Abstracts all database operations behind a single interface so the MCP server
// can work with either Supabase (default) or a raw Postgres connection.
//
// Select the backend via DB_BACKEND env var:
//   DB_BACKEND=supabase  (default) — requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   DB_BACKEND=postgres             — requires DATABASE_URL

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";

// ─── Shared types ──────────────────────────────────────────────────────────────

export interface BrainMemory {
  id: string;
  content: string;
  source: string;
  source_metadata: Record<string, unknown>;
  tags: string[];
  created_at: string;
  similarity?: number;
}

export interface BrainStats {
  total_memories: number;
  embedded_count: number;
  pending_embedding: number;
  source_count: number;
  last_ingested_at: string | null;
}

export interface RecallOptions {
  source?: string;
  tags?: string[];
  since?: string;
  limit: number;
}

export interface MemoryInsert {
  content: string;
  embedding: string;
  source: string;
  tags: string[];
  source_metadata: Record<string, unknown>;
}

// ─── Adapter interface ─────────────────────────────────────────────────────────

export interface DbAdapter {
  /**
   * Semantic similarity search via the match_memories function.
   * filterTags is only used by the toolshed discover_tools path.
   */
  searchMemories(
    vector: string,
    threshold: number,
    limit: number,
    source?: string,
    filterTags?: string[],
  ): Promise<BrainMemory[]>;

  /** Insert a memory and return the new row's id + tags. */
  insertMemory(data: MemoryInsert): Promise<{ id: string; tags: string[] }>;

  /** Filtered list retrieval — no embedding needed. */
  recallMemories(opts: RecallOptions): Promise<BrainMemory[]>;

  deleteMemory(id: string): Promise<void>;

  /** Returns aggregated counts from the brain_stats view. */
  getStats(): Promise<BrainStats>;

  /** Returns per-source memory counts. */
  getSourceCounts(): Promise<Record<string, number>>;

  // ── Toolshed operations ──────────────────────────────────────────────────

  countBySource(source: string): Promise<number>;

  /** Idempotent insert — silently ignores (source, content) conflicts. */
  upsertMemory(data: MemoryInsert): Promise<void>;

  // ── Chat-indexer operations ──────────────────────────────────────────────

  /** Fetch source_metadata for all work_history memories (used for dedup). */
  getWorkHistoryMetadata(): Promise<Array<{ source_metadata: Record<string, unknown> }>>;
}

// ─── Supabase adapter ──────────────────────────────────────────────────────────

export class SupabaseAdapter implements DbAdapter {
  private client: SupabaseClient;

  constructor(url: string, key: string) {
    this.client = createClient(url, key);
  }

  async searchMemories(
    vector: string,
    threshold: number,
    limit: number,
    source?: string,
    filterTags?: string[],
  ): Promise<BrainMemory[]> {
    const { data, error } = await this.client.rpc("match_memories", {
      query_embedding: vector,
      match_threshold: threshold,
      match_count: limit,
      filter_source: source ?? null,
      filter_tags: filterTags ?? null,
    });
    if (error) throw error;
    return (data as BrainMemory[]) ?? [];
  }

  async insertMemory(data: MemoryInsert): Promise<{ id: string; tags: string[] }> {
    const { data: row, error } = await this.client
      .from("brain_memories")
      .insert({
        content: data.content,
        embedding: data.embedding,
        source: data.source,
        tags: data.tags,
        source_metadata: data.source_metadata,
      })
      .select("id, tags")
      .single();
    if (error) throw error;
    return { id: row.id, tags: row.tags as string[] };
  }

  async recallMemories(opts: RecallOptions): Promise<BrainMemory[]> {
    let query = this.client
      .from("brain_memories")
      .select("id, content, source, tags, created_at")
      .order("created_at", { ascending: false })
      .limit(opts.limit);

    if (opts.source) query = query.eq("source", opts.source);
    if (opts.tags && opts.tags.length > 0) query = query.overlaps("tags", opts.tags);
    if (opts.since) query = query.gte("created_at", opts.since);

    const { data, error } = await query;
    if (error) throw error;
    return (data as BrainMemory[]) ?? [];
  }

  async deleteMemory(id: string): Promise<void> {
    const { error } = await this.client.from("brain_memories").delete().eq("id", id);
    if (error) throw error;
  }

  async getStats(): Promise<BrainStats> {
    const { data, error } = await this.client.from("brain_stats").select("*").single();
    if (error) throw error;
    return data as BrainStats;
  }

  async getSourceCounts(): Promise<Record<string, number>> {
    const { data, error } = await this.client.from("brain_memories").select("source");
    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      counts[row.source] = (counts[row.source] ?? 0) + 1;
    }
    return counts;
  }

  async countBySource(source: string): Promise<number> {
    const { count } = await this.client
      .from("brain_memories")
      .select("*", { count: "exact", head: true })
      .eq("source", source);
    return count ?? 0;
  }

  async upsertMemory(data: MemoryInsert): Promise<void> {
    const { error } = await this.client.from("brain_memories").upsert(
      {
        content: data.content,
        embedding: data.embedding,
        source: data.source,
        tags: data.tags,
        source_metadata: data.source_metadata,
      },
      { onConflict: "source,content", ignoreDuplicates: true },
    );
    if (error) throw error;
  }

  async getWorkHistoryMetadata(): Promise<Array<{ source_metadata: Record<string, unknown> }>> {
    const { data } = await this.client
      .from("brain_memories")
      .select("source_metadata")
      .eq("source", "work_history");
    return (data ?? []) as Array<{ source_metadata: Record<string, unknown> }>;
  }
}

// ─── Postgres adapter ──────────────────────────────────────────────────────────

export class PostgresAdapter implements DbAdapter {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async searchMemories(
    vector: string,
    threshold: number,
    limit: number,
    source?: string,
    filterTags?: string[],
  ): Promise<BrainMemory[]> {
    const { rows } = await this.pool.query<BrainMemory>(
      "SELECT * FROM match_memories($1::halfvec, $2, $3, $4, $5)",
      [vector, threshold, limit, source ?? null, filterTags ?? null],
    );
    return rows;
  }

  async insertMemory(data: MemoryInsert): Promise<{ id: string; tags: string[] }> {
    const { rows } = await this.pool.query<{ id: string; tags: string[] }>(
      `INSERT INTO brain_memories (content, embedding, source, tags, source_metadata)
       VALUES ($1, $2::halfvec, $3, $4::text[], $5::jsonb)
       RETURNING id, tags`,
      [data.content, data.embedding, data.source, data.tags, JSON.stringify(data.source_metadata)],
    );
    return rows[0];
  }

  async recallMemories(opts: RecallOptions): Promise<BrainMemory[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (opts.source) {
      conditions.push(`source = $${i++}`);
      params.push(opts.source);
    }
    if (opts.tags && opts.tags.length > 0) {
      conditions.push(`tags && $${i++}::text[]`);
      params.push(opts.tags);
    }
    if (opts.since) {
      conditions.push(`created_at >= $${i++}`);
      params.push(opts.since);
    }
    params.push(opts.limit);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool.query<BrainMemory>(
      `SELECT id, content, source, source_metadata, tags, created_at
       FROM brain_memories
       ${where}
       ORDER BY created_at DESC
       LIMIT $${i}`,
      params,
    );
    return rows;
  }

  async deleteMemory(id: string): Promise<void> {
    await this.pool.query("DELETE FROM brain_memories WHERE id = $1", [id]);
  }

  async getStats(): Promise<BrainStats> {
    const { rows } = await this.pool.query<BrainStats>("SELECT * FROM brain_stats");
    return rows[0];
  }

  async getSourceCounts(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query<{ source: string; count: string }>(
      "SELECT source, COUNT(*)::int AS count FROM brain_memories GROUP BY source ORDER BY count DESC",
    );
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.source] = Number(row.count);
    }
    return counts;
  }

  async countBySource(source: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*)::int AS count FROM brain_memories WHERE source = $1",
      [source],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async upsertMemory(data: MemoryInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO brain_memories (content, embedding, source, tags, source_metadata)
       VALUES ($1, $2::halfvec, $3, $4::text[], $5::jsonb)
       ON CONFLICT (source, content) DO NOTHING`,
      [data.content, data.embedding, data.source, data.tags, JSON.stringify(data.source_metadata)],
    );
  }

  async getWorkHistoryMetadata(): Promise<Array<{ source_metadata: Record<string, unknown> }>> {
    const { rows } = await this.pool.query<{ source_metadata: Record<string, unknown> }>(
      "SELECT source_metadata FROM brain_memories WHERE source = $1",
      ["work_history"],
    );
    return rows;
  }
}
