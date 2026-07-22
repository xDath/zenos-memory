import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  CloudMemoryEvent,
  CloudMemoryEventSchema,
  cloudCursor,
  compareCloudCursor,
  sha256,
  validateCloudEvent,
} from './cloud-events';
import { normalizeNamespace } from './schema';

export const EventPackDescriptorSchema = z.object({
  pack_id: z.string().length(64),
  namespace: z.string().min(1).max(96),
  cursor_start: z.string().min(1).max(256),
  cursor_end: z.string().min(1).max(256),
  checksum: z.string().length(64),
  event_count: z.number().int().positive().max(100_000),
  uncompressed_bytes: z.number().int().positive(),
  compressed_bytes: z.number().int().positive(),
  file_id: z.string().min(1).max(512).optional(),
  created_at: z.string().datetime(),
});

export const EventPackManifestSchema = z.object({
  format: z.literal('zenos-memory-event-pack-manifest-v1'),
  manifest_id: z.string().length(64),
  namespace: z.string().min(1).max(96),
  generated_at: z.string().datetime(),
  packs: z.array(EventPackDescriptorSchema).max(10_000),
  through_cursor: z.string().max(256).nullable(),
  event_count: z.number().int().nonnegative(),
  checksum: z.string().length(64),
});

export type EventPackDescriptor = z.infer<typeof EventPackDescriptorSchema>;
export type EventPackManifest = z.infer<typeof EventPackManifestSchema>;

function stableEvents(events: CloudMemoryEvent[]): CloudMemoryEvent[] {
  const seen = new Set<string>();
  return events
    .map(validateCloudEvent)
    .sort((left, right) => compareCloudCursor(
      cloudCursor(left.occurred_at, left.event_id),
      cloudCursor(right.occurred_at, right.event_id),
    ))
    .filter((event) => {
      if (seen.has(event.event_id)) return false;
      seen.add(event.event_id);
      return true;
    });
}

export function encodeEventPack(eventsInput: CloudMemoryEvent[]): {
  descriptor: EventPackDescriptor;
  compressed: Buffer;
} {
  const events = stableEvents(eventsInput);
  if (!events.length) throw new Error('An event pack requires at least one event');
  const namespace = normalizeNamespace(events[0].namespace);
  if (events.some((event) => event.namespace !== namespace)) {
    throw new Error('An event pack cannot mix namespaces');
  }
  const ndjson = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  const compressed = gzipSync(Buffer.from(ndjson, 'utf8'), { level: 9 });
  const checksum = sha256(ndjson);
  const cursorStart = cloudCursor(events[0].occurred_at, events[0].event_id);
  const cursorEnd = cloudCursor(events.at(-1)!.occurred_at, events.at(-1)!.event_id);
  const packId = sha256({
    format: 'zenos-memory-event-pack-v1',
    namespace,
    cursorStart,
    cursorEnd,
    checksum,
    eventCount: events.length,
  });
  return {
    descriptor: EventPackDescriptorSchema.parse({
      pack_id: packId,
      namespace,
      cursor_start: cursorStart,
      cursor_end: cursorEnd,
      checksum,
      event_count: events.length,
      uncompressed_bytes: Buffer.byteLength(ndjson),
      compressed_bytes: compressed.byteLength,
      created_at: new Date().toISOString(),
    }),
    compressed,
  };
}

export function decodeEventPack(
  compressed: Buffer,
  descriptorInput: EventPackDescriptor,
): CloudMemoryEvent[] {
  const descriptor = EventPackDescriptorSchema.parse(descriptorInput);
  const ndjson = gunzipSync(compressed).toString('utf8');
  if (sha256(ndjson) !== descriptor.checksum) throw new Error(`Event pack ${descriptor.pack_id} checksum mismatch`);
  const events = stableEvents(ndjson
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => CloudMemoryEventSchema.parse(JSON.parse(line))));
  if (events.length !== descriptor.event_count) throw new Error(`Event pack ${descriptor.pack_id} event count mismatch`);
  if (events.some((event) => event.namespace !== descriptor.namespace)) {
    throw new Error(`Event pack ${descriptor.pack_id} namespace mismatch`);
  }
  const first = cloudCursor(events[0].occurred_at, events[0].event_id);
  const last = cloudCursor(events.at(-1)!.occurred_at, events.at(-1)!.event_id);
  if (first !== descriptor.cursor_start || last !== descriptor.cursor_end) {
    throw new Error(`Event pack ${descriptor.pack_id} cursor range mismatch`);
  }
  return events;
}

export function buildEventPackManifest(input: {
  namespace: string;
  packs: EventPackDescriptor[];
  generatedAt?: string;
}): EventPackManifest {
  const namespace = normalizeNamespace(input.namespace);
  const packs = input.packs
    .map((pack) => EventPackDescriptorSchema.parse(pack))
    .filter((pack) => pack.namespace === namespace)
    .sort((left, right) => compareCloudCursor(left.cursor_start, right.cursor_start));
  let previousEnd: string | undefined;
  for (const pack of packs) {
    if (previousEnd && compareCloudCursor(pack.cursor_start, previousEnd) <= 0) {
      throw new Error('Event pack manifest contains an overlapping or unordered cursor range');
    }
    previousEnd = pack.cursor_end;
  }
  const generatedAt = input.generatedAt || new Date().toISOString();
  const unsigned = {
    format: 'zenos-memory-event-pack-manifest-v1' as const,
    namespace,
    generated_at: generatedAt,
    packs,
    through_cursor: packs.at(-1)?.cursor_end || null,
    event_count: packs.reduce((sum, pack) => sum + pack.event_count, 0),
  };
  const checksum = sha256(unsigned);
  return EventPackManifestSchema.parse({
    ...unsigned,
    manifest_id: sha256({ namespace, throughCursor: unsigned.through_cursor, checksum }),
    checksum,
  });
}

export function validateEventPackManifest(input: unknown): EventPackManifest {
  const manifest = EventPackManifestSchema.parse(input);
  const unsigned = {
    format: manifest.format,
    namespace: manifest.namespace,
    generated_at: manifest.generated_at,
    packs: manifest.packs,
    through_cursor: manifest.through_cursor,
    event_count: manifest.event_count,
  };
  if (sha256(unsigned) !== manifest.checksum) throw new Error(`Event pack manifest ${manifest.manifest_id} checksum mismatch`);
  const rebuilt = buildEventPackManifest({
    namespace: manifest.namespace,
    packs: manifest.packs,
    generatedAt: manifest.generated_at,
  });
  if (rebuilt.manifest_id !== manifest.manifest_id) throw new Error(`Event pack manifest ${manifest.manifest_id} identity mismatch`);
  return manifest;
}

export function eventsCoveredByManifest(
  events: CloudMemoryEvent[],
  manifest: EventPackManifest,
): CloudMemoryEvent[] {
  const validated = validateEventPackManifest(manifest);
  return stableEvents(events).filter((event) => {
    const cursor = cloudCursor(event.occurred_at, event.event_id);
    return validated.packs.some((pack) => (
      compareCloudCursor(cursor, pack.cursor_start) >= 0
      && compareCloudCursor(cursor, pack.cursor_end) <= 0
    ));
  });
}
