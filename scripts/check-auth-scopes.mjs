#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

loadZenosRuntimeEnv(path.resolve(import.meta.dirname, '..'));
const secret = process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET;
if (!secret) throw new Error('Zenos secret is not configured');
const timestamp = Date.now();
const nonce = crypto.randomBytes(18).toString('base64url');
const bodyHash = crypto.createHash('sha256').update('').digest('hex');
const canonical = ['zenos-memory-signature-v2', timestamp, nonce, 'POST', '/api/auth', bodyHash].join('\n');
const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
const baseUrl = (process.env.ZENOS_MEMORY_URL || 'https://zenos-memory.vercel.app').replace(/\/$/, '');
const response = await fetch(`${baseUrl}/api/auth`, {
  method: 'POST',
  headers: {
    'x-etla-timestamp': String(timestamp),
    'x-etla-nonce': nonce,
    'x-etla-content-sha256': bodyHash,
    'x-etla-signature': signature,
    'x-etla-client-id': 'zenos-auth-diagnostic',
    'x-etla-requested-scopes': 'memory:admin',
  },
  signal: AbortSignal.timeout(10_000),
});
const data = await response.json();
let protectedStatus = null;
let protectedError = null;
if (typeof data.token === 'string') {
  const protectedResponse = await fetch(`${baseUrl}/api/memory/scheduler`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${data.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      namespace: 'diagnostic',
      apply_decay: false,
      backup: false,
      store_report: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const protectedData = await protectedResponse.json();
  protectedStatus = protectedResponse.status;
  protectedError = protectedData.error || null;
}
process.stdout.write(`${JSON.stringify({
  status: response.status,
  success: data.success,
  scopes: data.scopes,
  expires_in: data.expires_in,
  error_code: data.error?.code,
  protected_status: protectedStatus,
  protected_error: protectedError,
})}\n`);
