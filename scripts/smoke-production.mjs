#!/usr/bin/env node
import crypto from 'node:crypto';
import { ZenosMemoryClient } from '../sdk/js/zenos-memory-client.mjs';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

loadZenosRuntimeEnv();

const baseUrl = (
  process.env.ZENOS_MEMORY_SMOKE_URL
  || process.env.ZENOS_MEMORY_URL
  || 'https://zenos-memory.vercel.app'
).replace(/\/$/, '');
const namespace = `smoke-${Date.now()}`;
const client = new ZenosMemoryClient({ baseUrl, namespace, clientId: 'zenos-production-smoke' });

async function assertPublicEndpoints() {
  const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  if (!health.ok || (await health.json()).status !== 'ok') throw new Error('Liveness endpoint failed');
  const status = await fetch(`${baseUrl}/api/memory/public-status`, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  const payload = await status.json();
  if (!status.ok || payload.version !== '2.1.0' || payload.security?.raw_secret_storage !== false) {
    throw new Error('Public capability endpoint failed');
  }
}

async function main() {
  await assertPublicEndpoints();
  const idempotencyKey = `smoke-${crypto.randomUUID()}`;
  const content = 'Production smoke confirms Drive event persistence and scoped authentication.';
  const remembered = await client.remember(content, {
    type: 'event',
    namespace,
    metadata: { tags: ['smoke'], importance: 2 },
    idempotencyKey,
  });
  const memory = remembered.memory;
  if (!memory?.id) throw new Error('Remember did not return a memory');

  const duplicate = await client.remember(content, {
    type: 'event',
    namespace,
    metadata: { tags: ['smoke'], importance: 2 },
    idempotencyKey,
  });
  if (duplicate.memory?.id !== memory.id) throw new Error('Idempotency check failed');

  const recalled = await client.recall('Drive event persistence authentication', { namespace, limit: 5 });
  if (!recalled.results?.some(item => item.id === memory.id)) throw new Error('Recall check failed');

  const edited = await client.edit(memory.id, {
    content: 'Production smoke confirms Vercel compute, Drive event persistence, recall, and scoped authentication.',
  }, { namespace, expectedVersion: memory.metadata.version });
  if (edited.memory?.metadata?.version !== memory.metadata.version + 1) throw new Error('Optimistic update check failed');

  const stats = await client.stats({ namespace });
  const activeCount = Number(stats.stats?.total || 0) - Number(stats.stats?.archived || 0);
  if (activeCount !== 1) {
    throw new Error(`Stats check failed: ${JSON.stringify(stats.stats)}`);
  }

  const readiness = await client.health({ namespace });
  if (!readiness.ready) throw new Error('Authenticated readiness check failed');
  const architecture = readiness.readiness?.architecture || readiness.architecture;
  if (baseUrl.includes('vercel.app') && architecture !== 'vercel-compute-drive-event-store') {
    throw new Error(`Production endpoint is not using the Drive event architecture: ${architecture || 'unknown'}`);
  }

  await client.forget(memory.id, {
    namespace,
    expectedVersion: edited.memory.metadata.version,
  });
  const afterDelete = await client.recall('Drive event persistence authentication', { namespace, limit: 5 });
  if (afterDelete.results?.some(item => item.id === memory.id)) throw new Error('Archive check failed');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    base_url: baseUrl,
    namespace,
    architecture,
    checks: [
      'liveness',
      'public-capabilities',
      'token-exchange',
      'idempotency',
      'recall',
      'optimistic-update',
      'stats',
      'readiness',
      'archive',
    ],
  }, null, 2)}\n`);
}

void main().catch(error => {
  process.stderr.write(`Production smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
