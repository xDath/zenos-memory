import crypto from 'node:crypto';
import path from 'node:path';
import { createDriveStore } from '../app/lib/drive';
import { Memory, MemorySchema } from '../app/lib/schema';
import { redactSensitiveText } from '../app/lib/secrets';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

loadZenosRuntimeEnv(path.resolve(import.meta.dirname, '..'));
const secret = process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET;
if (!secret) throw new Error('ETLA_MASTER_SECRET is required');
const sourceUrl = (process.env.ZENOS_MEMORY_LEGACY_URL || 'https://zenos-memory.vercel.app').replace(/\/$/, '');
const namespace = process.argv[2] || 'zenos';
const requestPath = `/api/memory/export?namespace=${encodeURIComponent(namespace)}&format=json`;
const timestamp = Date.now();
const signature = crypto.createHmac('sha256', secret)
  .update(`${timestamp}:GET:${requestPath}`)
  .digest('hex');
const response = await fetch(sourceUrl + requestPath, {
  headers: {
    'x-etla-timestamp': String(timestamp),
    'x-etla-signature': signature,
  },
  signal: AbortSignal.timeout(45_000),
  cache: 'no-store',
});
if (!response.ok) throw new Error(`Legacy export failed with HTTP ${response.status}`);
const payload = await response.json() as {
  exported?: { data?: unknown; count?: number };
};
const raw = payload.exported?.data;
const values = Array.isArray(raw) ? raw : [];

function normalizeLegacy(input: unknown): Memory | null {
  const parsed = MemorySchema.safeParse(input);
  if (!parsed.success) return null;
  const memory = parsed.data;
  if (memory.type === 'credential' || memory.metadata.is_secret) {
    const service = memory.metadata.credential_for || 'unknown';
    return MemorySchema.parse({
      ...memory,
      type: 'secret_reference',
      content: `vault://legacy/${service}/${memory.id}`,
      metadata: {
        ...memory.metadata,
        status: 'archived',
        is_secret: false,
        redacted: true,
        secret_reference: `vault://legacy/${service}/${memory.id}`,
        tags: [...new Set([...(memory.metadata.tags || []), 'legacy-secret-redacted'])],
      },
    });
  }
  const safeContent = redactSensitiveText(memory.content);
  if (safeContent === memory.content) return memory;
  return MemorySchema.parse({
    ...memory,
    content: safeContent,
    metadata: {
      ...memory.metadata,
      redacted: true,
      tags: [...new Set([...(memory.metadata.tags || []), 'legacy-content-redacted'])],
    },
  });
}

const memories = values.map(normalizeLegacy).filter((memory): memory is Memory => Boolean(memory));
const drive = createDriveStore();
const before = await drive.loadCloudState(namespace);
if (memories.length === 0) {
  process.stdout.write(`${JSON.stringify({ ok: true, namespace, source_count: 0, migrated: false, reason: 'legacy-export-empty' })}\n`);
  process.exit(0);
}
if (before.memories.length > 0 && process.env.ZENOS_MEMORY_FORCE_LEGACY_MIGRATION !== 'true') {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    namespace,
    source_count: memories.length,
    cloud_count: before.memories.length,
    migrated: false,
    reason: 'cloud-namespace-already-populated',
  }, null, 2)}\n`);
  process.exit(0);
}
const state = {
  namespace,
  memories,
  cursor: before.cursor,
  event_count: before.event_count,
  snapshot_id: before.snapshot_id,
  revision: crypto.createHash('sha256').update(JSON.stringify(memories)).digest('hex'),
};
const uploaded = await drive.createCloudSnapshot(state);
if (!uploaded.verified) throw new Error('Migrated cloud snapshot failed verification');
const verified = await drive.loadCloudState(namespace);
if (verified.memories.length !== memories.length) {
  throw new Error(`Legacy migration count mismatch: ${verified.memories.length}/${memories.length}`);
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  namespace,
  source_count: values.length,
  valid_count: memories.length,
  migrated: true,
  redacted_legacy_secrets: memories.filter(memory => memory.type === 'secret_reference').length,
  snapshot_id: uploaded.snapshot.snapshot_id,
  snapshot_verified: uploaded.verified,
  indexes_created: true,
}, null, 2)}\n`);
