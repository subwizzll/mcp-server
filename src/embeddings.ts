// ─── OpenRouter Embeddings ────────────────────────────────────────────────────
// Generates vector embeddings via OpenRouter's embeddings endpoint.
// Uses openai/text-embedding-3-small (1536 dims) by default.

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface EmbeddingConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
}

export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> {
  const model = config.model ?? "openai/text-embedding-3-small";
  const dimensions = config.dimensions ?? 1536;

  const response = await fetch(`${OPENROUTER_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: text, dimensions }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter embedding error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  return data.data[0].embedding;
}

// Format a number[] as the Postgres vector literal "[x,y,...]"
export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
