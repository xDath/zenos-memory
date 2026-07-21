import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { issueEtlaToken } from '../app/lib/auth';
import {
  ContinuityPacketV2,
  ContinuityPacketV2Schema,
  computeContinuityPacketHash,
} from '../app/lib/continuity-packet';
import { resetMemoryEngineForTests } from '../app/lib/memory-engine';
import { resetRateLimitsForTests } from '../app/lib/rate-limit';
import { POST as bootstrapPost } from '../app/api/memory/bootstrap/route';
import { POST as compactPost } from '../app/api/memory/compact/route';
import { POST as cognitiveBriefPost } from '../app/api/memory/cognitive-brief/route';
import { GET as publicStatusGet } from '../app/api/memory/public-status/route';
import { POST as rememberPost } from '../app/api/memory/remember/route';
import { POST as resolveConflictPost } from '../app/api/memory/resolve-conflict/route';
import { POST as revisionPost } from '../app/api/memory/revision/route';

const secret = 'route-contract-secret-that-is-long-enough-for-tests';
let directory = '';

function request(
  pathname: string,
  options: { token?: string; body?: string | Record<string, unknown>; ip?: string; headers?: Record<string, string> } = {},
): NextRequest {
  const body = typeof options.body === 'string' ? options.body : options.body === undefined ? undefined : JSON.stringify(options.body);
  return new NextRequest(`https://memory.test${pathname}`, {
    method: 'POST',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      'x-forwarded-for': options.ip || '203.0.113.10',
      ...options.headers,
    },
    body,
  });
}

interface RouteBody {
  [key: string]: unknown;
  success?: boolean;
  service?: string;
  version?: string;
  security?: { raw_secret_storage?: boolean };
  architecture?: { canonical_store?: string };
  error?: { code?: string; message?: string };
  memory?: { id?: string; namespace?: string };
  compact?: { id?: string; content?: string };
  coverage?: { goal?: boolean; decisions?: boolean; pendingWork?: boolean; artifacts?: boolean; complete?: boolean };
  faithfulness?: { valid?: boolean; score?: number; claims?: number; evidence_backed_claims?: number };
  checkpoint_validated?: boolean;
  source_cursor?: string;
  previous_checkpoint_id?: string;
  llm_telemetry?: { configured?: boolean; succeeded?: boolean; failure_reason?: string | null; attempts?: unknown[] };
  strategy?: string;
  bootstrap?: string;
  sources?: unknown[];
  request_id?: string;
  revision?: string;
  brief?: { content?: string; sections?: Record<string, unknown> };
}

async function json(response: Response): Promise<RouteBody> {
  return await response.json() as RouteBody;
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stressText(label: string, chars: number): string {
  if (chars <= label.length) return label.slice(0, Math.max(1, chars));
  const token = ` ${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-evidence`;
  return `${label}${token.repeat(Math.ceil((chars - label.length) / token.length))}`.slice(0, chars);
}

function continuityStressPacket(input: {
  targetChars: number;
  generation: number;
  previousCheckpointId?: string;
}): ContinuityPacketV2 {
  const headBudget = Math.floor(input.targetChars * 0.12);
  const milestoneBudget = Math.floor(input.targetChars * 0.33);
  const toolBudget = Math.floor(input.targetChars * 0.20);
  const tailBudget = input.targetChars - headBudget - milestoneBudget - toolBudget;
  const occurredAt = (offset: number) => new Date(Date.UTC(2026, 6, 21, 1, input.generation, offset)).toISOString();

  const head: ContinuityPacketV2['head'] = [{
    role: 'user',
    content: 'Current goal: finish the Zenos upgrade from one user command while preserving every acceptance criterion through three compactions.',
    message_id: 'stress-goal',
  }];
  let headChars = head[0].content.length;
  let headIndex = 0;
  while (headChars < headBudget - 200 && head.length < 20) {
    const size = Math.min(28_000, headBudget - headChars - 100);
    const content = stressText(`Original constraints and architecture context ${input.generation}-${headIndex}`, Math.max(200, size));
    head.push({
      role: 'system',
      content,
      message_id: `stress-head-${input.generation}-${headIndex}`,
    });
    headChars += content.length;
    headIndex += 1;
  }

  const milestoneCore = [
    ['decision', 'Decision: Runtime ContinuityCoordinator is the only checkpoint authority.'],
    ['constraint', 'Constraint: destructive, deploy, and secret-sensitive work must fail closed or pause for approval.'],
    ['patch', 'Patch: app/lib/continuity-coordinator.ts and app/lib/command-job.ts contain the durable implementation.'],
    ['validation', `Validation: generation ${input.generation} typecheck and deterministic tests passed.`],
    ['blocker', 'Blocker: event-pack production activation remains disabled until state-hash shadow comparison passes.'],
  ] as const;
  const milestones: ContinuityPacketV2['milestones'] = milestoneCore.map(([kind, text], index) => ({
    kind,
    text,
    sourceMessageIds: [`stress-milestone-${input.generation}-${index}`],
    sourceHash: contentHash(`${kind}:${text}:${input.generation}`),
    occurredAt: occurredAt(index),
  }));
  let milestoneChars = milestones.reduce((sum, item) => sum + item.text.length, 0);
  let milestoneIndex = 0;
  while (milestoneChars < milestoneBudget - 1_000 && milestones.length < 100) {
    const size = Math.min(7_800, milestoneBudget - milestoneChars);
    const text = stressText(`Evidence milestone ${input.generation}-${milestoneIndex}`, size);
    milestones.push({
      kind: milestoneIndex % 2 ? 'tool_result' : 'decision',
      text,
      sourceMessageIds: [`stress-middle-${input.generation}-${milestoneIndex}`],
      sourceHash: contentHash(text),
      occurredAt: occurredAt(10 + milestoneIndex),
    });
    milestoneChars += text.length;
    milestoneIndex += 1;
  }

  const activeToolState: ContinuityPacketV2['activeToolState'] = [{
    id: `stress-test-${input.generation}`,
    tool: 'test',
    status: 'passed',
    summary: `Latest test result: generation ${input.generation} passed the Runtime and Memory deterministic suites.`,
    changedFiles: ['app/lib/continuity-coordinator.ts', 'app/lib/command-job.ts'],
    artifactIds: [`stress-test-report-${input.generation}`],
    sourceMessageIds: [`stress-tool-${input.generation}`],
    sourceHash: contentHash(`stress-tool-${input.generation}`),
    occurredAt: occurredAt(50),
  }];
  let toolChars = activeToolState[0].summary.length;
  let toolIndex = 0;
  while (toolChars < toolBudget - 1_000 && activeToolState.length < 80) {
    const size = Math.min(7_800, toolBudget - toolChars);
    const summary = stressText(`Tool evidence ${input.generation}-${toolIndex}`, size);
    activeToolState.push({
      id: `stress-tool-${input.generation}-${toolIndex}`,
      tool: toolIndex % 2 ? 'repository-read' : 'validation',
      status: 'passed',
      summary,
      changedFiles: [],
      artifactIds: [],
      sourceMessageIds: [`stress-tool-message-${input.generation}-${toolIndex}`],
      sourceHash: contentHash(summary),
      occurredAt: occurredAt(60 + toolIndex),
    });
    toolChars += summary.length;
    toolIndex += 1;
  }

  const recentTail: ContinuityPacketV2['recentTail'] = [];
  let tailChars = 0;
  let tailIndex = 0;
  while (tailChars < tailBudget - 400 && recentTail.length < 160) {
    const size = Math.min(28_000, tailBudget - tailChars - 200);
    const content = stressText(`Recent execution evidence ${input.generation}-${tailIndex}`, Math.max(200, size));
    recentTail.push({
      role: tailIndex % 3 === 0 ? 'tool' : 'assistant',
      content,
      name: tailIndex % 3 === 0 ? 'runtime-evidence' : undefined,
      message_id: `stress-tail-${input.generation}-${tailIndex}`,
    });
    tailChars += content.length;
    tailIndex += 1;
  }
  recentTail.push({
    role: 'user',
    content: 'Next action: continue automatically, finish the remaining validation, then deliver one terminal answer without asking the user to type lanjut.',
    message_id: `stress-final-${input.generation}`,
  });

  const packet = {
    version: 'continuity-v2' as const,
    sessionId: 'route-stress-continuity-session',
    turnId: `stress-turn-${input.generation}`,
    sourceCursor: `stress:${input.generation}:${input.targetChars}`,
    estimatedTokens: Math.ceil(input.targetChars / 4),
    head,
    milestones,
    recentTail,
    activeToolState,
    openWork: [{
      id: `stress-work-${input.generation}`,
      kind: 'validate' as const,
      text: 'Finish deterministic validation and verify checkpoint evidence before final delivery.',
      status: 'queued' as const,
      acceptanceCriteria: [
        'The active goal remains present.',
        'Architecture decisions and changed file paths remain present.',
        'The latest test result, blocker, and next action remain present.',
      ],
      blockers: ['Event-pack activation waits for shadow state-hash parity.'],
      sourceMessageIds: [`stress-final-${input.generation}`],
      sourceHash: contentHash(`stress-work-${input.generation}`),
    }],
    previousCheckpointId: input.previousCheckpointId,
    contentHash: '',
  } satisfies ContinuityPacketV2;
  return { ...packet, contentHash: computeContinuityPacketHash(packet) };
}

function continuityPacket(input: {
  sourceCursor: string;
  previousCheckpointId?: string;
  additionalMilestone?: string;
}): ContinuityPacketV2 {
  const packet = {
    version: 'continuity-v2' as const,
    sessionId: 'route-continuity-session',
    turnId: `turn-${input.sourceCursor}`,
    sourceCursor: input.sourceCursor,
    estimatedTokens: 190_000,
    head: [{
      role: 'user' as const,
      content: 'Current goal: preserve the active Runtime upgrade acceptance criteria through compaction.',
      message_id: 'm0',
    }],
    milestones: [
      {
        kind: 'decision' as const,
        text: 'Decision: Runtime is the single checkpoint authority and Memory stores verified checkpoints.',
        sourceMessageIds: ['m40'],
        sourceHash: 'a'.repeat(64),
        occurredAt: '2026-07-21T00:00:00.000Z',
      },
      {
        kind: 'constraint' as const,
        text: 'Constraint: do not replace the previous checkpoint until evidence validation passes.',
        sourceMessageIds: ['m41'],
        sourceHash: 'b'.repeat(64),
        occurredAt: '2026-07-21T00:00:01.000Z',
      },
      ...(input.additionalMilestone ? [{
        kind: 'validation' as const,
        text: input.additionalMilestone,
        sourceMessageIds: ['m90'],
        sourceHash: 'c'.repeat(64),
        occurredAt: '2026-07-21T00:01:00.000Z',
      }] : []),
    ],
    recentTail: [{
      role: 'user' as const,
      content: 'Pending work: run deterministic tests and continue from the verified checkpoint.',
      message_id: 'm99',
    }],
    activeToolState: [{
      id: 'tool-test-1',
      tool: 'test',
      status: 'passed' as const,
      summary: 'Validation result: Runtime typecheck passed and the changed file is app/lib/gateway-continuity.ts.',
      changedFiles: ['app/lib/gateway-continuity.ts'],
      artifactIds: ['runtime-test-report'],
      sourceMessageIds: ['m80'],
      sourceHash: 'd'.repeat(64),
      occurredAt: '2026-07-21T00:00:30.000Z',
    }],
    openWork: [{
      id: 'work-validate',
      kind: 'validate' as const,
      text: 'Run the full deterministic test suite before final delivery.',
      status: 'queued' as const,
      acceptanceCriteria: ['All relevant deterministic tests pass.'],
      blockers: [],
      sourceMessageIds: ['m99'],
      sourceHash: 'e'.repeat(64),
    }],
    previousCheckpointId: input.previousCheckpointId,
    contentHash: '',
  } satisfies ContinuityPacketV2;
  return { ...packet, contentHash: computeContinuityPacketHash(packet) };
}

test.beforeEach(() => {
  resetMemoryEngineForTests();
  resetRateLimitsForTests();
  directory = mkdtempSync(path.join(os.tmpdir(), 'zenos-route-contract-'));
  Reflect.set(process.env, 'NODE_ENV', 'development');
  process.env.ETLA_MASTER_SECRET = secret;
  process.env.ZENOS_MEMORY_DB_PATH = path.join(directory, 'memory.sqlite');
  process.env.ZENOS_MEMORY_STORAGE_MODE = 'sqlite';
  process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START = 'false';
  delete process.env.ZENOS_MEMORY_API_KEY;
  delete process.env.MEMORY_LLM_MODEL;
  delete process.env.MEMORY_LLM_FALLBACK_MODEL;
  delete process.env.ZENOS_MEMORY_CONTINUITY_LLM_ENABLED;
});

test.afterEach(() => {
  resetMemoryEngineForTests();
  resetRateLimitsForTests();
  rmSync(directory, { recursive: true, force: true });
});

test('public status is unauthenticated, no-store, and exposes the stable service contract', async () => {
  const response = await publicStatusGet();
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.success, true);
  assert.equal(body.service, 'Zenos Memory');
  assert.equal(body.version, '2.5.0');
  assert.equal(body.security?.raw_secret_storage, false);
  assert.equal(body.architecture?.canonical_store?.includes('Google Drive'), true);
});

test('write routes reject missing tokens and read-only tokens with stable 401 errors', async () => {
  const readToken = issueEtlaToken(secret, { scopes: ['memory:read'], subject: 'route-contract' });
  const payload = { content: 'A durable route contract fact.', namespace: 'route-contract', type: 'fact' };

  const missing = await rememberPost(request('/api/memory/remember', { body: payload }));
  const wrongScope = await rememberPost(request('/api/memory/remember', { body: payload, token: readToken }));
  const missingBody = await json(missing);
  const scopeBody = await json(wrongScope);

  assert.equal(missing.status, 401);
  assert.equal(wrongScope.status, 401);
  assert.equal(missing.headers.get('www-authenticate')?.includes('zenos-memory'), true);
  assert.equal(missingBody.error?.code, 'UNAUTHORIZED');
  assert.equal(scopeBody.error?.code, 'UNAUTHORIZED');
});

test('remember validates malformed JSON, rejects raw secrets, and returns a 201 response schema for valid writes', async () => {
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'route-contract' });

  const malformed = await rememberPost(request('/api/memory/remember', { token: writeToken, body: '{' }));
  const secretResponse = await rememberPost(request('/api/memory/remember', {
    token: writeToken,
    body: { content: 'password=never-store-this-value', namespace: 'route-contract', type: 'fact' },
  }));
  const valid = await rememberPost(request('/api/memory/remember', {
    token: writeToken,
    headers: { 'idempotency-key': 'route-contract-write-001' },
    body: { content: 'Runtime Outcome Passports remain observation-only.', namespace: 'route-contract', type: 'fact' },
  }));
  const malformedBody = await json(malformed);
  const secretBody = await json(secretResponse);
  const validBody = await json(valid);

  assert.equal(malformed.status, 400);
  assert.equal(malformedBody.error?.code, 'VALIDATION_ERROR');
  assert.equal(secretResponse.status, 422);
  assert.equal(secretBody.error?.code, 'SENSITIVE_DATA_REJECTED');
  assert.equal(valid.status, 201);
  assert.equal(valid.headers.get('cache-control'), 'no-store');
  assert.equal(validBody.success, true);
  assert.equal(validBody.memory?.namespace, 'route-contract');
  assert.equal(typeof validBody.memory?.id, 'string');
  assert.equal(typeof validBody.request_id, 'string');
});

test('namespace revision is read-scoped and changes after a durable write', async () => {
  const readToken = issueEtlaToken(secret, { scopes: ['memory:read'], subject: 'route-contract' });
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'route-contract' });

  const missing = await revisionPost(request('/api/memory/revision', {
    body: { namespace: 'route-contract' },
  }));
  const beforeResponse = await revisionPost(request('/api/memory/revision', {
    token: readToken,
    body: { namespace: 'route-contract' },
  }));
  const before = await json(beforeResponse);

  await rememberPost(request('/api/memory/remember', {
    token: writeToken,
    headers: { 'idempotency-key': 'route-contract-revision-001' },
    body: { content: 'Revision-aware recall caches invalidate after writes.', namespace: 'route-contract', type: 'fact' },
  }));

  const afterResponse = await revisionPost(request('/api/memory/revision', {
    token: readToken,
    body: { namespace: 'route-contract', force: true },
  }));
  const after = await json(afterResponse);

  assert.equal(missing.status, 401);
  assert.equal(beforeResponse.status, 200);
  assert.equal(afterResponse.status, 200);
  assert.equal(typeof before.revision, 'string');
  assert.equal(typeof after.revision, 'string');
  assert.notEqual(after.revision, before.revision);
});

test('cognitive brief is read-scoped while conflict resolution remains write-scoped', async () => {
  const readToken = issueEtlaToken(secret, { scopes: ['memory:read'], subject: 'route-contract' });
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'route-contract' });

  await rememberPost(request('/api/memory/remember', {
    token: writeToken,
    body: {
      content: 'Decision: Hermes Host is the sole orchestrator and native workers inherit its model.',
      namespace: 'route-contract',
      type: 'decision',
      metadata: { importance: 10, confidence: 0.99 },
    },
  }));

  const missing = await cognitiveBriefPost(request('/api/memory/cognitive-brief', {
    body: { objective: 'Host orchestrator model inheritance', namespace: 'route-contract' },
  }));
  const briefResponse = await cognitiveBriefPost(request('/api/memory/cognitive-brief', {
    token: readToken,
    body: { objective: 'Host orchestrator model inheritance', namespace: 'route-contract', limit: 10, max_chars: 4_000 },
  }));
  const briefBody = await json(briefResponse);
  const wrongScope = await resolveConflictPost(request('/api/memory/resolve-conflict', {
    token: readToken,
    body: { id1: '11111111-1111-4111-8111-111111111111', id2: '22222222-2222-4222-8222-222222222222', namespace: 'route-contract' },
  }));

  assert.equal(missing.status, 401);
  assert.equal(briefResponse.status, 200);
  assert.equal(briefBody.success, true);
  assert.match(String(briefBody.brief?.content), /sole orchestrator/i);
  assert.equal(typeof briefBody.brief?.sections, 'object');
  assert.equal(wrongScope.status, 401);
});

test('compact and bootstrap enforce read/write scopes and preserve bounded handoff response contracts', async () => {
  const readToken = issueEtlaToken(secret, { scopes: ['memory:read'], subject: 'route-contract' });
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'route-contract' });
  const messages = [
    { role: 'user', content: 'Current goal: deploy Runtime 0.4 as a non-root control plane.' },
    { role: 'assistant', content: 'Decision: keep adaptive routing in shadow mode.' },
    { role: 'user', content: 'Pending work: run GitHub remote validation and preserve the artifact.' },
    { role: 'assistant', content: 'Artifact: /var/lib/zenos-runtime/artifacts/validation.json' },
  ];

  const readOnlyCompact = await compactPost(request('/api/memory/compact', {
    token: readToken,
    body: { messages, namespace: 'route-contract', mode: 'dag', max_chars: 4_000 },
  }));
  const compact = await compactPost(request('/api/memory/compact', {
    token: writeToken,
    body: { messages, namespace: 'route-contract', mode: 'dag', max_chars: 4_000, input_max_chars: 40_000 },
  }));
  const compactBody = await json(compact);
  const bootstrap = await bootstrapPost(request('/api/memory/bootstrap', {
    token: readToken,
    body: { namespace: 'route-contract', queries: ['Runtime 0.4 non-root shadow routing pending work'], limit: 10, max_chars: 4_000 },
  }));
  const bootstrapBody = await json(bootstrap);

  assert.equal(readOnlyCompact.status, 401);
  assert.equal(compact.status, 200);
  assert.equal(compactBody.success, true);
  assert.equal(typeof compactBody.compact?.id, 'string');
  assert.equal(compactBody.coverage?.goal, true);
  assert.equal(compactBody.coverage?.decisions, true);
  assert.equal(compactBody.coverage?.pendingWork, true);
  assert.equal(compactBody.coverage?.artifacts, true);
  assert.equal(compactBody.llm_telemetry?.configured, false);
  assert.equal(compactBody.llm_telemetry?.succeeded, false);
  assert.match(String(compactBody.llm_telemetry?.failure_reason), /not configured/i);
  assert.deepEqual(compactBody.llm_telemetry?.attempts, []);
  assert.ok(String(compactBody.compact?.content).length <= 4_000);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrapBody.success, true);
  assert.ok(String(bootstrapBody.bootstrap).includes('Zenos Memory Bootstrap'));
  assert.ok(String(bootstrapBody.bootstrap).length <= 4_000);
  assert.ok(Array.isArray(bootstrapBody.sources));
});

test('ContinuityPacket v2 validates evidence, chains checkpoints, and rejects tampering', async () => {
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'route-contract' });
  const firstPacket = continuityPacket({ sourceCursor: 'msg:100:first' });
  const firstResponse = await compactPost(request('/api/memory/compact', {
    token: writeToken,
    headers: { 'idempotency-key': 'route-continuity-first' },
    body: {
      continuity_packet: firstPacket,
      namespace: 'route-continuity',
      mode: 'dag',
      max_chars: 6_000,
      input_max_chars: 60_000,
    },
  }));
  const first = await json(firstResponse);

  assert.equal(firstResponse.status, 200);
  assert.equal(first.success, true);
  assert.equal(first.source_cursor, firstPacket.sourceCursor);
  assert.equal(first.coverage?.complete, true);
  assert.equal(first.faithfulness?.valid, true);
  assert.ok((first.faithfulness?.claims || 0) > 0);
  assert.equal(first.checkpoint_validated, true);
  assert.equal(typeof first.compact?.id, 'string');

  const secondPacket = continuityPacket({
    sourceCursor: 'msg:101:second',
    previousCheckpointId: first.compact?.id,
    additionalMilestone: 'Validation: the ContinuityPacket checkpoint chain test passed.',
  });
  const secondResponse = await compactPost(request('/api/memory/compact', {
    token: writeToken,
    headers: { 'idempotency-key': 'route-continuity-second' },
    body: {
      continuity_packet: secondPacket,
      namespace: 'route-continuity',
      mode: 'dag',
      max_chars: 6_000,
      input_max_chars: 60_000,
    },
  }));
  const second = await json(secondResponse);

  assert.equal(secondResponse.status, 200);
  assert.equal(second.success, true);
  assert.equal(second.source_cursor, secondPacket.sourceCursor);
  assert.equal(second.previous_checkpoint_id, first.compact?.id);
  assert.equal(second.faithfulness?.valid, true);
  assert.equal(second.checkpoint_validated, true);
  assert.notEqual(second.compact?.id, first.compact?.id);

  const tampered = { ...secondPacket, sourceCursor: 'msg:102:tampered' };
  const invalidResponse = await compactPost(request('/api/memory/compact', {
    token: writeToken,
    body: {
      continuity_packet: tampered,
      namespace: 'route-continuity',
      mode: 'dag',
    },
  }));
  const invalid = await json(invalidResponse);
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalid.error?.code, 'VALIDATION_ERROR');
  assert.match(String(invalid.error?.message), /validation/i);
});

test('ContinuityPacket v2 stays deterministic-first when an LLM is configured unless explicitly opted in', async () => {
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'route-contract' });
  const originalFetch = globalThis.fetch;
  const previous = {
    baseUrl: process.env.MEMORY_LLM_BASE_URL,
    apiKey: process.env.MEMORY_LLM_API_KEY,
    model: process.env.MEMORY_LLM_MODEL,
    semantic: process.env.MEMORY_SEMANTIC_EXPANSION_ENABLED,
    continuityLlm: process.env.ZENOS_MEMORY_CONTINUITY_LLM_ENABLED,
  };
  process.env.MEMORY_LLM_BASE_URL = 'http://llm.test/v1';
  process.env.MEMORY_LLM_API_KEY = 'test-key';
  process.env.MEMORY_LLM_MODEL = 'test-model';
  process.env.MEMORY_SEMANTIC_EXPANSION_ENABLED = 'false';
  delete process.env.ZENOS_MEMORY_CONTINUITY_LLM_ENABLED;
  let providerCalls = 0;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith('http://llm.test')) {
      providerCalls += 1;
      return Response.json({ error: 'continuity must not call the LLM by default' }, { status: 500 });
    }
    return originalFetch(input, init);
  };

  try {
    const packet = continuityPacket({ sourceCursor: 'msg:103:deterministic-first' });
    const response = await compactPost(request('/api/memory/compact', {
      token: writeToken,
      headers: { 'idempotency-key': 'route-continuity-deterministic-first' },
      body: {
        continuity_packet: packet,
        namespace: 'route-continuity-deterministic-first',
        mode: 'dag',
        max_chars: 6_000,
        input_max_chars: 60_000,
      },
    }));
    const body = await json(response);

    assert.equal(response.status, 200, JSON.stringify(body.error || body));
    assert.equal(body.success, true);
    assert.equal(body.checkpoint_validated, true);
    assert.equal(body.strategy, 'deterministic-dag-v3');
    assert.equal(body.llm_telemetry?.configured, true);
    assert.equal(body.llm_telemetry?.succeeded, false);
    assert.deepEqual(body.llm_telemetry?.attempts, []);
    assert.match(String(body.llm_telemetry?.failure_reason), /deterministic compaction by default/i);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.baseUrl === undefined) delete process.env.MEMORY_LLM_BASE_URL;
    else process.env.MEMORY_LLM_BASE_URL = previous.baseUrl;
    if (previous.apiKey === undefined) delete process.env.MEMORY_LLM_API_KEY;
    else process.env.MEMORY_LLM_API_KEY = previous.apiKey;
    if (previous.model === undefined) delete process.env.MEMORY_LLM_MODEL;
    else process.env.MEMORY_LLM_MODEL = previous.model;
    if (previous.semantic === undefined) delete process.env.MEMORY_SEMANTIC_EXPANSION_ENABLED;
    else process.env.MEMORY_SEMANTIC_EXPANSION_ENABLED = previous.semantic;
    if (previous.continuityLlm === undefined) delete process.env.ZENOS_MEMORY_CONTINUITY_LLM_ENABLED;
    else process.env.ZENOS_MEMORY_CONTINUITY_LLM_ENABLED = previous.continuityLlm;
  }
});

test('three consecutive large ContinuityPacket compactions preserve goal, decisions, evidence, blockers, and next action', async () => {
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'route-stress-contract' });
  const sizes = [160_000, 300_000, 500_000];
  let previousCheckpointId: string | undefined;

  for (let index = 0; index < sizes.length; index += 1) {
    const packet = continuityStressPacket({
      targetChars: sizes[index],
      generation: index + 1,
      previousCheckpointId,
    });
    const wirePacket = JSON.parse(JSON.stringify(packet)) as ContinuityPacketV2;
    assert.equal(computeContinuityPacketHash(wirePacket), packet.contentHash);
    const parsedPacket = ContinuityPacketV2Schema.parse(wirePacket);
    assert.equal(computeContinuityPacketHash(parsedPacket), packet.contentHash);
    const response = await compactPost(request('/api/memory/compact', {
      token: writeToken,
      headers: { 'idempotency-key': `route-stress-continuity-${index + 1}` },
      body: {
        continuity_packet: packet,
        namespace: 'route-stress-continuity',
        mode: 'dag',
        max_chars: 12_000,
        input_max_chars: sizes[index],
      },
    }));
    const body = await json(response);
    const compact = String(body.compact?.content || '');

    assert.equal(response.status, 200, JSON.stringify(body.error || body));
    assert.equal(body.success, true);
    assert.equal(body.coverage?.complete, true);
    assert.equal(body.faithfulness?.valid, true);
    assert.equal(body.checkpoint_validated, true);
    assert.equal(body.source_cursor, packet.sourceCursor);
    assert.equal(body.previous_checkpoint_id, previousCheckpointId);
    assert.match(compact, /finish the Zenos upgrade|one user command/i);
    assert.match(compact, /only checkpoint authority/i);
    assert.match(compact, /continuity-coordinator\.ts|command-job\.ts/i);
    assert.match(compact, /deterministic tests passed|deterministic suites/i);
    assert.match(compact, /event-pack|state-hash/i);
    assert.match(compact, /continue automatically|remaining validation|terminal answer/i);
    assert.equal(typeof body.compact?.id, 'string');
    assert.notEqual(body.compact?.id, previousCheckpointId);
    previousCheckpointId = body.compact?.id;
  }
});

test('compact rejects oversized request bodies before JSON processing', async () => {
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'route-contract' });
  const oversizedBody = JSON.stringify({
    messages: [{ role: 'user', content: 'x'.repeat(770_000) }],
    namespace: 'route-contract',
    mode: 'dag',
  });
  const response = await compactPost(request('/api/memory/compact', {
    token: writeToken,
    body: oversizedBody,
  }));
  const body = await json(response);

  assert.equal(response.status, 413);
  assert.equal(body.error?.code, 'PAYLOAD_TOO_LARGE');
});

test('route-level rate limits return a stable 429 contract before body parsing', async () => {
  const writeToken = issueEtlaToken(secret, { scopes: ['memory:write'], subject: 'route-contract' });
  let last: Response | undefined;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    for (let index = 0; index < 91; index += 1) {
      last = await rememberPost(request('/api/memory/remember', {
        token: writeToken,
        ip: '198.51.100.77',
        body: {},
      }));
    }
  } finally {
    console.error = originalError;
  }
  const body = await json(last as Response);
  assert.equal(last?.status, 429);
  assert.equal(body.error?.code, 'RATE_LIMITED');
  assert.equal(body.error?.message, 'Rate limit exceeded');
});
