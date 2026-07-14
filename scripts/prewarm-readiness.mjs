#!/usr/bin/env node
import { createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

function issueReadToken(secret) {
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

export async function prewarmReadiness() {
  const secret = process.env.ETLA_MASTER_SECRET?.trim() || process.env.ZENOS_MEMORY_SECRET?.trim();
  if (!secret) throw new Error('no signing secret is configured');
  const authorization = `Bearer ${issueReadToken(secret)}`;
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
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 40) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('unknown readiness error');
}

async function main() {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const credentialPath = process.argv[2]?.trim();
  if (credentialPath) process.env.CREDENTIALS_DIRECTORY = path.dirname(credentialPath);
  loadZenosRuntimeEnv(projectRoot);
  await prewarmReadiness();
  process.stdout.write('Zenos Memory Drive readiness cache prewarmed\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`Zenos Memory readiness prewarm failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
