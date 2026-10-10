import test from 'node:test';
import assert from 'node:assert/strict';
import { memorySigningKeyring } from '../app/lib/auth';
const names = ['ZENOS_MEMORY_SIGNING_KEYS', 'ZENOS_MEMORY_CLIENT_SIGNING_KEYS', 'ZENOS_MEMORY_ACTIVE_KID', 'ETLA_MASTER_SECRET', 'ZENOS_MEMORY_SECRET'];
test('client signing identities preserve production identities and active signer', () => {
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    process.env.ZENOS_MEMORY_SIGNING_KEYS = JSON.stringify({production: 'p'.repeat(48)});
    process.env.ZENOS_MEMORY_CLIENT_SIGNING_KEYS = JSON.stringify({alte: 'a'.repeat(48), production: 'x'.repeat(48), invalid: 'short'});
    process.env.ZENOS_MEMORY_ACTIVE_KID = 'production';
    const ring = memorySigningKeyring();
    assert.equal(ring?.activeKid, 'production');
    assert.equal(ring?.keys.get('production'), 'p'.repeat(48));
    assert.equal(ring?.keys.get('alte'), 'a'.repeat(48));
    assert.equal(ring?.keys.has('invalid'), false);
  } finally {
    for (const n of names) saved[n] === undefined ? delete process.env[n] : process.env[n] = saved[n];
  }
});
