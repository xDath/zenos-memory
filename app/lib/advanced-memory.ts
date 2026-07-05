import { Memory } from './schema';

export interface VectorRecord {
  id: string;
  vector: number[];
  text: string;
  metadata: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  label: string;
  type: 'entity' | 'memory' | 'topic' | 'decision' | 'credential';
  weight: number;
  first_seen?: string;
  last_seen?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'mentions' | 'related_to' | 'supersedes' | 'contradicts' | 'temporal_next' | 'credential_for' | 'derived_from' | 'source_chunk' | 'same_entity';
  weight: number;
  timestamp?: string;
  memory_id?: string;
}

export interface EvalResult {
  name: string;
  score: number;
  status: 'pass' | 'warn' | 'fail';
  details: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function deterministicEmbedding(text: string, dims = 384): number[] {
  const vector = new Array(dims).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const h = hash32(token);
    const idx = h % dims;
    const sign = (h & 1) ? 1 : -1;
    vector[idx] += sign * (1 + Math.log(1 + token.length));

    // Character n-grams improve fuzzy semantic-ish recall without external embedding APIs.
    for (let n = 3; n <= 5; n++) {
      for (let i = 0; i <= token.length - n; i++) {
        const gram = token.slice(i, i + n);
        const gh = hash32(`ng:${gram}`);
        vector[gh % dims] += ((gh & 1) ? 0.35 : -0.35);
      }
    }
  }

  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map(v => Number((v / norm).toFixed(6)));
}

export function cosineSimilarity(a: number[] = [], b: number[] = []): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

export function buildVectorIndex(memories: Memory[]): VectorRecord[] {
  return memories.map(m => ({
    id: m.id,
    text: m.content,
    vector: m.embedding?.length ? m.embedding : deterministicEmbedding(`${m.content} ${(m.metadata.tags || []).join(' ')} ${(m.metadata.entities || []).join(' ')}`),
    metadata: {
      type: m.type,
      namespace: m.namespace,
      importance: m.metadata.importance,
      confidence: m.metadata.confidence,
      tags: m.metadata.tags,
      entities: m.metadata.entities,
      updated_at: m.updated_at,
    },
  }));
}

export function vectorSearch(query: string, memories: Memory[], limit = 10) {
  const qv = deterministicEmbedding(query);
  const index = buildVectorIndex(memories);
  return index
    .map(r => ({ ...r, vector_score: cosineSimilarity(qv, r.vector) }))
    .sort((a, b) => b.vector_score - a.vector_score)
    .slice(0, limit);
}

export function extractGraphEntities(memory: Memory): string[] {
  const values = new Set<string>();
  for (const e of memory.metadata.entities || []) values.add(String(e));
  for (const tag of memory.metadata.tags || []) values.add(String(tag));

  // Extract meaningful title-cased / service-ish tokens.
  const matches = memory.content.match(/\b[A-Z][A-Za-z0-9_.-]{2,}\b|\b(vercel|github|google drive|oauth|deepseek|gemini|hermes|zenos|etla)\b/gi) || [];
  for (const m of matches) values.add(m.trim());

  return Array.from(values).filter(v => v.length > 1).slice(0, 24);
}

export function buildTemporalGraph(memories: Memory[]) {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const sorted = [...memories].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  function upsertNode(id: string, patch: Partial<GraphNode>) {
    const prev = nodes.get(id);
    if (prev) {
      prev.weight += patch.weight || 1;
      prev.last_seen = patch.last_seen || prev.last_seen;
      return prev;
    }
    const node: GraphNode = {
      id,
      label: patch.label || id,
      type: patch.type || 'entity',
      weight: patch.weight || 1,
      first_seen: patch.first_seen,
      last_seen: patch.last_seen,
    };
    nodes.set(id, node);
    return node;
  }

  let previousMemoryId = '';
  for (const memory of sorted) {
    upsertNode(memory.id, {
      label: memory.content.slice(0, 90),
      type: memory.type === 'credential' ? 'credential' : 'memory',
      weight: (memory.metadata.importance || 5) / 5,
      first_seen: memory.created_at,
      last_seen: memory.updated_at,
    });

    if (previousMemoryId) {
      edges.push({ source: previousMemoryId, target: memory.id, type: 'temporal_next', weight: 0.4, timestamp: memory.created_at });
    }
    previousMemoryId = memory.id;

    const entities = extractGraphEntities(memory);
    for (const entity of entities) {
      const entityId = `entity:${entity.toLowerCase()}`;
      upsertNode(entityId, {
        label: entity,
        type: memory.type === 'credential' ? 'credential' : 'entity',
        weight: 1,
        first_seen: memory.created_at,
        last_seen: memory.updated_at,
      });
      edges.push({ source: memory.id, target: entityId, type: 'mentions', weight: 1, timestamp: memory.created_at, memory_id: memory.id });
    }

    const sourceId = memory.metadata.provenance?.source_id || memory.metadata.source;
    if (sourceId) {
      const sourceNodeId = `source:${String(sourceId).toLowerCase()}`;
      upsertNode(sourceNodeId, {
        label: String(sourceId),
        type: 'topic',
        weight: 1.5,
        first_seen: memory.created_at,
        last_seen: memory.updated_at,
      });
      edges.push({ source: memory.id, target: sourceNodeId, type: 'derived_from', weight: 1.4, timestamp: memory.created_at, memory_id: memory.id });
    }

    if (memory.metadata.provenance?.chunk_index !== undefined && sourceId) {
      const chunkNodeId = `chunk:${String(sourceId).toLowerCase()}:${memory.metadata.provenance.chunk_index}`;
      upsertNode(chunkNodeId, {
        label: `${String(sourceId)}#${memory.metadata.provenance.chunk_index}`,
        type: 'topic',
        weight: 1.2,
        first_seen: memory.created_at,
        last_seen: memory.updated_at,
      });
      edges.push({ source: memory.id, target: chunkNodeId, type: 'source_chunk', weight: 1.2, timestamp: memory.created_at, memory_id: memory.id });
    }

    for (const related of memory.metadata.related_ids || []) {
      edges.push({ source: memory.id, target: related, type: 'related_to', weight: 0.8, timestamp: memory.updated_at, memory_id: memory.id });
    }
    for (const superseded of memory.metadata.supersedes_ids || []) {
      edges.push({ source: memory.id, target: superseded, type: 'supersedes', weight: 1.2, timestamp: memory.updated_at, memory_id: memory.id });
    }
    for (const contradiction of memory.metadata.contradictions || []) {
      edges.push({ source: memory.id, target: `entity:${contradiction.toLowerCase()}`, type: 'contradicts', weight: 1, timestamp: memory.updated_at, memory_id: memory.id });
    }
    if (memory.type === 'credential' && memory.metadata.credential_for) {
      const service = memory.metadata.credential_for;
      const serviceId = `entity:${service.toLowerCase()}`;
      upsertNode(serviceId, { label: service, type: 'credential', weight: 2, first_seen: memory.created_at, last_seen: memory.updated_at });
      edges.push({ source: memory.id, target: serviceId, type: 'credential_for', weight: 2, timestamp: memory.updated_at, memory_id: memory.id });
    }
  }

  return {
    nodes: Array.from(nodes.values()).sort((a, b) => b.weight - a.weight),
    edges: edges.sort((a, b) => b.weight - a.weight),
    stats: {
      node_count: nodes.size,
      edge_count: edges.length,
      memory_count: memories.length,
      credential_nodes: Array.from(nodes.values()).filter(n => n.type === 'credential').length,
    },
  };
}

export function evaluateMemorySystem(memories: Memory[]): EvalResult[] {
  const total = memories.length;
  const compacts = memories.filter(m => m.type === 'insight' && (m.metadata.tags || []).some(t => t.includes('compact'))).length;
  const credentials = memories.filter(m => m.type === 'credential').length;
  const withEntities = memories.filter(m => (m.metadata.entities || []).length).length;
  const withEmbedding = memories.filter(m => m.embedding?.length).length;
  const graph = buildTemporalGraph(memories);

  return [
    { name: 'memory_volume', score: Math.min(1, total / 50), status: total > 5 ? 'pass' : 'warn', details: `${total} memories stored` },
    { name: 'structured_compaction', score: Math.min(1, compacts / 3), status: compacts > 0 ? 'pass' : 'fail', details: `${compacts} compact insights found` },
    { name: 'credential_awareness', score: credentials > 0 ? 1 : 0.6, status: credentials > 0 ? 'pass' : 'warn', details: `${credentials} credential memories found` },
    { name: 'entity_coverage', score: total ? withEntities / total : 0, status: withEntities > 0 ? 'pass' : 'warn', details: `${withEntities}/${total} memories have entities` },
    { name: 'vector_readiness', score: total ? Math.max(withEmbedding / total, 0.75) : 0, status: total ? 'pass' : 'warn', details: `${withEmbedding} explicit embeddings; deterministic embeddings available for all memories` },
    { name: 'temporal_graph_density', score: Math.min(1, graph.edges.length / Math.max(1, total * 2)), status: graph.edges.length > total ? 'pass' : 'warn', details: `${graph.stats.node_count} nodes / ${graph.stats.edge_count} edges` },
  ];
}

export function productionReadiness(memories: Memory[]) {
  const evals = evaluateMemorySystem(memories);
  const score = evals.reduce((s, e) => s + e.score, 0) / Math.max(1, evals.length);
  return {
    score: Number(score.toFixed(3)),
    status: score >= 0.85 ? 'top-tier-ready' : score >= 0.7 ? 'production-ready-needs-polish' : 'needs-work',
    evals,
  };
}
