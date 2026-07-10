import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCloudEvent,
  buildCloudEvent,
  buildCloudSnapshot,
  deterministicEventId,
  deterministicMemoryId,
  materializeCloudState,
  sha256,
  validateCloudEvent,
  validateCloudSnapshot,
} from '../app/lib/cloud-events';
import { Memory, MemorySchema } from '../app/lib/schema';

function memory(id: string, content: string, version = 1, updatedAt = '2026-07-10T00:00:00.000Z'): Memory {
  return MemorySchema.parse({
    id,
    namespace: 'cloud-test',
    type: 'fact',
    content,
    metadata: {
      confidence: 0.9,
      importance: 7,
      status: 'active',
      tags: ['cloud'],
      entities: [],
      related_ids: [],
      supersedes_ids: [],
      contradictions: [],
      version,
      access_count: 0,
      is_secret: false,
      redacted: false,
    },
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: updatedAt,
  });
}

const firstId = '11111111-1111-5111-8111-111111111111';

test('deterministic identifiers converge duplicate serverless writes', () => {
  assert.equal(
    deterministicMemoryId('cloud-test', 'fact', sha256('same content')),
    deterministicMemoryId('cloud-test', 'fact', sha256('same content')),
  );
  assert.equal(
    deterministicEventId('cloud-test', 'remember', 'request-42'),
    deterministicEventId('cloud-test', 'retry-with-different-internal-action', 'request-42'),
  );
});

test('event checksums reject tampering', () => {
  const event = buildCloudEvent({
    namespace: 'cloud-test',
    action: 'memory_created',
    idempotencyKey: 'request-1',
    occurredAt: '2026-07-10T00:00:01.000Z',
    changes: [{ operation: 'upsert', memory: memory(firstId, 'Original') }],
  });
  assert.equal(validateCloudEvent(event).event_id, event.event_id);
  assert.throws(() => validateCloudEvent({
    ...event,
    changes: [{ operation: 'upsert', memory: memory(firstId, 'Tampered') }],
  }));
});

test('materialization is ordered, idempotent and cold-start reproducible', () => {
  const created = buildCloudEvent({
    namespace: 'cloud-test',
    action: 'memory_created',
    idempotencyKey: 'create',
    occurredAt: '2026-07-10T00:00:01.000Z',
    changes: [{ operation: 'upsert', memory: memory(firstId, 'Version one') }],
  });
  const updated = buildCloudEvent({
    namespace: 'cloud-test',
    action: 'memory_updated',
    idempotencyKey: 'update',
    occurredAt: '2026-07-10T00:00:02.000Z',
    changes: [{
      operation: 'upsert',
      memory: memory(firstId, 'Version two', 2, '2026-07-10T00:00:02.000Z'),
    }],
  });
  const state = materializeCloudState({
    namespace: 'cloud-test',
    events: [updated, created, created],
  });
  assert.equal(state.memories.length, 1);
  assert.equal(state.memories[0].content, 'Version two');
  assert.equal(state.event_count, 2);

  const repeated = materializeCloudState({ namespace: 'cloud-test', events: [created, updated] });
  assert.equal(repeated.revision, state.revision);
  assert.deepEqual(repeated.memories, state.memories);
});

test('snapshot plus delta events rebuilds the exact state', () => {
  const created = buildCloudEvent({
    namespace: 'cloud-test',
    action: 'memory_created',
    occurredAt: '2026-07-10T00:00:01.000Z',
    changes: [{ operation: 'upsert', memory: memory(firstId, 'Before snapshot') }],
  });
  const base = materializeCloudState({ namespace: 'cloud-test', events: [created] });
  const snapshot = buildCloudSnapshot(base);
  assert.equal(validateCloudSnapshot(snapshot).checksum, snapshot.checksum);

  const archived = buildCloudEvent({
    namespace: 'cloud-test',
    action: 'memory_archived',
    occurredAt: '2026-07-10T00:00:03.000Z',
    changes: [{
      operation: 'archive',
      memory_id: firstId,
      expected_version: 1,
      archived_at: '2026-07-10T00:00:03.000Z',
    }],
  });
  const rebuilt = materializeCloudState({ namespace: 'cloud-test', snapshot, events: [created, archived] });
  assert.equal(rebuilt.memories.length, 1);
  assert.equal(rebuilt.memories[0].metadata.status, 'archived');
  assert.equal(rebuilt.memories[0].metadata.version, 2);
});

test('duplicate IDs converge to the newest version during snapshot materialization', () => {
  const older = memory(firstId, 'Older duplicate', 1, '2026-07-10T00:00:01.000Z');
  const newer = memory(firstId, 'Newer duplicate', 2, '2026-07-10T00:00:02.000Z');
  const state = materializeCloudState({
    namespace: 'cloud-test',
    snapshot: buildCloudSnapshot({
      namespace: 'cloud-test',
      memories: [older, newer],
      cursor: null,
      event_count: 0,
      snapshot_id: null,
      revision: 'fixture',
    }),
    events: [],
  });
  assert.equal(state.memories.length, 1);
  assert.equal(state.memories[0].content, 'Newer duplicate');
});

test('event reducer ignores stale updates and applies namespace replacement', () => {
  const current = memory(firstId, 'Current', 3, '2026-07-10T00:00:03.000Z');
  const stale = buildCloudEvent({
    namespace: 'cloud-test',
    action: 'memory_updated',
    occurredAt: '2026-07-10T00:00:04.000Z',
    changes: [{ operation: 'upsert', memory: memory(firstId, 'Stale', 2, '2026-07-10T00:00:02.000Z') }],
  });
  assert.equal(applyCloudEvent([current], stale)[0].content, 'Current');

  const replacement = memory('22222222-2222-5222-8222-222222222222', 'Replacement');
  const replaced = buildCloudEvent({
    namespace: 'cloud-test',
    action: 'snapshot_restored',
    occurredAt: '2026-07-10T00:00:05.000Z',
    changes: [{ operation: 'replace_namespace', memories: [replacement] }],
  });
  assert.deepEqual(applyCloudEvent([current], replaced).map(item => item.id), [replacement.id]);
});
