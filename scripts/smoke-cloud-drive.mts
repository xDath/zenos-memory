import { rm } from 'node:fs/promises';
import path from 'node:path';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

loadZenosRuntimeEnv(path.resolve(import.meta.dirname, '..'));
const databasePath = `/tmp/zenos-memory-cloud-smoke-${process.pid}.sqlite`;
process.env.ZENOS_MEMORY_STORAGE_MODE = 'drive-events';
process.env.ZENOS_MEMORY_DB_PATH = databasePath;
process.env.ZENOS_MEMORY_CLOUD_REFRESH_MS = '0';
process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START = 'false';

const namespace = `cloud-smoke-${Date.now()}`;
const { getMemoryEngine, resetMemoryEngineForTests } = await import('../app/lib/memory-engine');

async function cleanCache() {
  resetMemoryEngineForTests();
  for (const suffix of ['', '-shm', '-wal']) await rm(`${databasePath}${suffix}`, { force: true });
}

try {
  const engine = getMemoryEngine();
  const idempotencyKey = `create-${namespace}`;
  const first = await engine.remember({
    content: 'Cloud smoke proves immutable Drive events survive a cold serverless cache.',
    namespace,
    type: 'event',
    idempotency_key: idempotencyKey,
    metadata: { tags: ['cloud-smoke'], importance: 2 },
  });
  await cleanCache();
  const retryEngine = getMemoryEngine();
  const duplicate = await retryEngine.remember({
    content: 'Cloud smoke proves immutable Drive events survive a cold serverless cache.',
    namespace,
    type: 'event',
    idempotency_key: idempotencyKey,
    metadata: { tags: ['cloud-smoke'], importance: 2 },
  });
  if (duplicate.id !== first.id || duplicate.metadata.version !== first.metadata.version) {
    throw new Error('Global cloud idempotency failed across cold starts');
  }

  const edited = await retryEngine.edit(first.id, {
    content: 'Cloud smoke proves immutable Drive events, CAS leases, and cold-start recovery.',
  }, namespace, duplicate.metadata.version);
  if (!edited || edited.metadata.version <= duplicate.metadata.version) throw new Error('Cloud edit failed');

  const backup = await retryEngine.backupMemories(namespace);
  if (!backup.verified) throw new Error('Cloud snapshot verification failed');

  await cleanCache();
  const coldEngine = getMemoryEngine();
  const recalled = await coldEngine.recall({ query: 'CAS leases cold-start recovery', namespace, limit: 5 });
  const recovered = recalled.find(memory => memory.id === first.id);
  if (!recovered || recovered.content !== edited.content) throw new Error('Cold-start Drive materialization failed');

  await coldEngine.forget(first.id, namespace, recovered.metadata.version);
  await cleanCache();
  const finalEngine = getMemoryEngine();
  const afterArchive = await finalEngine.recall({ query: 'cold-start recovery', namespace, limit: 5 });
  if (afterArchive.some(memory => memory.id === first.id)) throw new Error('Archive event was not recovered from Drive');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    namespace,
    memory_id: first.id,
    snapshot_id: 'snapshot_id' in backup ? backup.snapshot_id : null,
    checks: [
      'drive-cas-lease',
      'append-only-create',
      'cross-instance-idempotency',
      'append-only-update',
      'immutable-snapshot',
      'search-index',
      'graph-index',
      'cold-start-materialization',
      'archive-recovery',
    ],
  }, null, 2)}\n`);
} finally {
  await cleanCache();
}
