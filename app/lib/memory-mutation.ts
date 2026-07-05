import { Memory } from './schema';

type MutationPlan = {
  supersedes_ids: string[];
  contradictions: string[];
  related_ids: string[];
  valid_from: string;
  reason: string;
};

const STATE_WORDS = ['status', 'ready', 'done', 'selesai', 'aktif', 'hapus', 'deleted', 'removed', 'production', 'local repo', 'deploy'];
const NEGATIVE_WORDS = ['not', 'never', 'tidak', 'bukan', 'jangan', 'deleted', 'removed', 'hapus', 'gagal'];
const POSITIVE_WORDS = ['ready', 'active', 'aktif', 'done', 'selesai', 'success', 'berhasil', 'ada'];

function normalize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(t => t.length > 2);
}

function overlap(a: string, b: string): number {
  const aa = new Set(normalize(a));
  const bb = new Set(normalize(b));
  if (!aa.size || !bb.size) return 0;
  let hits = 0;
  for (const item of aa) if (bb.has(item)) hits += 1;
  return hits / Math.max(aa.size, bb.size);
}

function polarity(text: string): number {
  const lower = text.toLowerCase();
  const neg = NEGATIVE_WORDS.some(word => lower.includes(word));
  const pos = POSITIVE_WORDS.some(word => lower.includes(word));
  if (neg && !pos) return -1;
  if (pos && !neg) return 1;
  return 0;
}

function isStateful(text: string): boolean {
  const lower = text.toLowerCase();
  return STATE_WORDS.some(word => lower.includes(word));
}

export function buildMutationPlan(newContent: string, candidates: Memory[]): MutationPlan {
  const supersedes_ids: string[] = [];
  const contradictions: string[] = [];
  const related_ids: string[] = [];
  const newPolarity = polarity(newContent);

  for (const memory of candidates) {
    const score = overlap(newContent, memory.content);
    if (score < 0.18) continue;
    related_ids.push(memory.id);
    const oldPolarity = polarity(memory.content);
    const stateChange = isStateful(newContent) && isStateful(memory.content) && score >= 0.28;
    if (stateChange || (newPolarity !== 0 && oldPolarity !== 0 && newPolarity !== oldPolarity)) {
      supersedes_ids.push(memory.id);
      contradictions.push(memory.id);
    }
  }

  return {
    supersedes_ids: [...new Set(supersedes_ids)].slice(0, 8),
    contradictions: [...new Set(contradictions)].slice(0, 8),
    related_ids: [...new Set(related_ids)].slice(0, 12),
    valid_from: new Date().toISOString(),
    reason: supersedes_ids.length ? 'state-change-or-contradiction' : related_ids.length ? 'related-memory-linking' : 'new-independent-memory',
  };
}

export function markSuperseded(memories: Memory[], supersededIds: string[], validTo: string): boolean {
  let changed = false;
  for (const memory of memories) {
    if (!supersededIds.includes(memory.id)) continue;
    memory.metadata.provenance = { ...(memory.metadata.provenance || {}), valid_to: memory.metadata.provenance?.valid_to || validTo };
    memory.metadata.tags = [...new Set([...(memory.metadata.tags || []), 'superseded'])];
    memory.updated_at = validTo;
    changed = true;
  }
  return changed;
}
