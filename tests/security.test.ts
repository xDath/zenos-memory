import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';
import {
  authenticateTokenExchange,
  issueEtlaToken,
  sha256Body,
  validateApiKey,
  verifyEtlaSignature,
  verifyEtlaToken,
} from '../app/lib/auth';
import { publicError, SensitiveDataError, StorageError } from '../app/lib/errors';
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

test('v2 HMAC verifies before consuming nonce and token exchange rejects replay', async () => {
  const secret = randomBytes(32).toString('hex');
  const timestamp = Date.now();
  const nonce = randomBytes(18).toString('base64url');
  const bodyHash = sha256Body('');
  const canonical = ['zenos-memory-signature-v2', timestamp, nonce, 'POST', '/api/auth', bodyHash].join('\n');
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  const headers = {
    'x-etla-timestamp': String(timestamp),
    'x-etla-nonce': nonce,
    'x-etla-content-sha256': bodyHash,
  };
  const invalid = new Request('https://memory.example/api/auth', {
    method: 'POST',
    headers: { ...headers, 'x-etla-signature': '0'.repeat(64) },
  });
  const signed = new Request('https://memory.example/api/auth', {
    method: 'POST',
    headers: { ...headers, 'x-etla-signature': signature },
  });

  assert.equal(verifyEtlaSignature(invalid, secret), false);
  assert.equal(verifyEtlaSignature(signed, secret), true);

  const secondNonce = randomBytes(18).toString('base64url');
  const secondCanonical = ['zenos-memory-signature-v2', timestamp, secondNonce, 'POST', '/api/auth', bodyHash].join('\n');
  const exchange = new Request('https://memory.example/api/auth', {
    method: 'POST',
    headers: {
      ...headers,
      'x-etla-nonce': secondNonce,
      'x-etla-signature': createHmac('sha256', secret).update(secondCanonical).digest('hex'),
    },
  });
  const previousSecret = process.env.ETLA_MASTER_SECRET;
  const previousMode = process.env.ZENOS_MEMORY_STORAGE_MODE;
  try {
    process.env.ETLA_MASTER_SECRET = secret;
    delete process.env.ZENOS_MEMORY_STORAGE_MODE;
    assert.equal(await authenticateTokenExchange(exchange), true);
    assert.equal(await authenticateTokenExchange(exchange), false);
  } finally {
    if (previousSecret === undefined) delete process.env.ETLA_MASTER_SECRET;
    else process.env.ETLA_MASTER_SECRET = previousSecret;
    if (previousMode === undefined) delete process.env.ZENOS_MEMORY_STORAGE_MODE;
    else process.env.ZENOS_MEMORY_STORAGE_MODE = previousMode;
  }
});

test('production endpoints reject direct HMAC and require scoped bearer tokens', () => {
  const secret = randomBytes(32).toString('hex');
  const timestamp = Date.now();
  const nonce = randomBytes(18).toString('base64url');
  const bodyHash = sha256Body('');
  const canonical = ['zenos-memory-signature-v2', timestamp, nonce, 'GET', '/api/memory/stats', bodyHash].join('\n');
  const request = new Request('https://memory.example/api/memory/stats', {
    headers: {
      'x-etla-timestamp': String(timestamp),
      'x-etla-nonce': nonce,
      'x-etla-content-sha256': bodyHash,
      'x-etla-signature': createHmac('sha256', secret).update(canonical).digest('hex'),
    },
  });
  withEnvironment({ NODE_ENV: 'production', ETLA_MASTER_SECRET: secret }, () => {
    assert.equal(validateApiKey(request), false);
  });
});

test('server error logging never serializes raw causes or secret-bearing details', () => {
  const marker = 'do-not-log-this-sensitive-marker';
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    publicError(
      new StorageError('Drive operation failed', new Error(`authorization=Bearer ${marker}`)),
      'security-log-test',
    );
  } finally {
    console.error = original;
  }

  const rendered = inspect(calls, { depth: 10 });
  assert.equal(rendered.includes(marker), false);
  assert.equal(rendered.includes('STORAGE_ERROR'), true);
  assert.equal(rendered.includes('cause_name'), true);
});

test('unexpected provider errors log bounded status metadata without their message', () => {
  const marker = 'provider-message-secret-marker';
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    publicError(Object.assign(new Error(marker), {
      code: 'E_PROVIDER',
      response: { status: 403, data: { token: marker } },
    }), 'provider-log-test');
  } finally {
    console.error = original;
  }

  const rendered = inspect(calls, { depth: 10 });
  assert.equal(rendered.includes(marker), false);
  assert.equal(rendered.includes('provider_status: 403'), true);
  assert.equal(rendered.includes("provider_code: 'E_PROVIDER'"), true);
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
