import { deterministicEmbedding } from './advanced-memory';

interface EmbeddingEnvelope {
  data?: Array<{ embedding?: unknown }>;
}

export async function getEmbedding(text: string): Promise<{ vector: number[]; provider: string; ok: boolean; error?: string }> {
  const baseUrl = (process.env.MEMORY_EMBEDDING_BASE_URL || process.env.MEMORY_LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.MEMORY_EMBEDDING_API_KEY || process.env.MEMORY_LLM_API_KEY || '';
  const model = process.env.MEMORY_EMBEDDING_MODEL || '';
  const fallback = () => deterministicEmbedding(text);

  if (!baseUrl || !apiKey || !model) {
    return { vector: fallback(), provider: 'deterministic-hashed-baseline', ok: true };
  }

  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: text.slice(0, 16_000) }),
      signal: AbortSignal.timeout(Math.max(5_000, Math.min(Number(process.env.MEMORY_EMBEDDING_TIMEOUT_MS || 30_000), 90_000))),
      cache: 'no-store',
    });
    if (!response.ok) {
      return { vector: fallback(), provider: 'deterministic-hashed-fallback', ok: false, error: `Embedding provider HTTP ${response.status}` };
    }
    const data = await response.json() as EmbeddingEnvelope;
    const candidate = data.data?.[0]?.embedding;
    if (!Array.isArray(candidate) || candidate.length < 8 || !candidate.every(value => typeof value === 'number' && Number.isFinite(value))) {
      return { vector: fallback(), provider: 'deterministic-hashed-fallback', ok: false, error: 'Embedding provider returned an invalid vector' };
    }
    return { vector: candidate as number[], provider: model, ok: true };
  } catch (error) {
    return {
      vector: fallback(),
      provider: 'deterministic-hashed-fallback',
      ok: false,
      error: error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        ? 'Embedding request timed out'
        : 'Embedding request failed',
    };
  }
}

export function vectorCosine(left: number[] = [], right: number[] = []): number {
  const length = Math.min(left.length, right.length);
  if (!length) return 0;
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    normLeft += left[index] * left[index];
    normRight += right[index] * right[index];
  }
  return dot / ((Math.sqrt(normLeft) * Math.sqrt(normRight)) || 1);
}
