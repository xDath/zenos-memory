import path from 'node:path';
import { createDriveStore, hasDriveConfiguration } from '../app/lib/drive';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

loadZenosRuntimeEnv(path.resolve(import.meta.dirname, '..'));
process.env.ZENOS_MEMORY_STORAGE_MODE = 'drive-events';
const namespace = process.argv[2] || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || process.env.ZENOS_MEMORY_NAMESPACE || 'zenos';

if (!hasDriveConfiguration()) throw new Error('Google Drive is not configured');
const drive = createDriveStore();
const before = await drive.loadCloudState(namespace);
const legacy = await drive.readLegacyMemories(namespace);
let migrated = false;
let state = before;
if (!before.snapshot_id && before.event_count === 0 && before.memories.length === 0 && legacy.length > 0) {
  state = await drive.initializeCloudNamespace(namespace, legacy);
  migrated = true;
}
const compacted = await drive.createCloudSnapshot(state);
if (!compacted.verified) throw new Error('Post-migration cloud snapshot verification failed');
const verified = await drive.loadCloudState(namespace);
if (verified.memories.length !== state.memories.length) {
  throw new Error(`Migration verification count mismatch: expected ${state.memories.length}, got ${verified.memories.length}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  namespace,
  migrated,
  legacy_count: legacy.length,
  cloud_count_before: before.memories.length,
  cloud_count_after: verified.memories.length,
  event_count: verified.event_count,
  snapshot_id: compacted.snapshot.snapshot_id,
  snapshot_verified: compacted.verified,
  indexes_created: {
    search: Boolean(compacted.search_index_file_id),
    graph: Boolean(compacted.graph_index_file_id),
  },
}, null, 2)}\n`);
