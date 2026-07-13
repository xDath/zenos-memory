import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCloudEvent, CloudMemoryEvent, materializeCloudState } from '../app/lib/cloud-events';
import { DriveLease, GoogleDriveMemoryStore } from '../app/lib/drive';
import { MemoryEngine } from '../app/lib/memory-engine';
import { Memory, MemorySchema } from '../app/lib/schema';
import { SqliteMemoryStore } from '../app/lib/sqlite-store';

class FakeDriveStore {
  events: CloudMemoryEvent[] = [];
  failNextAppend = false;
  leaseAcquisitions = 0;
  leaseRenewals = 0;
  failNextRenewal = false;
  loadCount = 0;

  async loadCloudState(namespace: string) {
    this.loadCount += 1;
    return materializeCloudState({ namespace, events: this.events });
  }

  async readLegacyMemories(): Promise<Memory[]> {
    return [];
  }

  async acquireCloudLease(namespace: string, resource: string, owner: string): Promise<DriveLease> {
    this.leaseAcquisitions += 1;
    return {
      namespace,
      resource,
      owner,
      token: `lease-${owner}`,
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      file_id: 'fake-lease-file',
    };
  }

  async renewCloudLease(lease: DriveLease, ttlMs = 30_000): Promise<DriveLease> {
    this.leaseRenewals += 1;
    if (this.failNextRenewal) {
      this.failNextRenewal = false;
      throw new Error('simulated lease ownership loss');
    }
    return {
      ...lease,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    };
  }

  async releaseCloudLease(): Promise<boolean> {
    return true;
  }

  async findCloudEvent(namespace: string, eventId: string): Promise<CloudMemoryEvent | null> {
    return this.events.find(event => event.namespace === namespace && event.event_id === eventId) || null;
  }

  async appendCloudEvent(event: CloudMemoryEvent) {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('simulated Drive outage');
    }
    const existing = this.events.find(item => item.event_id === event.event_id && item.namespace === event.namespace);
    if (!existing) this.events.push(event);
    return {
      file_id: `event-${event.event_id}`,
      cursor: `${event.occurred_at}:${event.event_id}`,
      deduplicated: Boolean(existing),
    };
  }

  async appendCloudEvents(events: CloudMemoryEvent[]) {
    const outcomes = await Promise.all(events.map(async event => {
      try {
        return { ok: true as const, value: await this.appendCloudEvent(event) };
      } catch (error) {
        return { ok: false as const, error };
      }
    }));
    const failure = outcomes.find(outcome => !outcome.ok);
    if (failure && !failure.ok) throw failure.error;
    return outcomes.map(outcome => {
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
  }
}

function cloudFixture(initialMemories: Memory[] = []) {
  const previousMode = process.env.ZENOS_MEMORY_STORAGE_MODE;
  const previousRefresh = process.env.ZENOS_MEMORY_CLOUD_REFRESH_MS;
  const previousLegacy = process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START;
  process.env.ZENOS_MEMORY_STORAGE_MODE = 'drive-events';
  process.env.ZENOS_MEMORY_CLOUD_REFRESH_MS = '0';
  process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START = 'false';

  const directory = mkdtempSync(path.join(os.tmpdir(), 'zenos-cloud-engine-test-'));
  const store = new SqliteMemoryStore(path.join(directory, 'memory.sqlite'));
  const drive = new FakeDriveStore();
  if (initialMemories.length) {
    drive.events.push(buildCloudEvent({
      namespace: initialMemories[0].namespace,
      actor: 'test',
      action: 'fixture_loaded',
      occurredAt: '2026-07-10T00:00:01.000Z',
      changes: initialMemories.map(memory => ({ operation: 'upsert' as const, memory })),
    }));
  }
  const engine = new MemoryEngine({
    store,
    driveBackup: drive as unknown as GoogleDriveMemoryStore,
  });

  return {
    store,
    drive,
    engine,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
      if (previousMode === undefined) delete process.env.ZENOS_MEMORY_STORAGE_MODE;
      else process.env.ZENOS_MEMORY_STORAGE_MODE = previousMode;
      if (previousRefresh === undefined) delete process.env.ZENOS_MEMORY_CLOUD_REFRESH_MS;
      else process.env.ZENOS_MEMORY_CLOUD_REFRESH_MS = previousRefresh;
      if (previousLegacy === undefined) delete process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START;
      else process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START = previousLegacy;
    },
  };
}

test('failed Drive append cannot leak a phantom write from a warm cache', async () => {
  const context = cloudFixture();
  try {
    context.drive.failNextAppend = true;
    await assert.rejects(() => context.engine.remember({
      content: 'This write must never become visible without a durable Drive event.',
      namespace: 'phantom-test',
      type: 'fact',
    }), /simulated Drive outage/);

    assert.deepEqual(
      await context.engine.recall({ query: 'durable Drive event', namespace: 'phantom-test', limit: 10 }),
      [],
    );
    assert.equal(context.store.count('phantom-test', true), 0);
  } finally {
    context.close();
  }
});

test('cloud reads wait until an in-flight namespace write is durable', async () => {
  const context = cloudFixture();
  try {
    let signalStarted!: () => void;
    let releaseAppend!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const barrier = new Promise<void>(resolve => { releaseAppend = resolve; });
    const append = context.drive.appendCloudEvent.bind(context.drive);
    context.drive.appendCloudEvent = async event => {
      signalStarted();
      await barrier;
      return append(event);
    };

    const write = context.engine.remember({
      content: 'Readers must not observe this memory before its Drive event commits.',
      namespace: 'commit-barrier',
      type: 'fact',
    });
    await started;

    let readSettled = false;
    const read = context.engine.recall({
      query: 'Drive event commits',
      namespace: 'commit-barrier',
      limit: 5,
    }).then(result => {
      readSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(readSettled, false);

    releaseAppend();
    const stored = await write;
    const results = await read;
    assert.equal(results[0]?.id, stored.id);
  } finally {
    context.close();
  }
});

test('same-namespace batches reuse one distributed write lease', async () => {
  const context = cloudFixture();
  try {
    const memories = await context.engine.rememberBatch([
      {
        content: 'Batch item one is durably event-sourced.',
        namespace: 'batch-test',
        type: 'fact',
        idempotency_key: 'batch-item-one-0001',
      },
      {
        content: 'Batch item two is durably event-sourced.',
        namespace: 'batch-test',
        type: 'fact',
        idempotency_key: 'batch-item-two-0002',
      },
    ]);
    assert.equal(memories.length, 2);
    assert.equal(context.drive.leaseAcquisitions, 1);
    assert.equal(context.drive.events.length, 2);
  } finally {
    context.close();
  }
});

test('partially uploaded batches recover safely and converge on retry', async () => {
  const context = cloudFixture();
  const requests = [
    {
      content: 'Partial batch item one must survive a retry.',
      namespace: 'partial-batch',
      type: 'fact' as const,
      idempotency_key: 'partial-batch-item-one',
    },
    {
      content: 'Partial batch item two must survive a retry.',
      namespace: 'partial-batch',
      type: 'fact' as const,
      idempotency_key: 'partial-batch-item-two',
    },
  ];
  try {
    context.drive.failNextAppend = true;
    await assert.rejects(() => context.engine.rememberBatch(requests), /simulated Drive outage/);
    assert.equal(context.store.count('partial-batch', true), 1);

    const retried = await context.engine.rememberBatch(requests);
    assert.equal(retried.length, 2);
    assert.equal(new Set(retried.map(memory => memory.id)).size, 2);

    const recovered = await context.engine.list('partial-batch', 10);
    assert.equal(recovered.length, 2);
    assert.equal(context.drive.events.length, 2);
  } finally {
    context.close();
  }
});

test('maintenance cycle reuses one cloud materialization', async () => {
  const context = cloudFixture();
  try {
    const result = await context.engine.runMaintenanceCycle({
      namespace: 'maintenance-test',
      applyDecay: false,
      backup: false,
      prune: false,
      includeReport: false,
    });
    assert.equal(result.namespace, 'maintenance-test');
    assert.equal(result.backup, null);
    assert.equal(result.retention, null);
    assert.equal(context.drive.loadCount, 1);
    assert.equal(context.drive.leaseAcquisitions, 1);
  } finally {
    context.close();
  }
});

test('cloud recall does not mutate canonical access counters in the ephemeral cache', async () => {
  const memory = MemorySchema.parse({
    id: '33333333-3333-5333-8333-333333333333',
    namespace: 'read-test',
    type: 'fact',
    content: 'Read-only cloud recall must remain deterministic across warm instances.',
    metadata: {
      confidence: 0.9,
      importance: 8,
      status: 'active',
      tags: ['deterministic'],
      entities: [],
      related_ids: [],
      supersedes_ids: [],
      contradictions: [],
      version: 1,
      access_count: 0,
      is_secret: false,
      redacted: false,
    },
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  });
  const context = cloudFixture([memory]);
  try {
    await context.engine.recall({ query: 'deterministic warm instances', namespace: 'read-test', limit: 5 });
    await context.engine.recall({ query: 'deterministic warm instances', namespace: 'read-test', limit: 5 });
    assert.equal(context.store.get(memory.id, memory.namespace, true)?.metadata.access_count, 0);
  } finally {
    context.close();
  }
});
