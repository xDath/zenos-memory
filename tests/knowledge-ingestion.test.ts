import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKnowledgeMemories, chunkDocument } from '../app/lib/knowledge-ingestion';

test('chunking hard-bounds oversized paragraphs', () => {
  const content = 'A'.repeat(10_001);
  const chunks = chunkDocument(content, 1400);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.content.length <= 1400));
  assert.equal(chunks.map(chunk => chunk.content).join('').length, content.length);
});

test('knowledge ingestion is content-addressed and retry-idempotent', () => {
  const content = '# Architecture\n\nZenos Memory uses Vercel and Google Drive append-only events.';
  const first = buildKnowledgeMemories(content, 'architecture.md', 'zenos', 'hermes');
  const second = buildKnowledgeMemories(content, 'architecture.md', 'zenos', 'hermes');
  assert.deepEqual(
    first.map(item => item.idempotency_key),
    second.map(item => item.idempotency_key),
  );
  assert.ok(first.every(item => typeof item.idempotency_key === 'string' && item.idempotency_key.length === 64));
  assert.ok(first.every(item => item.metadata?.provenance?.source_hash));
});
