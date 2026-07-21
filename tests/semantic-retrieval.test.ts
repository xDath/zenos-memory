import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rankHybrid } from '../app/lib/hybrid-retrieval';
import { MemoryEngine } from '../app/lib/memory-engine';
import { getEmbeddings } from '../app/lib/neural-embedding';
import { Memory, MemorySchema } from '../app/lib/schema';
import { SqliteMemoryStore } from '../app/lib/sqlite-store';

function memory(id: string, content: string, vector: number[], space: string): Memory {
  const timestamp = '2026-07-13T00:00:00.000Z';
  return MemorySchema.parse({
    id,
    type: 'project',
    content,
    namespace: 'semantic-test',
    metadata: {
      confidence: 0.9,
      tags: [],
      version: 1,
      status: 'active',
      importance: 8,
      related_ids: [],
      entities: [],
      contradictions: [],
      supersedes_ids: [],
      access_count: 0,
      redacted: false,
      is_secret: false,
      embedding_provider: 'test-dense',
      embedding_space: space,
      embedding_dimensions: vector.length,
      embedding_generated_at: timestamp,
      embedding_degraded: false,
    },
    embedding: vector,
    created_at: timestamp,
    updated_at: timestamp,
  });
}

test('same-space dense vectors retrieve a paraphrase without lexical overlap', () => {
  const relevant = memory(
    '11111111-1111-4111-8111-111111111111',
    'Authoritative records persist in an owner-controlled cloud archive.',
    [1, 0, 0, 0, 0, 0, 0, 0],
    'dense:test:8',
  );
  const unrelated = memory(
    '22222222-2222-4222-8222-222222222222',
    'The interface uses a pastel color palette.',
    [0, 1, 0, 0, 0, 0, 0, 0],
    'dense:test:8',
  );

  const ranked = rankHybrid(
    'where does the durable personal memory live?',
    [unrelated, relevant],
    2,
    { vector: [1, 0, 0, 0, 0, 0, 0, 0], space: 'dense:test:8' },
  );

  assert.equal(ranked[0].memory.id, relevant.id);
  assert.match(ranked[0].reason, /^dense-/);
  assert.ok(ranked[0].signals.vector > ranked[1].signals.vector);
});

test('bounded recall feedback can rerank otherwise equivalent evidence', () => {
  const baseVector = [1, 0, 0, 0, 0, 0, 0, 0];
  const helpfulBase = memory(
    'aaaa1111-1111-4111-8111-111111111111',
    'Verified rollback procedure for production deployment alpha safeguard.',
    baseVector,
    'dense:test:8',
  );
  const helpful = MemorySchema.parse({
    ...helpfulBase,
    metadata: {
      ...helpfulBase.metadata,
      recall_positive_count: 12,
      recall_negative_count: 0,
    },
  });
  const harmfulBase = memory(
    'bbbb2222-2222-4222-8222-222222222222',
    'Verified rollback procedure for production deployment beta fallback.',
    baseVector,
    'dense:test:8',
  );
  const harmful = MemorySchema.parse({
    ...harmfulBase,
    metadata: {
      ...harmfulBase.metadata,
      recall_positive_count: 0,
      recall_negative_count: 12,
    },
  });

  const ranked = rankHybrid(
    'verified rollback procedure production deployment',
    [harmful, helpful],
    2,
    { vector: baseVector, space: 'dense:test:8' },
  );

  assert.equal(ranked[0].memory.id, helpful.id);
  assert.ok(ranked[0].signals.usefulness > ranked[1].signals.usefulness);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('recall feedback is idempotent and updates counters without provider calls', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zenos-feedback-engine-'));
  const store = new SqliteMemoryStore(path.join(directory, 'memory.sqlite'));
  const engine = new MemoryEngine({ store, driveBackup: null });
  const originalFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = (async () => {
    providerCalls += 1;
    throw new Error('feedback must not call a provider');
  }) as typeof fetch;
  try {
    const created = await engine.remember({
      namespace: 'feedback-test',
      type: 'decision',
      content: 'Use the deterministic rollback procedure for production deployment.',
    });
    providerCalls = 0;
    const first = await engine.recordRecallFeedback({
      feedback_id: 'feedback-run-00000001',
      namespace: 'feedback-test',
      outcome: 'helpful',
      memory_ids: [created.id],
      run_id: 'run-feedback-1',
      session_id: 'session-feedback-1',
      source: 'runtime-outcome',
    });
    const replay = await engine.recordRecallFeedback({
      feedback_id: 'feedback-run-00000001',
      namespace: 'feedback-test',
      outcome: 'helpful',
      memory_ids: [created.id],
      run_id: 'run-feedback-1',
      session_id: 'session-feedback-1',
      source: 'runtime-outcome',
    });
    const updated = (await engine.list('feedback-test', 10)).find(item => item.id === created.id);

    assert.equal(first.updated, 1);
    assert.equal(first.deduplicated, false);
    assert.equal(replay.deduplicated, true);
    assert.equal(updated?.metadata.recall_positive_count, 1);
    assert.equal(providerCalls, 0);
  } finally {
    global.fetch = originalFetch;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mismatched embedding spaces never compare truncated vectors', () => {
  const lexical = memory(
    '33333333-3333-4333-8333-333333333333',
    'The exact rollback procedure is documented here.',
    [0, 1, 0, 0, 0, 0, 0, 0],
    'dense:old-model:8',
  );
  const misleading = memory(
    '44444444-4444-4444-8444-444444444444',
    'Unrelated visual design notes.',
    [1, 0, 0, 0, 0, 0, 0, 0],
    'dense:other-model:8',
  );

  const ranked = rankHybrid(
    'exact rollback procedure',
    [misleading, lexical],
    2,
    { vector: [1, 0, 0, 0, 0, 0, 0, 0], space: 'dense:new-model:8' },
  );

  assert.equal(ranked[0].memory.id, lexical.id);
  assert.match(ranked[0].reason, /^deterministic-/);
});

test('MemoryEngine stores provider embeddings and uses them for recall', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    base: process.env.MEMORY_EMBEDDING_BASE_URL,
    key: process.env.MEMORY_EMBEDDING_API_KEY,
    model: process.env.MEMORY_EMBEDDING_MODEL,
  };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zenos-semantic-engine-'));
  process.env.MEMORY_EMBEDDING_BASE_URL = 'https://embedding.test/v1';
  process.env.MEMORY_EMBEDDING_API_KEY = 'test-key';
  process.env.MEMORY_EMBEDDING_MODEL = 'semantic-test-v1';
  global.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body || '{}')) as { input: string | string[] };
    const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    return Response.json({
      data: inputs.map((text, index) => ({
        index,
        embedding: /singapore|hosting region/i.test(text)
          ? [1, 0, 0, 0, 0, 0, 0, 0]
          : [0, 1, 0, 0, 0, 0, 0, 0],
      })),
    });
  };

  const store = new SqliteMemoryStore(path.join(directory, 'memory.sqlite'));
  const engine = new MemoryEngine({ store, driveBackup: null });
  try {
    const embedded = await getEmbeddings(['hosting region', 'color palette']);
    assert.equal(embedded.length, 2);
    assert.equal(embedded[0].space, 'dense:semantic-test-v1:8');

    const relevant = await engine.remember({
      content: 'Production hosting runs in Singapore.',
      namespace: 'semantic-test',
      type: 'project',
    });
    await engine.remember({
      content: 'The dashboard uses a violet color palette.',
      namespace: 'semantic-test',
      type: 'project',
    });
    const recalled = await engine.recallWithQuality({
      query: 'Which hosting region is used?',
      namespace: 'semantic-test',
      limit: 2,
    });

    assert.equal(relevant.metadata.embedding_space, 'dense:semantic-test-v1:8');
    assert.equal(relevant.embedding?.length, 8);
    assert.equal(recalled[0].id, relevant.id);
    assert.match(String(recalled[0].reason), /^dense-/);

    process.env.MEMORY_EMBEDDING_MODEL = 'semantic-test-v2';
    const reindexed = await engine.reindexEmbeddings('semantic-test', 10);
    const refreshed = await engine.list('semantic-test', 10);
    assert.equal(reindexed.updated, 2);
    assert.equal(reindexed.space, 'dense:semantic-test-v2:8');
    assert.equal(refreshed.every(memory => memory.metadata.embedding_space === 'dense:semantic-test-v2:8'), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    global.fetch = originalFetch;
    if (originalEnv.base === undefined) delete process.env.MEMORY_EMBEDDING_BASE_URL;
    else process.env.MEMORY_EMBEDDING_BASE_URL = originalEnv.base;
    if (originalEnv.key === undefined) delete process.env.MEMORY_EMBEDDING_API_KEY;
    else process.env.MEMORY_EMBEDDING_API_KEY = originalEnv.key;
    if (originalEnv.model === undefined) delete process.env.MEMORY_EMBEDDING_MODEL;
    else process.env.MEMORY_EMBEDDING_MODEL = originalEnv.model;
  }
});

test('LLM semantic expansion provides a shared semantic space when no dense provider is configured', async () => {
  const originalFetch = global.fetch;
  const keys = [
    'MEMORY_EMBEDDING_BASE_URL',
    'MEMORY_EMBEDDING_API_KEY',
    'MEMORY_EMBEDDING_MODEL',
    'MEMORY_LLM_BASE_URL',
    'MEMORY_LLM_API_KEY',
    'MEMORY_LLM_MODEL',
    'MEMORY_SEMANTIC_EXPANSION_ENABLED',
  ] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.MEMORY_EMBEDDING_BASE_URL;
  delete process.env.MEMORY_EMBEDDING_API_KEY;
  delete process.env.MEMORY_EMBEDDING_MODEL;
  process.env.MEMORY_LLM_BASE_URL = 'https://llm.test/v1';
  process.env.MEMORY_LLM_API_KEY = 'llm-key';
  process.env.MEMORY_LLM_MODEL = 'semantic-expander';
  process.env.MEMORY_SEMANTIC_EXPANSION_ENABLED = 'true';
  global.fetch = async () => Response.json({
    choices: [{
      message: {
        content: `\`\`\`json
${JSON.stringify([
  { index: '0', semanticText: 'production hosting region location singapore deployment' },
  { index: '1', representation: 'production hosting region location singapore deployment' },
])}
\`\`\``,
      },
    }],
  });

  try {
    const results = await getEmbeddings([
      'Production runs in Singapore.',
      'Di region mana layanan production di-host?',
    ]);
    assert.equal(results.every(result => result.provider === 'llm-semantic:semantic-expander'), true);
    assert.equal(results[0].space, 'llm-semantic-hash:v1:384');
    assert.equal(results[0].space, results[1].space);
    assert.deepEqual(results[0].vector, results[1].vector);
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

test('semantic expansion retries a fallback model while preserving one stable vector space', async () => {
  const originalFetch = global.fetch;
  const keys = [
    'MEMORY_EMBEDDING_BASE_URL',
    'MEMORY_EMBEDDING_API_KEY',
    'MEMORY_EMBEDDING_MODEL',
    'MEMORY_LLM_BASE_URL',
    'MEMORY_LLM_API_KEY',
    'MEMORY_LLM_MODEL',
    'MEMORY_LLM_FALLBACK_MODEL',
    'MEMORY_SEMANTIC_EXPANSION_ENABLED',
    'MEMORY_SEMANTIC_EXPANSION_TIMEOUT_MS',
    'MEMORY_SEMANTIC_EXPANSION_TOTAL_BUDGET_MS',
  ] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.MEMORY_EMBEDDING_BASE_URL;
  delete process.env.MEMORY_EMBEDDING_API_KEY;
  delete process.env.MEMORY_EMBEDDING_MODEL;
  process.env.MEMORY_LLM_BASE_URL = 'https://llm.test/v1';
  process.env.MEMORY_LLM_API_KEY = 'llm-key';
  process.env.MEMORY_LLM_MODEL = 'semantic-primary';
  process.env.MEMORY_LLM_FALLBACK_MODEL = 'semantic-fallback';
  process.env.MEMORY_SEMANTIC_EXPANSION_ENABLED = 'true';
  process.env.MEMORY_SEMANTIC_EXPANSION_TIMEOUT_MS = '5000';
  process.env.MEMORY_SEMANTIC_EXPANSION_TOTAL_BUDGET_MS = '12000';
  const models: string[] = [];
  global.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as { model: string };
    models.push(body.model);
    if (body.model === 'semantic-primary') return Response.json({ error: { message: 'temporary' } }, { status: 503 });
    return Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            items: [
              { index: 0, semantic_text: 'rollback recovery emergency archive' },
              { index: 1, semantic_text: 'rollback recovery emergency archive' },
            ],
          }),
        },
      }],
    });
  };

  try {
    const results = await getEmbeddings(['rollback guide', 'panduan pemulihan']);
    assert.deepEqual(models, ['semantic-primary', 'semantic-fallback']);
    assert.equal(results.every(result => result.provider === 'llm-semantic:semantic-fallback'), true);
    assert.equal(results.every(result => result.space === 'llm-semantic-hash:v1:384'), true);
    assert.equal(results.every(result => result.ok), true);
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

test('semantic expansion batches large reindex jobs into bounded provider contracts', async () => {
  const originalFetch = global.fetch;
  const keys = [
    'MEMORY_EMBEDDING_BASE_URL',
    'MEMORY_EMBEDDING_API_KEY',
    'MEMORY_EMBEDDING_MODEL',
    'MEMORY_LLM_BASE_URL',
    'MEMORY_LLM_API_KEY',
    'MEMORY_LLM_MODEL',
    'MEMORY_LLM_FALLBACK_MODEL',
    'MEMORY_SEMANTIC_EXPANSION_ENABLED',
  ] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.MEMORY_EMBEDDING_BASE_URL;
  delete process.env.MEMORY_EMBEDDING_API_KEY;
  delete process.env.MEMORY_EMBEDDING_MODEL;
  process.env.MEMORY_LLM_BASE_URL = 'https://llm.test/v1';
  process.env.MEMORY_LLM_API_KEY = 'llm-key';
  process.env.MEMORY_LLM_MODEL = 'semantic-primary';
  delete process.env.MEMORY_LLM_FALLBACK_MODEL;
  process.env.MEMORY_SEMANTIC_EXPANSION_ENABLED = 'true';
  const batchSizes: number[] = [];
  const outputCaps: number[] = [];
  global.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}')) as { messages: Array<{ content: string }>; max_tokens: number };
    const request = JSON.parse(body.messages[1].content) as { items: Array<{ index: number }> };
    batchSizes.push(request.items.length);
    outputCaps.push(body.max_tokens);
    return Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            items: request.items.map(item => ({ index: item.index, semantic_text: `bounded concept ${item.index}` })),
          }),
        },
      }],
    });
  };

  try {
    const results = await getEmbeddings(Array.from({ length: 45 }, (_, index) => `memory ${index}`));
    assert.deepEqual(batchSizes, [5, 5, 5, 5, 5, 5, 5, 5, 5]);
    assert.deepEqual(outputCaps, [3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000]);
    assert.equal(results.length, 45);
    assert.equal(results.every(result => result.ok && result.provider === 'llm-semantic:semantic-primary'), true);
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

test('failed semantic expansion is explicit instead of silently reporting a healthy embedding', async () => {
  const originalFetch = global.fetch;
  const keys = [
    'MEMORY_EMBEDDING_BASE_URL',
    'MEMORY_EMBEDDING_API_KEY',
    'MEMORY_EMBEDDING_MODEL',
    'MEMORY_LLM_BASE_URL',
    'MEMORY_LLM_API_KEY',
    'MEMORY_LLM_MODEL',
    'MEMORY_LLM_FALLBACK_MODEL',
    'MEMORY_SEMANTIC_EXPANSION_ENABLED',
  ] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  delete process.env.MEMORY_EMBEDDING_BASE_URL;
  delete process.env.MEMORY_EMBEDDING_API_KEY;
  delete process.env.MEMORY_EMBEDDING_MODEL;
  process.env.MEMORY_LLM_BASE_URL = 'https://llm.test/v1';
  process.env.MEMORY_LLM_API_KEY = 'llm-key';
  process.env.MEMORY_LLM_MODEL = 'semantic-primary';
  delete process.env.MEMORY_LLM_FALLBACK_MODEL;
  process.env.MEMORY_SEMANTIC_EXPANSION_ENABLED = 'true';
  global.fetch = async () => Response.json({ error: { message: 'temporary' } }, { status: 503 });

  try {
    const [result] = await getEmbeddings(['rollback guide']);
    assert.equal(result.provider, 'deterministic-hashed-v2');
    assert.equal(result.ok, false);
    assert.match(result.error || '', /HTTP 503/);
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});
