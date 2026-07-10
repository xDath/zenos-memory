import { buildTemporalGraph, cosineSimilarity, deterministicEmbedding } from './advanced-memory';
import { Memory } from './schema';

export type HybridScore = {
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

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this',
  'yang', 'dan', 'atau', 'ini', 'itu', 'dari', 'untuk', 'gue', 'lu',
]);

function tokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

function keywordScore(query: string, text: string): number {
  const queryTokens = new Set(tokens(query));
  if (!queryTokens.size) return 0;
  const bodyTokens = new Set(tokens(text));
  let hits = 0;
  for (const token of queryTokens) if (bodyTokens.has(token)) hits += 1;
  return hits / queryTokens.size;
}

function recencyScore(memory: Memory): number {
  const timestamp = new Date(memory.updated_at || memory.created_at).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.max(0, 1 - ageDays / 120);
}

function currentScore(memory: Memory): number {
  if (memory.metadata.status === 'superseded') return 0;
  if (memory.metadata.status === 'archived') return 0.1;
  if (memory.metadata.provenance?.valid_to) return 0.2;
  if (memory.metadata.expires_at && new Date(memory.metadata.expires_at).getTime() <= Date.now()) return 0;
  return 1;
}

function graphScores(query: string, memories: Memory[]): Map<string, number> {
  const queryTokens = new Set(tokens(query));
  const result = new Map<string, number>();
  if (!queryTokens.size || !memories.length) return result;

  const graph = buildTemporalGraph(memories);
  const matchedNodes = new Set(
    graph.nodes
      .filter(node => tokens(node.label).some(token => queryTokens.has(token)))
      .map(node => node.id),
  );
  if (!matchedNodes.size) return result;

  for (const edge of graph.edges) {
    if (!matchedNodes.has(edge.source) && !matchedNodes.has(edge.target)) continue;
    for (const candidate of [edge.memory_id, edge.source, edge.target]) {
      if (!candidate || !memories.some(memory => memory.id === candidate)) continue;
      result.set(candidate, Math.min(1, (result.get(candidate) || 0) + edge.weight / 6));
    }
  }
  return result;
}

export function rankHybrid(query: string, memories: Memory[], limit = 10): HybridScore[] {
  if (!memories.length) return [];
  const queryVector = deterministicEmbedding(query);
  const graph = graphScores(query, memories);
  const emptyQuery = !query.trim();

  return memories
    .map(memory => {
      const text = `${memory.content} ${memory.metadata.tags.join(' ')} ${(memory.metadata.entities || []).join(' ')}`;
      const vector = emptyQuery
        ? 0
        : cosineSimilarity(queryVector, memory.embedding?.length ? memory.embedding : deterministicEmbedding(text));
      const keyword = emptyQuery ? 0 : keywordScore(query, text);
      const graphSignal = graph.get(memory.id) || 0;
      const recency = recencyScore(memory);
      const importance = (memory.metadata.importance || 5) / 10;
      const confidence = memory.metadata.confidence || 0.8;
      const current = currentScore(memory);
      const score = emptyQuery
        ? importance * 30 + confidence * 25 + recency * 20 + current * 25
        : vector * 34 + keyword * 28 + graphSignal * 14 + importance * 8 + confidence * 7 + recency * 4 + current * 12;
      const reason = current === 0
        ? 'superseded-or-expired'
        : graphSignal >= 0.25
          ? 'fts-vector-graph'
          : keyword >= 0.5
            ? 'fts-keyword-vector'
            : 'fts-vector-quality';
      return {
        memory,
        score,
        reason,
        signals: { vector, keyword, graph: graphSignal, recency, importance, confidence, current },
      };
    })
    .filter(item => item.signals.current > 0 || emptyQuery)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(limit, 100)));
}
