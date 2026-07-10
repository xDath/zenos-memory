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
  type: 'entity' | 'memory' | 'topic' | 'source' | 'chunk';
  weight: number;
  first_seen?: string;
  last_seen?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'mentions' | 'related_to' | 'supersedes' | 'contradicts' | 'temporal_next' | 'derived_from' | 'source_chunk' | 'same_entity';
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
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function hash32(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deterministicEmbedding(text: string, dimensions = 384): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const hash = hash32(token);
    vector[hash % dimensions] += (hash & 1 ? 1 : -1) * (1 + Math.log1p(token.length));
    for (let size = 3; size <= 5; size += 1) {
      for (let index = 0; index <= token.length - size; index += 1) {
        const gramHash = hash32(`ng:${token.slice(index, index + size)}`);
        vector[gramHash % dimensions] += gramHash & 1 ? 0.3 : -0.3;
      }
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => Number((value / norm).toFixed(6)));
}

export function cosineSimilarity(left: number[] = [], right: number[] = []): number {
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

export function buildVectorIndex(memories: Memory[]): VectorRecord[] {
  return memories.map(memory => ({
    id: memory.id,
    text: memory.content,
    vector: memory.embedding?.length
      ? memory.embedding
      : deterministicEmbedding(`${memory.content} ${memory.metadata.tags.join(' ')} ${(memory.metadata.entities || []).join(' ')}`),
    metadata: {
      type: memory.type,
      namespace: memory.namespace,
      importance: memory.metadata.importance,
      confidence: memory.metadata.confidence,
      status: memory.metadata.status,
      tags: memory.metadata.tags,
      entities: memory.metadata.entities,
      updated_at: memory.updated_at,
    },
  }));
}

export function vectorSearch(query: string, memories: Memory[], limit = 10) {
  const queryVector = deterministicEmbedding(query);
  return buildVectorIndex(memories)
    .map(record => ({ ...record, vector_score: cosineSimilarity(queryVector, record.vector) }))
    .sort((left, right) => right.vector_score - left.vector_score)
    .slice(0, limit);
}

export function extractGraphEntities(memory: Memory): string[] {
  const values = new Set<string>();
  for (const entity of memory.metadata.entities || []) values.add(String(entity).trim());
  const matches = memory.content.match(/\b[A-Z][A-Za-z0-9_.-]{2,}\b|\b(?:github|vercel|google drive|oauth|hermes|zenos|etla|telegram|whatsapp|codex)\b/gi) || [];
  for (const match of matches) values.add(match.trim());
  return [...values].filter(value => value.length > 1).slice(0, 48);
}

export function buildTemporalGraph(memories: Memory[]) {
  const safeMemories = memories.filter(memory => memory.type !== 'credential' && memory.type !== 'secret_reference');
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const entityTimeline = new Map<string, string>();

  const upsertNode = (id: string, patch: Omit<GraphNode, 'id'>): void => {
    const current = nodes.get(id);
    if (current) {
      current.weight += patch.weight;
      current.first_seen = current.first_seen && patch.first_seen
        ? (current.first_seen < patch.first_seen ? current.first_seen : patch.first_seen)
        : current.first_seen || patch.first_seen;
      current.last_seen = current.last_seen && patch.last_seen
        ? (current.last_seen > patch.last_seen ? current.last_seen : patch.last_seen)
        : current.last_seen || patch.last_seen;
      return;
    }
    nodes.set(id, { id, ...patch });
  };

  const sorted = [...safeMemories].sort((left, right) => left.created_at.localeCompare(right.created_at));
  for (const memory of sorted) {
    upsertNode(memory.id, {
      label: memory.content.slice(0, 100),
      type: 'memory',
      weight: Math.max(0.5, (memory.metadata.importance || 5) / 5),
      first_seen: memory.created_at,
      last_seen: memory.updated_at,
    });

    for (const entity of extractGraphEntities(memory)) {
      const entityId = `entity:${entity.toLowerCase()}`;
      upsertNode(entityId, {
        label: entity,
        type: 'entity',
        weight: 1,
        first_seen: memory.created_at,
        last_seen: memory.updated_at,
      });
      edges.push({ source: memory.id, target: entityId, type: 'mentions', weight: 1, timestamp: memory.created_at, memory_id: memory.id });
      const previous = entityTimeline.get(entityId);
      if (previous && previous !== memory.id) {
        edges.push({ source: previous, target: memory.id, type: 'temporal_next', weight: 0.65, timestamp: memory.created_at, memory_id: memory.id });
      }
      entityTimeline.set(entityId, memory.id);
    }

    const sourceId = memory.metadata.provenance?.source_id || memory.metadata.source;
    if (sourceId) {
      const nodeId = `source:${String(sourceId).toLowerCase()}`;
      upsertNode(nodeId, {
        label: String(sourceId),
        type: 'source',
        weight: 1,
        first_seen: memory.created_at,
        last_seen: memory.updated_at,
      });
      edges.push({ source: memory.id, target: nodeId, type: 'derived_from', weight: 1.2, timestamp: memory.created_at, memory_id: memory.id });
    }

    if (sourceId && memory.metadata.provenance?.chunk_index !== undefined) {
      const chunkId = `chunk:${String(sourceId).toLowerCase()}:${memory.metadata.provenance.chunk_index}`;
      upsertNode(chunkId, {
        label: `${String(sourceId)}#${memory.metadata.provenance.chunk_index}`,
        type: 'chunk',
        weight: 1,
        first_seen: memory.created_at,
        last_seen: memory.updated_at,
      });
      edges.push({ source: memory.id, target: chunkId, type: 'source_chunk', weight: 1, timestamp: memory.created_at, memory_id: memory.id });
    }

    for (const target of memory.metadata.related_ids || []) {
      edges.push({ source: memory.id, target, type: 'related_to', weight: 0.9, timestamp: memory.updated_at, memory_id: memory.id });
    }
    for (const target of memory.metadata.supersedes_ids || []) {
      edges.push({ source: memory.id, target, type: 'supersedes', weight: 1.5, timestamp: memory.updated_at, memory_id: memory.id });
    }
    for (const contradiction of memory.metadata.contradictions || []) {
      const target = contradiction.match(/^[0-9a-f-]{36}$/i) ? contradiction : `entity:${contradiction.toLowerCase()}`;
      edges.push({ source: memory.id, target, type: 'contradicts', weight: 1.2, timestamp: memory.updated_at, memory_id: memory.id });
    }
  }

  const dedupedEdges = [...new Map(edges.map(edge => [
    `${edge.source}|${edge.target}|${edge.type}`,
    edge,
  ])).values()];

  return {
    nodes: [...nodes.values()].sort((left, right) => right.weight - left.weight),
    edges: dedupedEdges.sort((left, right) => right.weight - left.weight),
    stats: {
      node_count: nodes.size,
      edge_count: dedupedEdges.length,
      memory_count: safeMemories.length,
      entity_count: [...nodes.values()].filter(node => node.type === 'entity').length,
      source_count: [...nodes.values()].filter(node => node.type === 'source').length,
    },
  };
}

export function evaluateMemorySystem(memories: Memory[]): EvalResult[] {
  const safe = memories.filter(memory => memory.type !== 'credential' && memory.type !== 'secret_reference');
  const total = safe.length;
  const active = safe.filter(memory => memory.metadata.status === 'active').length;
  const withProvenance = safe.filter(memory => Boolean(memory.metadata.provenance?.source_id || memory.metadata.source)).length;
  const withEntities = safe.filter(memory => (memory.metadata.entities || []).length > 0).length;
  const withExplicitRelations = safe.filter(memory => (memory.metadata.related_ids || []).length + (memory.metadata.supersedes_ids || []).length > 0).length;
  const graph = buildTemporalGraph(safe);
  return [
    {
      name: 'schema_integrity',
      score: total ? 1 : 0,
      status: total ? 'pass' : 'warn',
      details: `${total} validated non-secret memories`,
    },
    {
      name: 'active_ratio',
      score: total ? active / total : 0,
      status: total && active / total >= 0.6 ? 'pass' : 'warn',
      details: `${active}/${total} memories are active`,
    },
    {
      name: 'provenance_coverage',
      score: total ? withProvenance / total : 0,
      status: total && withProvenance / total >= 0.5 ? 'pass' : 'warn',
      details: `${withProvenance}/${total} memories include source provenance`,
    },
    {
      name: 'entity_coverage',
      score: total ? withEntities / total : 0,
      status: total && withEntities / total >= 0.4 ? 'pass' : 'warn',
      details: `${withEntities}/${total} memories include normalized entities`,
    },
    {
      name: 'explicit_relation_coverage',
      score: total ? withExplicitRelations / total : 0,
      status: total && withExplicitRelations > 0 ? 'pass' : 'warn',
      details: `${withExplicitRelations}/${total} memories include explicit lifecycle relations`,
    },
    {
      name: 'graph_projection',
      score: total ? Math.min(1, graph.stats.edge_count / Math.max(1, total)) : 0,
      status: graph.stats.edge_count > 0 ? 'pass' : 'warn',
      details: `${graph.stats.node_count} nodes and ${graph.stats.edge_count} evidence-backed edges`,
    },
  ];
}

export function productionReadiness(memories: Memory[]) {
  const evaluations = evaluateMemorySystem(memories);
  const score = evaluations.reduce((sum, item) => sum + item.score, 0) / Math.max(1, evaluations.length);
  return {
    score: Number(score.toFixed(3)),
    status: evaluations.some(item => item.status === 'fail') ? 'blocked' : score >= 0.75 ? 'healthy' : 'needs-data-quality-work',
    evals: evaluations,
  };
}
