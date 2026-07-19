import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { issueEtlaToken } from '../app/lib/auth';
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
  coverage?: { goal?: boolean; decisions?: boolean; pendingWork?: boolean; artifacts?: boolean };
  llm_telemetry?: { configured?: boolean; succeeded?: boolean; failure_reason?: string | null; attempts?: unknown[] };
  bootstrap?: string;
  sources?: unknown[];
  request_id?: string;
  revision?: string;
  brief?: { content?: string; sections?: Record<string, unknown> };
}

async function json(response: Response): Promise<RouteBody> {
  return await response.json() as RouteBody;
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
