// ─── Cursor Chat Indexer ──────────────────────────────────────────────────────
// Reads Cursor agent transcript JSONL files and indexes them as searchable
// memories in the Open Brain (Supabase brain_memories table).
//
// Each transcript dir contains: <uuid>/<uuid>.jsonl
// Each line in the JSONL is: { role: "user" | "assistant", message: { content: [...] } }
//
// Indexed memories use source="work_history" with source_metadata.transcript_id
// so re-indexing is idempotent (already-indexed transcripts are skipped).

import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  generateEmbedding,
  vectorLiteral,
  type EmbeddingConfig,
} from "./embeddings.js";

export const WORK_HISTORY_SOURCE = "work_history";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface TranscriptLine {
  role: "user" | "assistant";
  message: {
    content: ContentBlock[];
  };
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  errors: string[];
  total: number;
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function extractText(message: TranscriptLine["message"]): string {
  return (message?.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n")
    .trim();
}

/** Strip XML/HTML-like tags and collapse whitespace */
function sanitize(text: string, maxLen: number): string {
  return text
    .replace(/<[^>]{1,200}>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

// ─── Deduplication ───────────────────────────────────────────────────────────

async function getIndexedIds(supabase: SupabaseClient): Promise<Set<string>> {
  const { data } = await supabase
    .from("brain_memories")
    .select("source_metadata")
    .eq("source", WORK_HISTORY_SOURCE);

  const ids = new Set<string>();
  for (const row of data ?? []) {
    const meta = row.source_metadata as Record<string, string>;
    if (meta?.transcript_id) ids.add(meta.transcript_id);
  }
  return ids;
}

// ─── Core indexer ─────────────────────────────────────────────────────────────

export async function indexCursorChats(
  transcriptsDir: string,
  supabase: SupabaseClient,
  embeddingConfig: EmbeddingConfig,
  options: { force?: boolean; limit?: number } = {},
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, skipped: 0, errors: [], total: 0 };

  const alreadyIndexed = options.force
    ? new Set<string>()
    : await getIndexedIds(supabase);

  let dirs: string[];
  try {
    dirs = await readdir(transcriptsDir);
  } catch (err) {
    result.errors.push(
      `Cannot read transcripts dir "${transcriptsDir}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  // Sort by name (which reflects creation order for UUIDs with timestamps)
  dirs.sort();
  if (options.limit) dirs = dirs.slice(-options.limit); // most recent N
  result.total = dirs.length;

  for (const dir of dirs) {
    if (alreadyIndexed.has(dir)) {
      result.skipped++;
      continue;
    }

    const transcriptPath = join(transcriptsDir, dir, `${dir}.jsonl`);

    try {
      const raw = await readFile(transcriptPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const messages: TranscriptLine[] = lines.map((l) => JSON.parse(l));

      // First user message gives us the task/goal
      const firstUser = messages.find((m) => m.role === "user");
      const firstUserText = firstUser ? extractText(firstUser.message) : "";
      if (!firstUserText) {
        result.skipped++;
        continue;
      }

      // File mtime as the session date
      const fileStat = await stat(transcriptPath);
      const dateStr = fileStat.mtime.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });

      // Grab up to 2 substantive assistant text responses for context
      const assistantExcerpt = messages
        .filter((m) => m.role === "assistant")
        .map((m) => extractText(m.message))
        .filter((t) => t.length > 80)
        .slice(0, 2)
        .join(" ")
        .slice(0, 500);

      const task = sanitize(firstUserText, 700);
      const approach = sanitize(assistantExcerpt, 400);

      const content = [
        `Cursor work session (${dateStr}):`,
        `Task: ${task}`,
        approach ? `Approach: ${approach}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const embedding = await generateEmbedding(content, embeddingConfig);
      const vector = vectorLiteral(embedding);

      const { error } = await supabase.from("brain_memories").insert({
        content,
        embedding: vector,
        source: WORK_HISTORY_SOURCE,
        tags: ["cursor", "work-session"],
        source_metadata: {
          transcript_id: dir,
          transcript_path: transcriptPath,
          date: fileStat.mtime.toISOString(),
          message_count: String(messages.length),
        },
      });

      if (error) {
        result.errors.push(`${dir}: ${error.message}`);
      } else {
        result.indexed++;
      }
    } catch (err) {
      result.errors.push(
        `${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// ─── Full-text search through raw transcripts ─────────────────────────────────
// For when you want keyword search without going through the brain vector store.

export interface TranscriptSearchResult {
  transcript_id: string;
  date: string;
  matches: Array<{ role: string; excerpt: string }>;
}

export async function searchTranscriptsRaw(
  transcriptsDir: string,
  query: string,
  limit = 5,
): Promise<TranscriptSearchResult[]> {
  const queryLower = query.toLowerCase();
  const results: TranscriptSearchResult[] = [];

  let dirs: string[];
  try {
    dirs = await readdir(transcriptsDir);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    const transcriptPath = join(transcriptsDir, dir, `${dir}.jsonl`);
    try {
      const raw = await readFile(transcriptPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const messages: TranscriptLine[] = lines.map((l) => JSON.parse(l));
      const fileStat = await stat(transcriptPath);

      const matches: TranscriptSearchResult["matches"] = [];
      for (const msg of messages) {
        const text = extractText(msg.message);
        if (text.toLowerCase().includes(queryLower)) {
          // Return a snippet around the match
          const idx = text.toLowerCase().indexOf(queryLower);
          const start = Math.max(0, idx - 80);
          const end = Math.min(text.length, idx + query.length + 200);
          matches.push({
            role: msg.role,
            excerpt: "…" + text.slice(start, end).replace(/\s+/g, " ") + "…",
          });
        }
      }

      if (matches.length > 0) {
        results.push({
          transcript_id: dir,
          date: fileStat.mtime.toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
          matches: matches.slice(0, 3),
        });
      }
    } catch {
      // skip unreadable files
    }
  }

  // Most recent first (sort by dir name, which includes timestamp info)
  results.sort((a, b) => b.transcript_id.localeCompare(a.transcript_id));
  return results.slice(0, limit);
}
