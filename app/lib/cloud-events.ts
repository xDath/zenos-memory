import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Memory, MemorySchema, normalizeNamespace } from './schema';

export const CloudMemoryChangeSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('upsert'),
    memory: MemorySchema,
  }),
  z.object({
    operation: z.literal('archive'),
    memory_id: z.string().uuid(),
    expected_version: z.number().int().positive().optional(),
    archived_at: z.string().datetime(),
  }),
  z.object({
    operation: z.literal('hard_delete'),
    memory_id: z.string().uuid(),
  }),
  z.object({
    operation: z.literal('replace_namespace'),
    memories: z.array(MemorySchema).max(20_000),
  }),
]);

export type CloudMemoryChange = z.infer<typeof CloudMemoryChangeSchema>;

export const CloudMemoryEventSchema = z.object({
  format: z.literal('zenos-memory-event-v1'),
  event_id: z.string().min(16).max(128),
  namespace: z.string().min(1).max(96),
  occurred_at: z.string().datetime(),
  actor: z.string().min(1).max(160).default('system'),
  action: z.string().min(1).max(160),
  request_id: z.string().max(160).optional(),
  idempotency_key_hash: z.string().length(64).optional(),
  changes: z.array(CloudMemoryChangeSchema).min(1).max(1000),
  previous_cursor: z.string().max(256).optional(),
  checksum: z.string().length(64),
});

export type CloudMemoryEvent = z.infer<typeof CloudMemoryEventSchema>;

export const CloudSnapshotSchema = z.object({
  format: z.literal('zenos-memory-cloud-snapshot-v1'),
  snapshot_id: z.string().min(16).max(128),
  namespace: z.string().min(1).max(96),
  generated_at: z.string().datetime(),
  through_cursor: z.string().max(256).nullable(),
  event_count: z.number().int().nonnegative(),
  checksum: z.string().length(64),
  memories: z.array(MemorySchema).max(20_000),
});

export type CloudSnapshot = z.infer<typeof CloudSnapshotSchema>;

export interface MaterializedCloudState {
  namespace: string;
  memories: Memory[];
  cursor: string | null;
  event_count: number;
  snapshot_id: string | null;
  revision: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

export function cloudCursor(occurredAt: string, eventId: string): string {
  return `${occurredAt}:${eventId}`;
}

export function compareCloudCursor(left: string | null | undefined, right: string | null | undefined): number {
  return String(left || '').localeCompare(String(right || ''));
}

export function deterministicEventId(namespace: string, _action: string, idempotencyKey?: string): string {
  if (!idempotencyKey) return randomUUID();
  return sha256(`event:${normalizeNamespace(namespace)}:${idempotencyKey}`);
}

export function deterministicMemoryId(namespace: string, type: string, contentHash: string): string {
  const hash = sha256(`memory:${normalizeNamespace(namespace)}:${type}:${contentHash}`);
  const chars = hash.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ['8', '9', 'a', 'b'][parseInt(chars[16], 16) % 4];
  const raw = chars.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

export function buildCloudEvent(input: {
  namespace: string;
  actor?: string;
  action: string;
  requestId?: string;
  idempotencyKey?: string;
  changes: CloudMemoryChange[];
  previousCursor?: string | null;
  occurredAt?: string;
}): CloudMemoryEvent {
  const namespace = normalizeNamespace(input.namespace);
  const requestedTime = new Date(input.occurredAt || Date.now());
  const previousTime = input.previousCursor ? new Date(input.previousCursor.slice(0, 24)) : null;
  const occurredAt = previousTime && requestedTime.getTime() <= previousTime.getTime()
    ? new Date(previousTime.getTime() + 1).toISOString()
    : requestedTime.toISOString();
  const eventId = deterministicEventId(namespace, input.action, input.idempotencyKey);
  const base = {
    format: 'zenos-memory-event-v1' as const,
    event_id: eventId,
    namespace,
    occurred_at: occurredAt,
    actor: input.actor || 'system',
    action: input.action,
    request_id: input.requestId,
    idempotency_key_hash: input.idempotencyKey ? sha256(input.idempotencyKey) : undefined,
    changes: input.changes,
    previous_cursor: input.previousCursor || undefined,
  };
  return CloudMemoryEventSchema.parse({ ...base, checksum: sha256(base) });
}

export function validateCloudEvent(input: unknown): CloudMemoryEvent {
  const parsed = CloudMemoryEventSchema.parse(input);
  const { checksum, ...unsigned } = parsed;
  if (sha256(unsigned) !== checksum) throw new Error(`Cloud event ${parsed.event_id} checksum mismatch`);
  return parsed;
}

function applyUpsert(state: Map<string, Memory>, incoming: Memory): void {
  const current = state.get(incoming.id);
  if (!current) {
    state.set(incoming.id, MemorySchema.parse(incoming));
    return;
  }
  const currentVersion = current.metadata.version || 1;
  const incomingVersion = incoming.metadata.version || 1;
  if (incomingVersion > currentVersion) {
    state.set(incoming.id, MemorySchema.parse(incoming));
    return;
  }
  if (incomingVersion === currentVersion && incoming.updated_at > current.updated_at) {
    state.set(incoming.id, MemorySchema.parse(incoming));
  }
}

export function canonicalizeMemories(memories: Memory[]): Memory[] {
  const state = new Map<string, Memory>();
  for (const memory of memories) applyUpsert(state, MemorySchema.parse(memory));
  return [...state.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function applyCloudEvent(memories: Memory[], event: CloudMemoryEvent): Memory[] {
  const state = new Map(canonicalizeMemories(memories).map(memory => [memory.id, memory]));
  for (const change of event.changes) {
    if (change.operation === 'replace_namespace') {
      state.clear();
      for (const memory of change.memories) state.set(memory.id, MemorySchema.parse(memory));
      continue;
    }
    if (change.operation === 'upsert') {
      applyUpsert(state, change.memory);
      continue;
    }
    if (change.operation === 'hard_delete') {
      state.delete(change.memory_id);
      continue;
    }
    const current = state.get(change.memory_id);
    if (!current) continue;
    const version = current.metadata.version || 1;
    if (change.expected_version !== undefined && version !== change.expected_version) continue;
    state.set(change.memory_id, MemorySchema.parse({
      ...current,
      metadata: {
        ...current.metadata,
        status: 'archived',
        version: version + 1,
        provenance: {
          ...(current.metadata.provenance || {}),
          valid_to: change.archived_at,
        },
      },
      updated_at: change.archived_at,
    }));
  }
  return [...state.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function materializeCloudState(input: {
  namespace: string;
  snapshot?: CloudSnapshot | null;
  events: CloudMemoryEvent[];
}): MaterializedCloudState {
  const namespace = normalizeNamespace(input.namespace);
  const snapshot = input.snapshot ? CloudSnapshotSchema.parse(input.snapshot) : null;
  let memories = canonicalizeMemories(snapshot?.memories || []);
  let cursor = snapshot?.through_cursor || null;
  let eventCount = snapshot?.event_count || 0;
  const seen = new Set<string>();
  const ordered = input.events
    .map(validateCloudEvent)
    .filter(event => event.namespace === namespace)
    .sort((a, b) => compareCloudCursor(cloudCursor(a.occurred_at, a.event_id), cloudCursor(b.occurred_at, b.event_id)));

  for (const event of ordered) {
    const eventCursor = cloudCursor(event.occurred_at, event.event_id);
    if (cursor && compareCloudCursor(eventCursor, cursor) <= 0) continue;
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    memories = applyCloudEvent(memories, event);
    cursor = eventCursor;
    eventCount += 1;
  }

  const canonical = canonicalizeMemories(memories);
  return {
    namespace,
    memories: canonical,
    cursor,
    event_count: eventCount,
    snapshot_id: snapshot?.snapshot_id || null,
    revision: sha256({ namespace, cursor, count: canonical.length, memories: canonical }),
  };
}

export function buildCloudSnapshot(state: MaterializedCloudState): CloudSnapshot {
  const generatedAt = new Date().toISOString();
  const memories = canonicalizeMemories(state.memories);
  const checksum = sha256(memories);
  const snapshotId = sha256(`snapshot:${state.namespace}:${state.cursor || 'origin'}:${state.event_count}:${checksum}`);
  return CloudSnapshotSchema.parse({
    format: 'zenos-memory-cloud-snapshot-v1',
    snapshot_id: snapshotId,
    namespace: state.namespace,
    generated_at: generatedAt,
    through_cursor: state.cursor,
    event_count: state.event_count,
    checksum,
    memories,
  });
}

export function validateCloudSnapshot(input: unknown): CloudSnapshot {
  const snapshot = CloudSnapshotSchema.parse(input);
  if (sha256(snapshot.memories) !== snapshot.checksum) {
    throw new Error(`Cloud snapshot ${snapshot.snapshot_id} checksum mismatch`);
  }
  return snapshot;
}
