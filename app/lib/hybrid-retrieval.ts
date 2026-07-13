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
    fusion: number;
    recency: number;
    importance: number;
    confidence: number;
    current: number;
  };
};

export type QueryEmbedding = {
  vector: number[];
  space: string;
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

function lexicalScores(query: string, texts: string[]): number[] {
  const queryTokens = [...new Set(tokens(query))];
  if (!queryTokens.length) return texts.map(() => 0);
  const documents = texts.map(text => tokens(text));
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length);
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of new Set(document)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const raw = documents.map((document, index) => {
    const frequencies = new Map<string, number>();
    for (const token of document) frequencies.set(token, (frequencies.get(token) || 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) || 0;
      if (!frequency) continue;
      const seenIn = documentFrequency.get(token) || 0;
      const inverseDocumentFrequency = Math.log(1 + (documents.length - seenIn + 0.5) / (seenIn + 0.5));
      const denominator = frequency + 1.2 * (0.25 + 0.75 * document.length / Math.max(1, averageLength));
      score += inverseDocumentFrequency * ((frequency * 2.2) / denominator);
    }
    if (texts[index].toLowerCase().includes(query.trim().toLowerCase())) score += 1.5;
    return score;
  });
  const maximum = Math.max(...raw, 0);
  return raw.map(score => maximum ? score / maximum : 0);
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

function lexicalSimilarity(left: Memory, right: Memory): number {
  const leftTokens = new Set(tokens(`${left.content} ${(left.metadata.tags || []).join(' ')}`));
  const rightTokens = new Set(tokens(`${right.content} ${(right.metadata.tags || []).join(' ')}`));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function diversify(ranked: HybridScore[], limit: number): HybridScore[] {
  const remaining = [...ranked];
  const selected: HybridScore[] = [];
  const maximumScore = Math.max(...remaining.map((item) => item.score), 1);
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const redundancy = selected.length
        ? Math.max(...selected.map((item) => lexicalSimilarity(candidate.memory, item.memory)))
        : 0;
      const value = (candidate.score / maximumScore) * 0.78 - redundancy * 0.22;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    const duplicate = selected.some((item) => lexicalSimilarity(chosen.memory, item.memory) >= 0.9);
    if (!duplicate) selected.push(chosen);
  }
  return selected;
}

function ranks(values: number[]): number[] {
  const ordered = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => right.value - left.value || left.index - right.index);
  const result = new Array<number>(values.length);
  ordered.forEach((item, index) => { result[item.index] = index + 1; });
  return result;
}

export function rankHybrid(
  query: string,
  memories: Memory[],
  limit = 10,
  queryEmbedding?: QueryEmbedding,
): HybridScore[] {
  if (!memories.length) return [];
  const fallbackQueryVector = deterministicEmbedding(query);
  const graph = graphScores(query, memories);
  const emptyQuery = !query.trim();
  const texts = memories.map(memory => `${memory.content} ${memory.metadata.tags.join(' ')} ${(memory.metadata.entities || []).join(' ')}`);
  const keywordScores = emptyQuery ? memories.map(() => 0) : lexicalScores(query, texts);

  const candidates = memories.map((memory, index) => {
    const text = texts[index];
    const sameDenseSpace = Boolean(
      queryEmbedding
      && memory.embedding?.length
      && memory.embedding.length === queryEmbedding.vector.length
      && memory.metadata.embedding_space === queryEmbedding.space,
    );
    const vector = emptyQuery
      ? 0
      : Math.max(0, cosineSimilarity(
          sameDenseSpace ? queryEmbedding!.vector : fallbackQueryVector,
          sameDenseSpace ? memory.embedding! : deterministicEmbedding(text),
        ));
    return {
      memory,
      vector,
      keyword: keywordScores[index],
      graph: graph.get(memory.id) || 0,
      recency: recencyScore(memory),
      importance: (memory.metadata.importance || 5) / 10,
      confidence: memory.metadata.confidence || 0.8,
      current: currentScore(memory),
      semanticMode: sameDenseSpace ? 'dense' : 'deterministic',
    };
  });

  const vectorRanks = ranks(candidates.map(item => item.vector));
  const keywordRanks = ranks(candidates.map(item => item.keyword));
  const graphRanks = ranks(candidates.map(item => item.graph));
  const rawFusion = candidates.map((item, index) => (
    (item.vector > 0 ? 0.55 / (60 + vectorRanks[index]) : 0)
    + (item.keyword > 0 ? 0.3 / (60 + keywordRanks[index]) : 0)
    + (item.graph > 0 ? 0.15 / (60 + graphRanks[index]) : 0)
  ));
  const maximumFusion = Math.max(...rawFusion, 0);

  const ranked = candidates
    .map((item, index) => {
      const { memory, vector, keyword, graph: graphSignal, recency, importance, confidence, current } = item;
      const fusion = maximumFusion ? rawFusion[index] / maximumFusion : 0;
      const score = emptyQuery
        ? importance * 30 + confidence * 25 + recency * 20 + current * 25
        : fusion * 48 + vector * 16 + keyword * 12 + graphSignal * 8 + importance * 5 + confidence * 4 + recency * 3 + current * 4;
      const reason = current === 0
        ? 'superseded-or-expired'
        : graphSignal >= 0.25
          ? `${item.semanticMode}-sparse-graph-rrf`
          : keyword >= 0.5
            ? `${item.semanticMode}-sparse-rrf`
            : `${item.semanticMode}-quality-rrf`;
      return {
        memory,
        score,
        reason,
        signals: { vector, keyword, graph: graphSignal, fusion, recency, importance, confidence, current },
      };
    })
    .filter(item => item.signals.current > 0 || emptyQuery)
    .sort((left, right) => right.score - left.score);
  return diversify(ranked, Math.max(1, Math.min(limit, 100)));
}
