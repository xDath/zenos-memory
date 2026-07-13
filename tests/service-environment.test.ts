import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Memory service credential is least-privilege and maps the smartest Gemini model', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zenos-memory-env-'));
  try {
    const memory = path.join(directory, 'memory.env');
    const runtime = path.join(directory, 'runtime.env');
    const output = path.join(directory, 'prepared.env');
    writeFileSync(memory, [
      'ZENOS_MEMORY_SECRET=memory-secret',
      'GOOGLE_OAUTH_REFRESH_TOKEN=drive-token',
      'UNRELATED_PROVIDER_API_KEY=must-not-cross-boundary',
      'MEMORY_EMBEDDING_MODEL=existing-real-provider',
    ].join('\n'));
    writeFileSync(runtime, [
      'ZENOS_LLM_API_KEY=router-secret',
      'ZENOS_RUNTIME_API_KEY=must-not-cross-boundary',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      path.resolve('scripts/prepare-service-environment.mjs'),
      output,
      memory,
      '--runtime',
      runtime,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const prepared = readFileSync(output, 'utf8');
    assert.match(prepared, /^ZENOS_MEMORY_SECRET=memory-secret$/m);
    assert.match(prepared, /^GOOGLE_OAUTH_REFRESH_TOKEN=drive-token$/m);
    assert.match(prepared, /^MEMORY_LLM_API_KEY=router-secret$/m);
    assert.match(prepared, /^MEMORY_LLM_MODEL=ag\/gemini-pro-agent$/m);
    assert.match(prepared, /^MEMORY_SEMANTIC_EXPANSION_MODEL=ag\/gemini-3\.5-flash-low$/m);
    assert.doesNotMatch(prepared, /UNRELATED_PROVIDER|ZENOS_RUNTIME_API_KEY|must-not-cross-boundary/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
