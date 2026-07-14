#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const credentialPath = process.argv[2]?.trim();
if (credentialPath) process.env.CREDENTIALS_DIRECTORY = path.dirname(credentialPath);
loadZenosRuntimeEnv(projectRoot);

const secret = process.env.ETLA_MASTER_SECRET?.trim() || process.env.ZENOS_MEMORY_SECRET?.trim();
if (!secret) {
  process.stderr.write('Zenos Memory readiness prewarm failed: no signing secret is configured\n');
  process.exit(1);
}

function issueReadToken() {
  const now = Date.now();
  const claims = {
    ver: 1,
    sub: 'zenos-memory-service-prewarm',
    scopes: ['memory:read'],
    iat: now,
    exp: now + 5 * 60_000,
    jti: randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`zm1.${encoded}`, 'utf8').digest('hex');
  return `zm1.${encoded}.${signature}`;
}

const authorization = `Bearer ${issueReadToken()}`;
let lastError;
for (let attempt = 1; attempt <= 40; attempt += 1) {
  try {
    const response = await fetch('http://127.0.0.1:3091/api/memory/health-check?namespace=zenos', {
      headers: { authorization },
      signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body?.ready !== true) throw new Error('readiness contract returned ready=false');
    process.stdout.write('Zenos Memory Drive readiness cache prewarmed\n');
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 40) await new Promise(resolve => setTimeout(resolve, 250));
  }
}

process.stderr.write(`Zenos Memory readiness prewarm failed: ${lastError instanceof Error ? lastError.message : 'unknown error'}\n`);
process.exit(1);
