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

function retrievalMetrics(
  corpus: Memory[],
  queries: Array<{ query: string; relevant: string[] }>,
) {
  let recallAt1 = 0;
  let recallAt3 = 0;
  let reciprocalRank = 0;
  let ndcgAt3 = 0;
  const results = queries.map((item) => {
    const ranked = rankHybrid(item.query, corpus, 3);
    const ids = ranked.map(result => result.memory.id);
    const firstRelevant = ids.findIndex(id => item.relevant.includes(id));
    if (firstRelevant === 0) recallAt1 += 1;
    if (firstRelevant >= 0 && firstRelevant < 3) recallAt3 += 1;
    if (firstRelevant >= 0) reciprocalRank += 1 / (firstRelevant + 1);
    const dcg = ids.reduce((sum, id, index) => (
      sum + (item.relevant.includes(id) ? 1 / Math.log2(index + 2) : 0)
    ), 0);
    const idealHits = Math.min(item.relevant.length, 3);
    const idcg = Array.from({ length: idealHits }, (_, index) => 1 / Math.log2(index + 2))
      .reduce((sum, value) => sum + value, 0);
    ndcgAt3 += idcg ? dcg / idcg : 1;
    return { query: item.query, expected: item.relevant, ranked: ids, first_relevant_rank: firstRelevant + 1 };
  });
  const total = Math.max(1, queries.length);
  return {
    recall_at_1: recallAt1 / total,
    recall_at_3: recallAt3 / total,
    mrr: reciprocalRank / total,
    ndcg_at_3: ndcgAt3 / total,
    results,
  };
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

  const personalCorpus = [
    fixtureMemory(
      '66666666-6666-4666-8666-666666666666',
      'Host tetap menjadi pemikir utama dan orchestrator. Worker hanya mengumpulkan bukti, Verifier mengecek bila perlu, dan Boss hanya untuk eskalasi.',
      { type: 'preference', importance: 10, tags: ['host', 'orchestrator', 'worker', 'verifier'] },
    ),
    fixtureMemory(
      '77777777-7777-4777-8777-777777777777',
      'Working context Host untuk pemakaian personal dibatasi 64 ribu token dan hasil compression ditargetkan sekitar 16 ribu token.',
      { type: 'insight', importance: 9, tags: ['decision', 'token', 'context', 'compression'] },
    ),
    fixtureMemory(
      '88888888-8888-4888-8888-888888888888',
      'Zenos Memory menjaga keputusan, preferensi, blocker, dan state project supaya agent tidak lupa konteks durable.',
      { type: 'project', importance: 9, tags: ['memory', 'context', 'durable'] },
    ),
    fixtureMemory(
      '99999999-9999-4999-8999-999999999999',
      'Encrypted secondary backups are stored on the VPS outside the Google Drive failure domain and verified after every write.',
      { type: 'project', importance: 9, tags: ['backup', 'encrypted', 'vps'] },
    ),
    unrelated,
  ];
  const personalMetrics = retrievalMetrics(personalCorpus, [
    { query: 'siapa yang jadi orchestrator utama?', relevant: ['66666666-6666-4666-8666-666666666666'] },
    { query: 'berapa batas working context host dan target kompresinya?', relevant: ['77777777-7777-4777-8777-777777777777'] },
    { query: 'gimana caranya biar agent nggak lupa keputusan project?', relevant: ['88888888-8888-4888-8888-888888888888'] },
    { query: 'where is the encrypted secondary backup stored?', relevant: ['99999999-9999-4999-8999-999999999999'] },
  ]);

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
    {
      name: 'personal_bilingual_retrieval_metrics',
      passed: personalMetrics.recall_at_1 >= 0.75
        && personalMetrics.recall_at_3 === 1
        && personalMetrics.mrr >= 0.85
        && personalMetrics.ndcg_at_3 >= 0.85,
      details: personalMetrics,
    },
  ];

  const passed = cases.filter(item => item.passed).length;
  return {
    success: passed === cases.length,
    benchmark: 'zenos-memory-personal-retrieval-regression-v2',
    score: Number((passed / cases.length).toFixed(4)),
    passed,
    failed: cases.length - passed,
    cases,
    methodology: {
      scope: 'deterministic contract plus bilingual personal-use retrieval regression',
      claims: 'This validates invariants and retrieval metrics on a bounded noisy corpus; longitudinal evaluation on real user queries is still required.',
      retrieval_provider: 'provider dense embeddings plus BM25-style sparse, graph, RRF, and lifecycle ranking with deterministic fallback',
    },
  };
}
