import { cosineSimilarity, deterministicEmbedding } from './advanced-memory';
import { buildDagCompactSnapshot, CompactRequest, renderBootstrapBlock } from './compaction';
import { rankHybrid } from './hybrid-retrieval';
import { Memory, MemorySchema } from './schema';
import { scanSensitiveText } from './secrets';

interface EvalCase {
  name: string;
  passed: boolean;
  details: Record<string, unknown>;
}

function fixtureMemory(
  id: string,
  content: string,
  options: {
    type?: Memory['type'];
    importance?: number;
    tags?: string[];
    entities?: string[];
    status?: Memory['metadata']['status'];
    supersedes?: string[];
    createdAt?: string;
    embedding?: number[];
    embeddingSpace?: string;
  } = {},
): Memory {
  const timestamp = options.createdAt || new Date().toISOString();
  return MemorySchema.parse({
    id,
    type: options.type || 'insight',
    content,
    namespace: 'eval',
    metadata: {
      confidence: 0.9,
      tags: options.tags || [],
      version: 1,
      status: options.status || 'active',
      importance: options.importance || 7,
      related_ids: [],
      entities: options.entities || [],
      contradictions: [],
      supersedes_ids: options.supersedes || [],
      access_count: 0,
      is_secret: false,
      redacted: false,
      source: 'eval-fixture',
      embedding_provider: options.embedding ? 'eval-dense' : undefined,
      embedding_space: options.embeddingSpace,
      embedding_dimensions: options.embedding?.length,
      embedding_generated_at: options.embedding ? timestamp : undefined,
      embedding_degraded: false,
    },
    embedding: options.embedding,
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function containsAll(text: string, terms: string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.every(term => normalized.includes(term.toLowerCase()));
}

export function runIntelligenceAmplificationEval() {
  const messages: CompactRequest['messages'] = [
    { role: 'user', content: 'The current goal is to harden Zenos Memory for durable production use.' },
    { role: 'assistant', content: 'Decision: Vercel is the scale-to-zero compute plane and Google Drive append-only events are the canonical personal store.' },
    { role: 'user', content: 'Pending work includes security tests, migration checks, cold-start recovery, snapshot verification, and production deployment.' },
    { role: 'assistant', content: 'Completed: raw credential capture was removed, Drive CAS leases were added, and the VPS became a thin client.' },
  ];
  const compact = buildDagCompactSnapshot({
    messages,
    namespace: 'eval',
    reason: 'contract-regression',
    approx_tokens: 350,
    max_chars: 8000,
    mode: 'dag',
  });
  const compactMemory = fixtureMemory(
    '11111111-1111-4111-8111-111111111111',
    compact.content,
    { importance: 10, tags: ['dag-compact', 'working-pack'], entities: ['Zenos Memory'] },
  );
  const policyMemory = fixtureMemory(
    '22222222-2222-4222-8222-222222222222',
    'Raw secrets are rejected; only vault references may be stored.',
    { importance: 10, tags: ['security', 'secret-policy'], entities: ['Zenos Memory'] },
  );
  const bootstrap = renderBootstrapBlock([compactMemory, policyMemory], 'eval', 6000);

  const fakeSecret = `sk-${'A'.repeat(32)}`;
  const secretCompact = buildDagCompactSnapshot({
    messages: [
      { role: 'user', content: `Do not preserve this test token: ${fakeSecret}` },
      { role: 'assistant', content: 'The token must be redacted before storage.' },
    ],
    namespace: 'eval',
    reason: 'secret-regression',
    approx_tokens: 80,
    max_chars: 3000,
    mode: 'dag',
  });

  const oldState = fixtureMemory(
    '33333333-3333-4333-8333-333333333333',
    'The primary memory store is one mutable Google Drive JSON file that is rewritten on every request.',
    { type: 'project', importance: 8, tags: ['storage'], entities: ['Google Drive'], status: 'superseded', createdAt: '2026-01-01T00:00:00.000Z' },
  );
  const currentState = fixtureMemory(
    '44444444-4444-4444-8444-444444444444',
    'The canonical memory store is an append-only Google Drive event stream; Vercel performs compute and ephemeral SQLite only accelerates warm retrieval.',
    {
      type: 'project',
      importance: 10,
      tags: ['storage', 'drive-events', 'vercel'],
      entities: ['Google Drive', 'Vercel'],
      supersedes: [oldState.id],
      createdAt: '2026-07-10T00:00:00.000Z',
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
      embeddingSpace: 'dense:eval:8',
    },
  );
  const unrelated = fixtureMemory(
    '55555555-5555-4555-8555-555555555555',
    'The profile picture uses a smooth pastel anime illustration style.',
    {
      importance: 3,
      tags: ['design'],
      entities: ['Profile Picture'],
      embedding: [0, 1, 0, 0, 0, 0, 0, 0],
      embeddingSpace: 'dense:eval:8',
    },
  );
  const ranked = rankHybrid(
    'what is the current durable primary storage architecture',
    [oldState, currentState, unrelated],
    3,
    { vector: [1, 0, 0, 0, 0, 0, 0, 0], space: 'dense:eval:8' },
  );

  const relevantSimilarity = cosineSimilarity(
    deterministicEmbedding('current durable primary storage architecture'),
    deterministicEmbedding(currentState.content),
  );
  const unrelatedSimilarity = cosineSimilarity(
    deterministicEmbedding('current durable primary storage architecture'),
    deterministicEmbedding(unrelated.content),
  );

  const cases: EvalCase[] = [
    {
      name: 'compact_preserves_goal',
      passed: containsAll(compact.content, ['Zenos Memory', 'production']),
      details: { preview: compact.content.slice(0, 240) },
    },
    {
      name: 'compact_preserves_decision_and_pending_work',
      passed: containsAll(compact.content, ['Vercel', 'Google Drive', 'security tests', 'snapshot verification']),
      details: { block_counts: compact.metadata.block_counts },
    },
    {
      name: 'bootstrap_is_bounded_and_actionable',
      passed: bootstrap.length > 0 && bootstrap.length <= 6000 && containsAll(bootstrap, ['Zenos Memory Bootstrap', 'Raw secrets']),
      details: { characters: bootstrap.length },
    },
    {
      name: 'secret_redaction',
      passed: !secretCompact.content.includes(fakeSecret) && scanSensitiveText(secretCompact.content).detected === false,
      details: { contains_raw_secret: secretCompact.content.includes(fakeSecret) },
    },
    {
      name: 'current_state_outweighs_superseded_state',
      passed: ranked[0]?.memory.id === currentState.id && !ranked.some(result => result.memory.id === oldState.id),
      details: { ranking: ranked.map(result => ({ id: result.memory.id, score: Number(result.score.toFixed(4)), reason: result.reason })) },
    },
    {
      name: 'retrieval_separates_relevant_context',
      passed: relevantSimilarity > unrelatedSimilarity,
      details: {
        relevant_similarity: Number(relevantSimilarity.toFixed(4)),
        unrelated_similarity: Number(unrelatedSimilarity.toFixed(4)),
      },
    },
  ];

  const passed = cases.filter(item => item.passed).length;
  return {
    success: passed === cases.length,
    benchmark: 'zenos-memory-contract-regression-v1',
    score: Number((passed / cases.length).toFixed(4)),
    passed,
    failed: cases.length - passed,
    cases,
    methodology: {
      scope: 'deterministic contract regression',
      claims: 'This validates invariants; it is not a scientific model-intelligence benchmark.',
      retrieval_provider: 'provider dense embeddings plus BM25-style sparse, graph, RRF, and lifecycle ranking with deterministic fallback',
    },
  };
}
