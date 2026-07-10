#!/usr/bin/env node
import path from 'node:path';
import { ZenosMemoryClient } from '../sdk/js/zenos-memory-client.mjs';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
loadZenosRuntimeEnv(projectRoot);

async function main() {
  const client = new ZenosMemoryClient({
    baseUrl: process.env.ZENOS_MEMORY_URL || 'https://zenos-memory.vercel.app',
    namespace: process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos',
    clientId: 'zenos-manual-maintenance',
    timeoutMs: 120_000,
  });
  const result = await client.request('POST', '/api/memory/scheduler', {
    namespace: process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos',
    apply_decay: true,
    backup: true,
    store_report: true,
  }, { scopes: ['memory:admin'] });
  process.stdout.write(`${JSON.stringify({
    success: result.success,
    namespace: result.namespace,
    decayed: result.decayed,
    backup: result.backup ? {
      destination: result.backup.destination,
      verified: result.backup.verified,
      count: result.backup.count,
    } : null,
    ready: result.health?.ok,
  })}\n`);
}

void main().catch(error => {
  process.stderr.write(`Zenos maintenance failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
