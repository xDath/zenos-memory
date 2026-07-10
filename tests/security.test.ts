import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { issueEtlaToken, sha256Body, validateApiKey, verifyEtlaToken } from '../app/lib/auth';
import { SensitiveDataError } from '../app/lib/errors';
import { MemoryEngine } from '../app/lib/memory-engine';
import { SqliteMemoryStore } from '../app/lib/sqlite-store';

function withEnvironment(values: Record<string, string | undefined>, operation: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('scoped tokens enforce read/write boundaries', () => {
  const secret = randomBytes(32).toString('hex');
  const readToken = issueEtlaToken(secret, { scopes: ['memory:read'], subject: 'test' });
  assert.ok(verifyEtlaToken(readToken, secret, 'memory:read'));
  assert.equal(verifyEtlaToken(readToken, secret, 'memory:write'), null);
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'test' });
  assert.ok(verifyEtlaToken(writeToken, secret, 'memory:read'));
  assert.ok(verifyEtlaToken(writeToken, secret, 'memory:write'));
});

test('v2 HMAC token exchange rejects replayed nonces', () => {
  const secret = randomBytes(32).toString('hex');
  const timestamp = Date.now();
  const nonce = randomBytes(18).toString('base64url');
  const request = new Request('https://memory.example/api/auth', { method: 'POST' });
  const bodyHash = sha256Body('');
  const canonical = ['zenos-memory-signature-v2', timestamp, nonce, 'POST', '/api/auth', bodyHash].join('\n');
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  const signed = new Request(request, {
    headers: {
      'x-etla-timestamp': String(timestamp),
      'x-etla-nonce': nonce,
      'x-etla-content-sha256': bodyHash,
      'x-etla-signature': signature,
    },
  });
  withEnvironment({ NODE_ENV: 'production', ETLA_MASTER_SECRET: secret }, () => {
    assert.equal(validateApiKey(signed), true);
    assert.equal(validateApiKey(signed), false);
  });
});

test('raw assigned secrets are rejected while vault references are accepted', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zenos-security-test-'));
  const store = new SqliteMemoryStore(path.join(directory, 'memory.sqlite'));
  const engine = new MemoryEngine({ store, driveBackup: null });
  try {
    await assert.rejects(
      () => engine.remember({
        content: 'password=definitely-not-a-real-production-value',
        namespace: 'security',
        type: 'fact',
      }),
      SensitiveDataError,
    );
    const reference = await engine.remember({
      content: 'vault://production/deployment',
      namespace: 'security',
      type: 'secret_reference',
    });
    assert.equal(reference.type, 'secret_reference');
    assert.deepEqual(await engine.recall({ query: 'deployment', namespace: 'security', limit: 10 }), []);
    assert.equal((await engine.recall({ query: 'deployment', namespace: 'security', type: 'secret_reference', limit: 10 }))[0]?.id, reference.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
