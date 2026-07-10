import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConflictError } from '../app/lib/errors';
import { MemoryEngine } from '../app/lib/memory-engine';
import { SqliteMemoryStore } from '../app/lib/sqlite-store';

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zenos-memory-test-'));
  const store = new SqliteMemoryStore(path.join(directory, 'memory.sqlite'));
  const engine = new MemoryEngine({ store, driveBackup: null });
  return {
    store,
    engine,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('transactional lifecycle', async () => {
  const context = fixture();
  try {
    const first = await context.engine.remember({
      content: 'Zenos Memory uses SQLite as the durable transactional primary store.',
      namespace: 'core',
      type: 'project',
      metadata: { tags: ['sqlite'], confidence: 0.9, importance: 10 },
    });
    const duplicate = await context.engine.remember({
      content: 'Zenos Memory uses SQLite as the durable transactional primary store.',
      namespace: 'core',
      type: 'project',
      metadata: { tags: ['architecture'], confidence: 0.95, importance: 10 },
    });
    assert.equal(duplicate.id, first.id);
    assert.equal((await context.engine.getStats('core')).total, 1);

    const recalled = await context.engine.recall({ query: 'durable primary storage architecture', namespace: 'core', limit: 10 });
    assert.equal(recalled[0]?.id, first.id);

    const updated = await context.engine.edit(first.id, {
      content: 'Zenos Memory uses SQLite WAL as the durable transactional primary store.',
    }, 'core', duplicate.metadata.version);
    assert.ok(updated);

    await assert.rejects(
      () => context.engine.edit(first.id, { content: 'stale write' }, 'core', duplicate.metadata.version),
      ConflictError,
    );

    assert.equal(await context.engine.forget(first.id, 'core', updated?.metadata.version), true);
    assert.deepEqual(await context.engine.list('core', 10), []);
  } finally {
    context.close();
  }
});

test('idempotency prevents duplicate writes', async () => {
  const context = fixture();
  try {
    const request = {
      content: 'An idempotent write is returned exactly once.',
      namespace: 'idempotency',
      idempotency_key: 'idem-test-00000001',
    };
    const first = await context.engine.remember(request);
    const second = await context.engine.remember(request);
    assert.equal(second.id, first.id);
    assert.equal((await context.engine.getStats('idempotency')).total, 1);
  } finally {
    context.close();
  }
});

test('superseded memories are excluded from current recall', async () => {
  const context = fixture();
  try {
    const previous = await context.engine.remember({
      content: 'The primary store is a mutable Google Drive JSON file.',
      namespace: 'lifecycle',
      type: 'project',
      metadata: { tags: ['storage'], importance: 8 },
    });
    const current = await context.engine.remember({
      content: 'The primary store is SQLite WAL; Google Drive is backup only.',
      namespace: 'lifecycle',
      type: 'project',
      metadata: { tags: ['storage'], importance: 10, supersedes_ids: [previous.id] },
    });
    const recalled = await context.engine.recall({ query: 'current primary store', namespace: 'lifecycle', limit: 10 });
    assert.equal(recalled[0]?.id, current.id);
    assert.equal(recalled.some(memory => memory.id === previous.id), false);
  } finally {
    context.close();
  }
});

test('leases enforce single-owner coordination', async () => {
  const context = fixture();
  try {
    const lease = await context.engine.acquireLease('backup', 'worker-a', 'locks', 30_000);
    assert.ok(lease);
    assert.equal(await context.engine.acquireLease('backup', 'worker-b', 'locks', 30_000), null);
    const renewed = await context.engine.renewLease(lease!.token, 'worker-a', 60_000);
    assert.ok(renewed);
    assert.equal((await context.engine.listLeases('locks')).length, 1);
    assert.equal(await context.engine.releaseLease(lease!.token, 'worker-a'), true);
    assert.equal((await context.engine.listLeases('locks')).length, 0);
  } finally {
    context.close();
  }
});

test('snapshot restore verifies checksum and round-trips data', async () => {
  const source = fixture();
  const target = fixture();
  try {
    const memory = await source.engine.remember({
      content: 'Snapshot restore preserves durable memory records.',
      namespace: 'restore',
      type: 'fact',
      metadata: { importance: 8, tags: ['backup'] },
    });
    const snapshot = source.store.exportSnapshot('restore');
    const result = await target.engine.restoreSnapshot(snapshot, { mode: 'merge' });
    assert.equal(result.inserted, 1);
    assert.equal((await target.engine.list('restore', 10))[0]?.id, memory.id);
    await assert.rejects(() => target.engine.restoreSnapshot({ ...snapshot, checksum: '0'.repeat(64) }));
  } finally {
    source.close();
    target.close();
  }
});
