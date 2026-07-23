import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { ZenosMemoryClient } from '../sdk/js/zenos-memory-client.mjs';

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

test('JavaScript SDK signs kid-bound v3 exchanges with the dedicated Memory secret', () => {
  const secret = 'sdk-v3-signing-secret-that-is-long-enough-for-tests';
  const kid = 'memory-test-current';
  const client = new ZenosMemoryClient({ secret, kid, baseUrl: 'https://memory.test' });
  const headers = client.signTokenExchange(['memory:read', 'memory:write']);
  assert.equal(headers['x-etla-kid'], kid);
  assert.equal(headers['x-etla-signature-version'], '3');
  const canonical = [
    'zenos-memory-signature-v3',
    kid,
    headers['x-etla-timestamp'],
    headers['x-etla-nonce'],
    'POST',
    '/api/auth',
    EMPTY_SHA256,
  ].join('\n');
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  assert.equal(headers['x-etla-signature'], expected);
});

test('JavaScript SDK retains v2 exchange only when no kid is configured', () => {
  const secret = 'sdk-v2-transition-secret-that-is-long-enough-for-tests';
  const client = new ZenosMemoryClient({ secret, kid: '', baseUrl: 'https://memory.test' });
  const headers = client.signTokenExchange(['memory:read']);
  assert.equal(headers['x-etla-kid'], undefined);
  const canonical = [
    'zenos-memory-signature-v2',
    headers['x-etla-timestamp'],
    headers['x-etla-nonce'],
    'POST',
    '/api/auth',
    EMPTY_SHA256,
  ].join('\n');
  assert.equal(
    headers['x-etla-signature'],
    crypto.createHmac('sha256', secret).update(canonical).digest('hex'),
  );
});
