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
const continuityNamespace = `${namespace}-continuity`;
const timeoutMs = Math.max(30_000, Math.min(Number(process.env.ZENOS_MEMORY_SMOKE_TIMEOUT_MS || 180_000), 300_000));
const client = new ZenosMemoryClient({
  baseUrl,
  namespace,
  clientId: 'zenos-production-smoke',
  timeoutMs,
});
let currentStage = 'initialization';

async function withTransientRetry(stage, operation, attempts = 3) {
  currentStage = stage;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const transientLeaseConflict = status === 409
        && error?.code === 'VERSION_CONFLICT'
        && /Drive lease/i.test(String(error?.message || ''));
      if ((!transientLeaseConflict && ![502, 503, 504].includes(status)) || attempt === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function continuityPacketHash(packet) {
  const hashable = { ...packet };
  delete hashable.contentHash;
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(hashable))).digest('hex');
}

function buildContinuityPacket({ sourceCursor, previousCheckpointId, validationText }) {
  const packet = {
    version: 'continuity-v2',
    sessionId: `production-smoke-${namespace}`,
    turnId: `turn-${sourceCursor}`,
    sourceCursor,
    estimatedTokens: 190_000,
    head: [{
      role: 'user',
      content: 'Current goal: preserve the active Runtime upgrade acceptance criteria through compaction.',
      message_id: 'smoke-goal',
    }],
    milestones: [
      {
        kind: 'decision',
        text: 'Decision: Runtime is the single checkpoint authority and Memory stores verified checkpoints.',
        sourceMessageIds: ['smoke-decision'],
        sourceHash: 'a'.repeat(64),
        occurredAt: '2026-07-21T00:00:00.000Z',
      },
      {
        kind: 'constraint',
        text: 'Constraint: do not supersede a checkpoint until evidence validation passes.',
        sourceMessageIds: ['smoke-constraint'],
        sourceHash: 'b'.repeat(64),
        occurredAt: '2026-07-21T00:00:01.000Z',
      },
      ...(validationText ? [{
        kind: 'validation',
        text: validationText,
        sourceMessageIds: ['smoke-validation-2'],
        sourceHash: 'c'.repeat(64),
        occurredAt: '2026-07-21T00:01:00.000Z',
      }] : []),
    ],
    recentTail: [{
      role: 'user',
      content: 'Pending work: validate the checkpoint chain and continue with the exact next action.',
      message_id: 'smoke-tail',
    }],
    activeToolState: [{
      id: 'smoke-test-tool',
      tool: 'test',
      status: 'passed',
      summary: 'Validation result: Runtime typecheck and deterministic tests passed.',
      changedFiles: ['app/lib/gateway-continuity.ts'],
      artifactIds: ['smoke-test-report'],
      sourceMessageIds: ['smoke-validation'],
      sourceHash: 'd'.repeat(64),
      occurredAt: '2026-07-21T00:00:30.000Z',
    }],
    openWork: [{
      id: 'smoke-open-work',
      kind: 'validate',
      text: 'Run the production ContinuityPacket v2 chain smoke.',
      status: 'queued',
      acceptanceCriteria: ['Both checkpoints pass faithfulness and chain validation.'],
      blockers: [],
      sourceMessageIds: ['smoke-tail'],
      sourceHash: 'e'.repeat(64),
    }],
    previousCheckpointId,
    contentHash: '',
  };
  return { ...packet, contentHash: continuityPacketHash(packet) };
}

async function assertContinuityV2() {
  const firstPacket = buildContinuityPacket({ sourceCursor: 'msg:100:production-smoke-first' });
  const firstIdempotencyKey = `continuity-first-${crypto.randomUUID()}`;
  const first = await withTransientRetry(
    'continuity-v2-first-checkpoint',
    () => client.request('POST', '/api/memory/compact', {
      messages: [],
      continuity_packet: firstPacket,
      source_cursor: firstPacket.sourceCursor,
      namespace: continuityNamespace,
      reason: 'production-continuity-v2-smoke',
      approx_tokens: firstPacket.estimatedTokens,
      session_id: firstPacket.sessionId,
      conversation_id: firstPacket.turnId,
      max_chars: 6_000,
      input_max_chars: 60_000,
      mode: 'dag',
    }, { idempotencyKey: firstIdempotencyKey }),
    5,
  );
  if (!first.success || first.checkpoint_validated !== true || first.faithfulness?.valid !== true) {
    throw new Error(`Continuity v2 first checkpoint failed: ${JSON.stringify({
      success: first.success,
      checkpoint_validated: first.checkpoint_validated,
      faithfulness: first.faithfulness,
    })}`);
  }
  if (!first.compact?.id || first.source_cursor !== firstPacket.sourceCursor) {
    throw new Error('Continuity v2 first checkpoint identity is invalid');
  }

  const secondPacket = buildContinuityPacket({
    sourceCursor: 'msg:101:production-smoke-second',
    previousCheckpointId: first.compact.id,
    validationText: 'Validation: the first production continuity checkpoint passed.',
  });
  const secondIdempotencyKey = `continuity-second-${crypto.randomUUID()}`;
  const second = await withTransientRetry(
    'continuity-v2-second-checkpoint',
    () => client.request('POST', '/api/memory/compact', {
      messages: [],
      continuity_packet: secondPacket,
      source_cursor: secondPacket.sourceCursor,
      previous_checkpoint_id: first.compact.id,
      namespace: continuityNamespace,
      reason: 'production-continuity-v2-chain-smoke',
      approx_tokens: secondPacket.estimatedTokens,
      session_id: secondPacket.sessionId,
      conversation_id: secondPacket.turnId,
      max_chars: 6_000,
      input_max_chars: 60_000,
      mode: 'dag',
    }, { idempotencyKey: secondIdempotencyKey }),
    5,
  );
  if (!second.success || second.checkpoint_validated !== true || second.faithfulness?.valid !== true) {
    throw new Error(`Continuity v2 chained checkpoint failed: ${JSON.stringify({
      success: second.success,
      checkpoint_validated: second.checkpoint_validated,
      faithfulness: second.faithfulness,
    })}`);
  }
  if (
    !second.compact?.id
    || second.compact.id === first.compact.id
    || second.previous_checkpoint_id !== first.compact.id
    || second.source_cursor !== secondPacket.sourceCursor
  ) {
    throw new Error('Continuity v2 checkpoint chain identity is invalid');
  }

  return {
    first: first.compact,
    second: second.compact,
    strategy: second.strategy,
    faithfulnessScore: second.faithfulness?.score,
    namespace: continuityNamespace,
  };
}

async function assertPublicEndpoints() {
  const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 60_000)), cache: 'no-store' });
  if (!health.ok || (await health.json()).status !== 'ok') throw new Error('Liveness endpoint failed');
  const status = await fetch(`${baseUrl}/api/memory/public-status`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 60_000)), cache: 'no-store' });
  const payload = await status.json();
  if (!status.ok || payload.version !== '2.5.0' || payload.security?.raw_secret_storage !== false) {
    throw new Error('Public capability endpoint failed');
  }
}

async function main() {
  currentStage = 'public-endpoints';
  await assertPublicEndpoints();
  const idempotencyKey = `smoke-${crypto.randomUUID()}`;
  const content = 'Production smoke confirms Drive event persistence and scoped authentication.';
  const remembered = await withTransientRetry('remember', () => client.remember(content, {
    type: 'event',
    namespace,
    metadata: { tags: ['smoke'], importance: 2 },
    idempotencyKey,
  }));
  const memory = remembered.memory;
  if (!memory?.id) throw new Error('Remember did not return a memory');

  const duplicate = await withTransientRetry('remember-idempotency', () => client.remember(content, {
    type: 'event',
    namespace,
    metadata: { tags: ['smoke'], importance: 2 },
    idempotencyKey,
  }));
  if (duplicate.memory?.id !== memory.id) throw new Error('Idempotency check failed');

  const recalled = await withTransientRetry(
    'recall',
    () => client.recall('Drive event persistence authentication', { namespace, limit: 5 }),
  );
  if (!recalled.results?.some(item => item.id === memory.id)) throw new Error('Recall check failed');

  const edited = await withTransientRetry('optimistic-edit', () => client.edit(memory.id, {
    content: 'Production smoke confirms Vercel compute, Drive event persistence, recall, and scoped authentication.',
  }, { namespace, expectedVersion: memory.metadata.version }));
  if (edited.memory?.metadata?.version !== memory.metadata.version + 1) throw new Error('Optimistic update check failed');

  const stats = await withTransientRetry('stats', () => client.stats({ namespace }));
  const activeCount = Number(stats.stats?.total || 0) - Number(stats.stats?.archived || 0);
  if (activeCount !== 1) {
    throw new Error(`Stats check failed: ${JSON.stringify(stats.stats)}`);
  }

  const readiness = await withTransientRetry('readiness', () => client.health({ namespace }));
  if (!readiness.ready) throw new Error('Authenticated readiness check failed');
  const architecture = readiness.readiness?.architecture || readiness.architecture;
  if (baseUrl.includes('vercel.app') && architecture !== 'vercel-compute-drive-event-store') {
    throw new Error(`Production endpoint is not using the Drive event architecture: ${architecture || 'unknown'}`);
  }

  const continuity = await assertContinuityV2();

  await withTransientRetry('archive-continuity-second', () => client.forget(continuity.second.id, { namespace: continuity.namespace }));
  await withTransientRetry('archive-continuity-first', () => client.forget(continuity.first.id, { namespace: continuity.namespace }));
  await withTransientRetry('archive-smoke-memory', () => client.forget(memory.id, {
    namespace,
    expectedVersion: edited.memory.metadata.version,
  }));
  const afterDelete = await withTransientRetry(
    'archive-verification',
    () => client.recall('Drive event persistence authentication', { namespace, limit: 5 }),
  );
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
      'continuity-v2-integrity',
      'continuity-v2-faithfulness',
      'continuity-v2-checkpoint-chain',
      'archive',
    ],
    continuity: {
      strategy: continuity.strategy,
      faithfulness_score: continuity.faithfulnessScore,
    },
  }, null, 2)}\n`);
}

void main().catch(error => {
  const detail = error instanceof Error
    ? {
        message: error.message,
        status: error.status,
        code: error.code,
        stage: currentStage,
        request_id: error.requestId,
        stack: process.env.ZENOS_MEMORY_SMOKE_DEBUG === 'true' ? error.stack : undefined,
      }
    : { message: String(error) };
  process.stderr.write(`Production smoke failed: ${JSON.stringify(detail)}\n`);
  process.exitCode = 1;
});
