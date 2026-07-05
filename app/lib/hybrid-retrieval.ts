import { Memory } from './schema';
import { buildTemporalGraph, deterministicEmbedding, cosineSimilarity } from './advanced-memory';

type HybridScore = {
  memory: Memory;
  score: number;
  reason: string;
  signals: {
    vector: number;
    keyword: number;
    graph: number;
    recency: number;
    importance: number;
    confidence: number;
    current: number;
  };
};

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'yang', 'dan', 'atau', 'ini', 'itu', 'dari', 'untuk', 'gue', 'lu']);

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function keywordScore(query: string, text: string): number {
  const q = new Set(tokens(query));
  if (!q.size) return 0;
  const body = new Set(tokens(text));
  let hits = 0;
  for (const item of q) if (body.has(item)) hits += 1;
  return hits / q.size;
}

function recencyScore(memory: Memory): number {
  const ageDays = (Date.now() - new Date(memory.updated_at || memory.created_at).getTime()) / (1000 * 3600 * 24);
  return Math.max(0, 1 - (ageDays / 45));
}

function isCurrent(memory: Memory, supersededIds: Set<string>): number {
  if (supersededIds.has(memory.id)) return 0;
  if (memory.metadata.provenance?.valid_to) return 0.2;
  return 1;
}

function graphBoost(query: string, memory: Memory, all: Memory[]): number {
  const queryTokens = new Set(tokens(query));
  if (!queryTokens.size) return 0;
  const graph = buildTemporalGraph(all);
  const mentioned = new Set<string>();
  for (const node of graph.nodes) {
    if (tokens(node.label).some(t => queryTokens.has(t))) mentioned.add(node.id);
  }
  if (!mentioned.size) return 0;
  const edges = graph.edges.filter(edge => edge.memory_id === memory.id || edge.source === memory.id || edge.target === memory.id);
  const connected = edges.some(edge => mentioned.has(edge.source) || mentioned.has(edge.target));
  return connected ? Math.min(1, edges.length / 6) : 0;
}

export function rankHybrid(query: string, memories: Memory[], limit = 10): HybridScore[] {
  const qv = deterministicEmbedding(query);
  const supersededIds = new Set(memories.flatMap(memory => memory.metadata.supersedes_ids || []));

  return memories
    .map(memory => {
      const text = `${memory.content} ${(memory.metadata.tags || []).join(' ')} ${(memory.metadata.entities || []).join(' ')}`;
      const vector = cosineSimilarity(qv, memory.embedding?.length ? memory.embedding : deterministicEmbedding(text));
      const keyword = keywordScore(query, text);
      const graph = graphBoost(query, memory, memories);
      const recency = recencyScore(memory);
      const importance = (memory.metadata.importance || 5) / 10;
      const confidence = memory.metadata.confidence || 0.8;
      const current = isCurrent(memory, supersededIds);
      const score = (vector * 36) + (keyword * 24) + (graph * 16) + (importance * 10) + (confidence * 8) + (recency * 4) + (current * 12);
      const reason = current < 1 ? 'superseded-or-expired' : graph > 0.2 ? 'graph-vector-keyword' : keyword > 0.4 ? 'keyword-vector' : 'hybrid-vector';
      return { memory, score, reason, signals: { vector, keyword, graph, recency, importance, confidence, current } };
    })
    .filter(item => item.signals.current > 0 || query.trim() === '')
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
