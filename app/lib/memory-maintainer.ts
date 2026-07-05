import { Memory } from './schema';
import { buildTemporalGraph, vectorSearch } from './advanced-memory';

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string) {
  const aa = new Set(normalize(a).split(' ').filter(Boolean));
  const bb = new Set(normalize(b).split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  const inter = [...aa].filter(x => bb.has(x)).length;
  const union = new Set([...aa, ...bb]).size;
  return inter / union;
}

export function buildDedupPlan(memories: Memory[]) {
  const pairs: Array<{ keep: string; merge: string; score: number; reason: string }> = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      if (a.type !== b.type) continue;
      const score = similarity(a.content, b.content);
      if (score >= 0.82) {
        const keep = (a.metadata.importance || 0) >= (b.metadata.importance || 0) ? a : b;
        const merge = keep.id === a.id ? b : a;
        pairs.push({ keep: keep.id, merge: merge.id, score, reason: 'high-jaccard-similarity' });
      }
    }
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, 100);
}

export function buildMaintenanceReport(memories: Memory[]) {
  const now = Date.now();
  const stale = memories.filter(m => now - new Date(m.updated_at).getTime() > 1000 * 60 * 60 * 24 * 30);
  const lowConfidence = memories.filter(m => (m.metadata.confidence || 0) < 0.55);
  const compactions = memories.filter(m => m.type === 'insight' && (m.metadata.tags || []).some(t => t.includes('compact')));
  const credentials = memories.filter(m => m.type === 'credential');
  const withProvenance = memories.filter(m => !!m.metadata.provenance || !!m.metadata.source);
  const relationshipIndexes = memories.filter(m => m.type === 'relationship' && m.metadata.tags.includes('relationship-index'));
  const knowledgeChunks = memories.filter(m => m.type === 'file' && m.metadata.tags.includes('knowledge-chunk'));
  const graph = buildTemporalGraph(memories);
  const dedup = buildDedupPlan(memories);

  return {
    generated_at: new Date().toISOString(),
    totals: {
      memories: memories.length,
      stale: stale.length,
      low_confidence: lowConfidence.length,
      compactions: compactions.length,
      credentials: credentials.length,
      provenance_coverage: withProvenance.length,
      knowledge_chunks: knowledgeChunks.length,
      relationship_indexes: relationshipIndexes.length,
      graph_nodes: graph.stats.node_count,
      graph_edges: graph.stats.edge_count,
      dedup_candidates: dedup.length,
    },
    actions: {
      dedup_candidates: dedup,
      archive_candidates: stale.slice(0, 20).map(m => ({ id: m.id, type: m.type, updated_at: m.updated_at, content: m.content.slice(0, 160) })),
      review_candidates: lowConfidence.slice(0, 20).map(m => ({ id: m.id, confidence: m.metadata.confidence, content: m.content.slice(0, 160) })),
    },
    recommendations: [
      dedup.length ? `Merge ${dedup.length} duplicate candidates` : 'No major duplicate cluster detected',
      stale.length ? `Archive/recompact ${stale.length} stale memories` : 'No stale memory pressure',
      graph.stats.edge_count > memories.length ? 'Temporal graph density is healthy' : 'Graph needs more relationship extraction',
      withProvenance.length >= memories.length * 0.7 ? 'Provenance coverage is healthy' : 'Add provenance/source fields to more memories',
      relationshipIndexes.length ? 'Knowledge graph ingestion is active' : 'Upload docs/repos to build relationship indexes',
      credentials.length ? 'Credential memory is active' : 'No credential memories stored yet',
    ],
  };
}

export function queryGraph(memories: Memory[], query: string, limit = 20) {
  const graph = buildTemporalGraph(memories);
  const hits = vectorSearch(query, memories, limit);
  const hitIds = new Set(hits.map(h => h.id));
  const relatedEdges = graph.edges.filter(e => hitIds.has(e.source) || hitIds.has(e.target)).slice(0, 80);
  const nodeIds = new Set<string>();
  for (const e of relatedEdges) { nodeIds.add(e.source); nodeIds.add(e.target); }
  const nodes = graph.nodes.filter(n => nodeIds.has(n.id)).slice(0, 80);
  return { query, hits, subgraph: { nodes, edges: relatedEdges }, stats: graph.stats };
}

export function createLockLease(owner: string, ttlMs = 30000) {
  const now = Date.now();
  return {
    id: `lock-${owner}-${now}`,
    owner,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    ttl_ms: ttlMs,
  };
}
