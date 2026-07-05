import { deterministicEmbedding } from './advanced-memory';

export async function getEmbedding(text: string): Promise<{ vector: number[]; provider: string; ok: boolean; error?: string }> {
  const baseUrl = (process.env.MEMORY_LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.MEMORY_LLM_API_KEY || '';
  const model = process.env.MEMORY_EMBEDDING_MODEL || 'text-embedding-3-small';

  if (baseUrl && apiKey) {
    try {
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text.slice(0, 8000) }),
      });
      const raw = await res.text();
      if (res.ok) {
        const data = JSON.parse(raw);
        const vector = data?.data?.[0]?.embedding;
        if (Array.isArray(vector) && vector.length) return { vector, provider: model, ok: true };
      }
      return { vector: deterministicEmbedding(text), provider: 'deterministic-fallback', ok: false, error: raw.slice(0, 500) };
    } catch (e: any) {
      return { vector: deterministicEmbedding(text), provider: 'deterministic-fallback', ok: false, error: e.message || String(e) };
    }
  }
  return { vector: deterministicEmbedding(text), provider: 'deterministic-fallback', ok: true };
}

export function vectorCosine(a: number[] = [], b: number[] = []) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}
