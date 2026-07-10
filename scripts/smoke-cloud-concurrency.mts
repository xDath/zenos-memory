import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createDriveStore } from '../app/lib/drive';
import { ConflictError } from '../app/lib/errors';
import { MemoryEngine } from '../app/lib/memory-engine';
import { SqliteMemoryStore } from '../app/lib/sqlite-store';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

loadZenosRuntimeEnv(path.resolve(import.meta.dirname, '..'));
process.env.ZENOS_MEMORY_STORAGE_MODE = 'drive-events';
process.env.ZENOS_MEMORY_CLOUD_REFRESH_MS = '0';
process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START = 'false';
process.env.ZENOS_MEMORY_WRITE_LEASE_MS = '90000';

const namespace = `concurrency-smoke-${Date.now()}`;
const databasePaths = [1, 2, 3].map(index => `/tmp/zenos-concurrency-${process.pid}-${index}.sqlite`);
const stores = databasePaths.map(filename => new SqliteMemoryStore(filename));
const engines = stores.slice(0, 2).map(store => new MemoryEngine({ store, driveBackup: createDriveStore() }));

async function cleanup() {
  for (const store of stores) store.close();
  for (const filename of databasePaths) {
    for (const suffix of ['', '-shm', '-wal']) await rm(`${filename}${suffix}`, { force: true });
  }
}

try {
  const leaseStoreA = createDriveStore();
  const leaseStoreB = createDriveStore();
  const firstLease = await leaseStoreA.acquireCloudLease(namespace, 'exclusive-probe', 'probe-a', 15_000, 3_000);
  let contentionRejected = false;
  let unexpectedLease = null;
  let contentionError: unknown = null;
  try {
    unexpectedLease = await leaseStoreB.acquireCloudLease(namespace, 'exclusive-probe', 'probe-b', 15_000, 1_000);
  } catch (error) {
    contentionError = error;
    contentionRejected = error instanceof ConflictError || (error instanceof Error && error.message.includes('Timed out waiting for Drive lease'));
  }
  if (!contentionRejected) {
    throw new Error(`Drive lease allowed two owners concurrently: ${JSON.stringify({
      firstLease,
      unexpectedLease,
      contentionError: contentionError instanceof Error ? { name: contentionError.name, message: contentionError.message } : contentionError,
    })}`);
  }
  await leaseStoreA.releaseCloudLease(firstLease);
  const secondLease = await leaseStoreB.acquireCloudLease(namespace, 'exclusive-probe', 'probe-b', 15_000, 3_000);
  await leaseStoreB.releaseCloudLease(secondLease);

  const [first, second] = await Promise.all([
    engines[0].remember({
      namespace,
      type: 'fact',
      content: 'Alpha writer records the deployment region during serverless contention.',
      idempotency_key: `writer-a-${namespace}`,
    }),
    engines[1].remember({
      namespace,
      type: 'fact',
      content: 'Beta writer records a graph-index maintenance decision in parallel.',
      idempotency_key: `writer-b-${namespace}`,
    }),
  ]);

  const sameKey = `same-key-${namespace}`;
  const [retryA, retryB] = await Promise.all([
    engines[0].remember({
      namespace,
      type: 'fact',
      content: 'Idempotent retry records the verified snapshot checksum exactly once.',
      idempotency_key: sameKey,
    }),
    engines[1].remember({
      namespace,
      type: 'fact',
      content: 'Idempotent retry records the verified snapshot checksum exactly once.',
      idempotency_key: sameKey,
    }),
  ]);
  if (retryA.id !== retryB.id) throw new Error('Cross-instance idempotency did not converge');

  const coldEngine = new MemoryEngine({ store: stores[2], driveBackup: createDriveStore() });
  const recovered = await coldEngine.list(namespace, 20);
  const expected = new Set([first.id, second.id, retryA.id]);
  for (const id of expected) {
    if (!recovered.some(memory => memory.id === id)) throw new Error(`Cold materialization lost concurrent memory ${id}`);
  }
  if (recovered.filter(memory => memory.id === retryA.id).length !== 1) {
    throw new Error('Cold materialization returned duplicate idempotent memories');
  }

  for (const memory of recovered) {
    await coldEngine.forget(memory.id, namespace, memory.metadata.version);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    namespace,
    recovered: recovered.length,
    checks: [
      'exclusive-drive-cas-lease',
      'lease-handoff',
      'parallel-cross-instance-writes',
      'parallel-global-idempotency',
      'cold-start-convergence',
    ],
  }, null, 2)}\n`);
} finally {
  await cleanup();
  await createDriveStore().trashCloudNamespace(namespace).catch(() => ({ trashed_roots: 0 }));
}
