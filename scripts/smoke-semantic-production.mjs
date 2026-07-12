#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ZenosMemoryClient } from '../sdk/js/zenos-memory-client.mjs';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

loadZenosRuntimeEnv(process.cwd());

const namespace = `semantic-smoke-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const client = new ZenosMemoryClient({
  baseUrl: process.env.ZENOS_MEMORY_URL || 'https://zenos-memory.vercel.app',
  namespace,
  clientId: 'zenos-semantic-production-smoke',
  timeoutMs: 180_000,
});
const createdIds = [];
process.stdout.write(`${JSON.stringify({ phase: 'start', namespace })}\n`);

try {
  const relevant = await client.remember(
    'The emergency rollback playbook for Project Aurora is kept inside the cobalt observatory archive.',
    {
      namespace,
      type: 'project',
      metadata: { tags: ['semantic-smoke', 'aurora'], importance: 9, confidence: 0.98 },
      idempotencyKey: `semantic-primary-${namespace}`,
    },
  );
  const distractor = await client.remember(
    'The design dashboard uses soft violet gradients and rounded cards.',
    {
      namespace,
      type: 'project',
      metadata: { tags: ['semantic-smoke', 'design'], importance: 5, confidence: 0.9 },
      idempotencyKey: `semantic-distractor-${namespace}`,
    },
  );
  createdIds.push(relevant.memory.id, distractor.memory.id);

  const recalled = await client.recall(
    'Di mana panduan pemulihan darurat untuk Proyek Aurora disimpan?',
    { namespace, limit: 2 },
  );
  const top = recalled.results?.[0];
  assert.equal(recalled.retrieval, 'dense-sparse-graph-rrf-lifecycle-v2');
  assert.ok(top, 'Semantic recall returned no results');
  assert.equal(top.id, relevant.memory.id, `Unexpected top result: ${JSON.stringify(top)}`);
  assert.match(
    String(top.reason),
    /^dense-/,
    `Production recall did not use the shared dense semantic space: ${JSON.stringify({
      reason: top.reason,
      storedProvider: relevant.memory.metadata?.embedding_provider,
      storedSpace: relevant.memory.metadata?.embedding_space,
      storedDegraded: relevant.memory.metadata?.embedding_degraded,
      returnedProvider: top.metadata?.embedding_provider,
      returnedSpace: top.metadata?.embedding_space,
      returnedDegraded: top.metadata?.embedding_degraded,
      vectorSignal: top.signals?.vector,
    })}`,
  );
  assert.match(
    String(top.metadata?.embedding_space || ''),
    /^(llm-semantic-hash|dense):/,
    `Unexpected embedding space: ${top.metadata?.embedding_space}`,
  );
  assert.ok(Number(top.signals?.vector || 0) > 0, 'Dense vector signal was not positive');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    namespace,
    retrieval: recalled.retrieval,
    topId: top.id,
    reason: top.reason,
    embeddingProvider: top.metadata?.embedding_provider,
    embeddingSpace: top.metadata?.embedding_space,
    vectorSignal: top.signals?.vector,
    fusionSignal: top.signals?.fusion,
  }, null, 2)}\n`);
} finally {
  for (const id of createdIds.reverse()) {
    try {
      await client.forget(id, { namespace });
    } catch (error) {
      console.error(`Semantic smoke cleanup failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
