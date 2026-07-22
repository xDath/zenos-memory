import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCloudEvent,
  materializeCloudState,
} from '../app/lib/cloud-events';
import {
  buildEventPackManifest,
  decodeEventPack,
  encodeEventPack,
  validateEventPackManifest,
} from '../app/lib/event-packs';
import { MemorySchema } from '../app/lib/schema';

function memory(id: string, content: string, version = 1) {
  return MemorySchema.parse({
    id,
    namespace: 'event-pack-test',
    type: 'fact',
    content,
    metadata: {
      status: 'active',
      version,
      confidence: 0.9,
      importance: 7,
      tags: ['event-pack-test'],
      entities: [],
      related_ids: [],
      supersedes_ids: [],
      contradictions: [],
    },
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: `2026-07-20T00:00:0${Math.min(version, 9)}.000Z`,
  });
}

function events() {
  const first = buildCloudEvent({
    namespace: 'event-pack-test',
    action: 'memory_created',
    idempotencyKey: 'pack-event-1',
    occurredAt: '2026-07-20T00:00:01.000Z',
    changes: [{ operation: 'upsert', memory: memory('11111111-1111-5111-8111-111111111111', 'Initial fact') }],
  });
  const second = buildCloudEvent({
    namespace: 'event-pack-test',
    action: 'memory_updated',
    idempotencyKey: 'pack-event-2',
    occurredAt: '2026-07-20T00:00:02.000Z',
    previousCursor: `${first.occurred_at}:${first.event_id}`,
    changes: [{ operation: 'upsert', memory: memory('11111111-1111-5111-8111-111111111111', 'Validated fact', 2) }],
  });
  const third = buildCloudEvent({
    namespace: 'event-pack-test',
    action: 'memory_created',
    idempotencyKey: 'pack-event-3',
    occurredAt: '2026-07-20T00:00:03.000Z',
    previousCursor: `${second.occurred_at}:${second.event_id}`,
    changes: [{ operation: 'upsert', memory: memory('22222222-2222-5222-8222-222222222222', 'Second fact') }],
  });
  return [first, second, third];
}

test('immutable gzip event packs preserve checksums, cursor order, and materialized state', () => {
  const source = events();
  const encoded = encodeEventPack(source);
  assert.equal(encoded.descriptor.event_count, 3);
  assert.ok(encoded.descriptor.compressed_bytes < encoded.descriptor.uncompressed_bytes);
  const decoded = decodeEventPack(encoded.compressed, encoded.descriptor);
  assert.deepEqual(decoded.map((event) => event.event_id), source.map((event) => event.event_id));
  assert.deepEqual(decoded.map((event) => event.checksum), source.map((event) => event.checksum));
  const individualState = materializeCloudState({ namespace: 'event-pack-test', events: source });
  const packedState = materializeCloudState({ namespace: 'event-pack-test', events: decoded });
  assert.equal(packedState.revision, individualState.revision);
  assert.equal(packedState.cursor, individualState.cursor);
  assert.deepEqual(packedState.memories, individualState.memories);
});

test('event pack manifests reject tampering and overlapping cursor ranges', () => {
  const first = encodeEventPack(events().slice(0, 2)).descriptor;
  const second = encodeEventPack(events().slice(2)).descriptor;
  const manifest = buildEventPackManifest({ namespace: 'event-pack-test', packs: [first, second] });
  assert.deepEqual(validateEventPackManifest(manifest), manifest);
  assert.throws(() => validateEventPackManifest({ ...manifest, event_count: 999 }), /checksum/i);
  assert.throws(() => buildEventPackManifest({
    namespace: 'event-pack-test',
    packs: [first, { ...second, cursor_start: first.cursor_end }],
  }), /overlapping|unordered/i);
});

test('corrupt event pack bytes never materialize silently', () => {
  const encoded = encodeEventPack(events());
  const corrupt = Buffer.from(encoded.compressed);
  corrupt[Math.max(0, corrupt.length - 4)] ^= 0xff;
  assert.throws(() => decodeEventPack(corrupt, encoded.descriptor));
});
