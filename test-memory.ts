import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryEngine } from './app/lib/memory-engine';
import { SqliteMemoryStore } from './app/lib/sqlite-store';

async function main() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zenos-memory-smoke-'));
  const store = new SqliteMemoryStore(path.join(directory, 'memory.sqlite'));
  const engine = new MemoryEngine({ store, driveBackup: null });
  try {
    const preference = await engine.remember({
      content: 'The user prefers direct implementation with a concise final report.',
      type: 'preference',
      namespace: 'smoke',
      metadata: { tags: ['style'], confidence: 0.95, importance: 9 },
    });
    await engine.remember({
      content: 'Zenos Memory uses transactional SQLite and immutable Google Drive backups.',
      type: 'project',
      namespace: 'smoke',
      metadata: { tags: ['architecture'], confidence: 0.95, importance: 10 },
    });

    const recalled = await engine.recall({ query: 'preferred communication style', namespace: 'smoke', limit: 5 });
    assert.equal(recalled[0]?.id, preference.id);
    assert.equal((await engine.getStats('smoke')).total, 2);
    assert.equal(await engine.forget(preference.id, 'smoke', preference.metadata.version), true);
    assert.equal((await engine.list('smoke', 10)).some(memory => memory.id === preference.id), false);
    assert.equal((await engine.readiness()).storage.ok, true);
    process.stdout.write('Zenos Memory smoke test passed\n');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
