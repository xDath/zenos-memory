/* eslint-disable @typescript-eslint/no-explicit-any -- white-box tests exercise private Drive adapter invariants */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudEvent, buildCloudSnapshot, cloudCursor, MaterializedCloudState } from '../app/lib/cloud-events';
import { GoogleDriveMemoryStore, DriveLease } from '../app/lib/drive';
import { ConflictError } from '../app/lib/errors';
import { Memory, MemorySchema } from '../app/lib/schema';

function memory(
  id = '11111111-1111-5111-8111-111111111111',
  content = 'Drive adapter evidence',
): Memory {
  return MemorySchema.parse({
    id,
    namespace: 'project',
    type: 'fact',
    content,
    metadata: {
      confidence: 0.9,
      importance: 8,
      status: 'active',
      tags: ['drive', 'test'],
      entities: ['Etla'],
      related_ids: [],
      supersedes_ids: [],
      contradictions: [],
      version: 1,
      access_count: 0,
      is_secret: false,
      redacted: false,
    },
    created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
  });
}

function event(idempotencyKey: string, occurredAt: string, value = memory()) {
  return buildCloudEvent({
    namespace: 'project',
    action: 'memory_created',
    idempotencyKey,
    occurredAt,
    changes: [{ operation: 'upsert', memory: value }],
  });
}

function createStore(): any {
  const store = new GoogleDriveMemoryStore({ folderId: 'root', credentials: {} });
  (store as unknown as { drive: unknown }).drive = { files: {} };
  return store as any;
}

test('Drive child listing follows pagination and enforces maxItems', async () => {
  const store = createStore();
  const pageTokens: Array<string | undefined> = [];
  store.drive.files.list = async (input: { pageToken?: string }) => {
    pageTokens.push(input.pageToken);
    if (!input.pageToken) {
      return { data: { files: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'next' } };
    }
    return { data: { files: [{ id: 'c' }], nextPageToken: undefined } };
  };

  const all = await store.listChildren('parent', { pageSize: 2 });
  const bounded = await store.listChildren('parent', { pageSize: 2, maxItems: 2 });

  assert.deepEqual(all.map((file: { id: string }) => file.id), ['a', 'b', 'c']);
  assert.deepEqual(bounded.map((file: { id: string }) => file.id), ['a', 'b']);
  assert.deepEqual(pageTokens.slice(0, 2), [undefined, 'next']);
});

test('Drive immutable JSON creation converges on the canonical duplicate', async () => {
  const store = createStore();
  let listings = 0;
  const trashed: string[] = [];
  store.listChildren = async () => {
    listings += 1;
    if (listings === 1) return [];
    return [
      { id: 'winner', createdTime: '2026-01-01T00:00:00.000Z', appProperties: { format: 'event', eventId: '1' } },
      { id: 'created', createdTime: '2026-01-02T00:00:00.000Z', appProperties: { format: 'event', eventId: '1' } },
    ];
  };
  store.createJsonFile = async () => 'created';
  store.drive.files.update = async (input: { fileId: string; requestBody: { trashed?: boolean } }) => {
    if (input.requestBody.trashed) trashed.push(input.fileId);
    return { data: { id: input.fileId } };
  };

  const selected = await store.createOrReuseJsonFile(
    'parent',
    'event.json',
    { value: true },
    { format: 'event', eventId: '1' },
  );

  assert.equal(selected, 'winner');
  assert.deepEqual(trashed, ['created']);
});

test('Drive compare-and-swap maps provider precondition failures to ConflictError', async () => {
  const store = createStore();
  store.drive.files.get = async () => ({ data: '{"owner":"a"}', headers: { etag: 'etag-1' } });
  store.drive.files.update = async () => {
    const error = new Error('precondition failed') as Error & { response?: { status?: number } };
    error.response = { status: 412 };
    throw error;
  };

  const current = await store.readJsonWithEtag('coordination');
  assert.equal(current.etag, 'etag-1');
  assert.deepEqual(current.payload, { owner: 'a' });
  await assert.rejects(
    () => store.updateJsonById('coordination', { owner: 'b' }, current.etag),
    ConflictError,
  );
});

test('Drive lease lifecycle verifies ownership before renew and release', async () => {
  const store = createStore();
  let payload: Record<string, unknown> = {
    namespace: 'project',
    resource: 'writer',
    owner: '',
    token: '',
    acquired_at: new Date(0).toISOString(),
    expires_at: new Date(0).toISOString(),
  };
  store.coordinationFile = async () => 'lease-file';
  store.readJsonWithEtag = async () => ({ payload: { ...payload }, etag: 'etag-current' });
  store.updateJsonById = async (_id: string, next: Record<string, unknown>) => {
    payload = { ...next };
  };
  store.readJsonById = async () => ({ ...payload });

  const lease = await store.acquireCloudLease('project', 'writer', 'runtime-a', 5_000, 1_000) as DriveLease;
  assert.equal(lease.owner, 'runtime-a');
  assert.equal(payload.token, lease.token);

  const renewed = await store.renewCloudLease(lease, 10_000);
  assert.equal(renewed.token, lease.token);
  assert.ok(new Date(renewed.expires_at).getTime() > Date.now());

  const released = await store.releaseCloudLease(renewed);
  assert.equal(released, true);
  assert.equal(payload.owner, '');
  assert.equal(payload.token, '');

  payload = { ...payload, owner: 'runtime-b', token: 'different' };
  await assert.rejects(() => store.renewCloudLease(lease, 5_000), ConflictError);
  assert.equal(await store.releaseCloudLease(lease), false);
});

test('Drive snapshot recovery skips corrupt newest data and accepts the next verified snapshot', async () => {
  const store = createStore();
  const state: MaterializedCloudState = {
    namespace: 'project',
    memories: [],
    cursor: null,
    event_count: 0,
    snapshot_id: null,
    revision: 'revision-1',
  };
  const valid = buildCloudSnapshot(state);
  store.cloudNamespaceFolders = async () => ({ snapshotsRoot: 'snapshots' });
  store.listChildren = async () => [
    { id: 'corrupt', appProperties: { format: 'zenos-memory-cloud-snapshot-v1' } },
    { id: 'valid', appProperties: { format: 'zenos-memory-cloud-snapshot-v1' } },
  ];
  store.readJsonById = async (id: string) => id === 'corrupt' ? { invalid: true } : valid;

  const recovered = await store.latestCloudSnapshot('project');
  assert.equal(recovered?.snapshot_id, valid.snapshot_id);
  assert.equal(recovered?.checksum, valid.checksum);
});

test('Drive lease listing filters expired and incomplete coordination records', async () => {
  const store = createStore();
  store.cloudNamespaceFolders = async () => ({ coordinationRoot: 'coordination' });
  store.listChildren = async () => [{ id: 'active' }, { id: 'expired' }, { id: 'empty' }];
  store.readJsonById = async (id: string) => {
    if (id === 'active') return {
      resource: 'writer', owner: 'runtime-a', token: 'token-a',
      acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    if (id === 'expired') return {
      resource: 'writer', owner: 'runtime-b', token: 'token-b',
      acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() - 60_000).toISOString(),
    };
    return {};
  };

  const leases = await store.listCloudLeases('project');
  assert.equal(leases.length, 1);
  assert.equal(leases[0].owner, 'runtime-a');
  assert.equal(leases[0].file_id, 'active');
});

test('Drive resolves named roots, creates missing roots, and caches the result', async () => {
  const existing = new GoogleDriveMemoryStore({ folderName: 'named-root', credentials: {} }) as any;
  existing.findChildren = async () => [{ id: 'existing-root' }];
  existing.ensureFolder = async () => { throw new Error('should not create'); };
  assert.equal(await existing.resolveRootFolderId(), 'existing-root');
  existing.findChildren = async () => { throw new Error('cached root should not re-query'); };
  assert.equal(await existing.resolveRootFolderId(), 'existing-root');

  const created = new GoogleDriveMemoryStore({ folderName: 'new-root', credentials: {} }) as any;
  created.findChildren = async () => [];
  created.ensureFolder = async (parent: string, name: string) => `${parent}:${name}`;
  assert.equal(await created.resolveRootFolderId(), 'root:new-root');
});

test('Drive app-property lookup follows pagination and escapes query values', async () => {
  const store = createStore();
  const queries: string[] = [];
  store.drive.files.list = async (input: { q: string; pageToken?: string }) => {
    queries.push(input.q);
    return input.pageToken
      ? { data: { files: [{ id: 'second' }] } }
      : { data: { files: [{ id: 'first' }], nextPageToken: 'page-2' } };
  };

  const files = await store.findByAppProperties({ namespace: "project's", eventId: 'event-1' });
  assert.deepEqual(files.map((file: { id: string }) => file.id), ['first', 'second']);
  assert.match(queries[0], /project\\'s/);
  assert.match(queries[0], /eventId/);
});

test('Drive legacy recovery accepts structured envelopes and skips invalid memories', async () => {
  const store = createStore();
  store.findStructuredMemories = async () => 'structured';
  store.resolveRootFolderId = async () => 'root';
  store.findChildren = async () => [];
  store.readJsonById = async () => ({ memories: [memory(), { invalid: true }] });

  const memories = await store.readLegacyMemories('project');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].namespace, 'project');
});

test('Drive event append deduplicates retries and persists new immutable events', async () => {
  const store = createStore();
  const first = event('append-1', '2026-07-13T00:00:01.000Z');
  store.findCloudEvent = async () => first;
  store.findByAppProperties = async () => [{ id: 'existing-file' }];

  const deduplicated = await store.appendCloudEvent(first);
  assert.equal(deduplicated.deduplicated, true);
  assert.equal(deduplicated.file_id, 'existing-file');

  store.findCloudEvent = async () => null;
  store.cloudNamespaceFolders = async () => ({ eventsRoot: 'events' });
  store.ensureFolder = async () => 'month';
  let createdProperties: Record<string, string> | undefined;
  store.createJsonFile = async (_parent: string, _name: string, _payload: unknown, properties: Record<string, string>) => {
    createdProperties = properties;
    return 'new-file';
  };
  const created = await store.appendCloudEvent(first);
  assert.equal(created.deduplicated, false);
  assert.equal(created.file_id, 'new-file');
  assert.equal(createdProperties?.eventId, first.event_id);
});

test('Drive batch append preserves order and propagates one worker failure', async () => {
  const store = createStore();
  const events = [
    event('batch-1', '2026-07-13T00:00:01.000Z'),
    event('batch-2', '2026-07-13T00:00:02.000Z'),
  ];
  store.appendCloudEvent = async (value: { event_id: string }) => ({
    file_id: value.event_id,
    cursor: value.event_id,
    deduplicated: false,
  });
  const success = await store.appendCloudEvents(events, 99);
  assert.deepEqual(success.map((item: { file_id: string }) => item.file_id), events.map(item => item.event_id));

  store.appendCloudEvent = async (value: { event_id: string }) => {
    if (value.event_id === events[1].event_id) throw new Error('upload failed');
    return { file_id: value.event_id, cursor: value.event_id, deduplicated: false };
  };
  await assert.rejects(() => store.appendCloudEvents(events, 2), /upload failed/);
});

test('Drive delta replay filters cursor metadata and returns deterministically sorted events', async () => {
  const store = createStore();
  const before = event('delta-before', '2026-07-13T00:00:01.000Z');
  const after = event('delta-after', '2026-07-13T00:00:03.000Z', memory(
    '22222222-2222-5222-8222-222222222222',
    'After cursor',
  ));
  store.cloudNamespaceFolders = async () => ({ eventsRoot: 'events' });
  store.listChildren = async (parent: string) => parent === 'events'
    ? [{ id: '2026-07', name: '2026-07' }, { id: 'invalid-month', name: 'notes' }]
    : [
        { id: 'before', appProperties: { occurredAt: before.occurred_at, eventId: before.event_id } },
        { id: 'after', appProperties: { occurredAt: after.occurred_at, eventId: after.event_id } },
      ];
  store.readJsonById = async (id: string) => id === 'after' ? after : before;

  const events = await store.cloudEventsAfter('project', cloudCursor(before.occurred_at, before.event_id));
  assert.deepEqual(events.map((item: { event_id: string }) => item.event_id), [after.event_id]);
});

test('Drive cloud snapshot writes verified search and graph indexes', async () => {
  const store = createStore();
  const linked = memory();
  linked.metadata.related_ids = ['22222222-2222-5222-8222-222222222222'];
  linked.metadata.supersedes_ids = ['33333333-3333-5333-8333-333333333333'];
  const state: MaterializedCloudState = {
    namespace: 'project',
    memories: [linked],
    cursor: null,
    event_count: 0,
    snapshot_id: null,
    revision: 'state-revision',
  };
  store.cloudNamespaceFolders = async () => ({ snapshotsRoot: 'snapshots', indexesRoot: 'indexes' });
  const writes: Array<{ name: string; payload: Record<string, unknown> }> = [];
  store.createOrReuseJsonFile = async (_parent: string, name: string, payload: Record<string, unknown>) => {
    writes.push({ name, payload });
    return name.includes('.search.') ? 'search-id' : name.includes('.graph.') ? 'graph-id' : 'snapshot-id';
  };
  let snapshotPayload: unknown;
  store.readJsonById = async () => snapshotPayload;
  const originalCreate = store.createOrReuseJsonFile;
  store.createOrReuseJsonFile = async (...args: unknown[]) => {
    const id = await originalCreate(...args);
    if (id === 'snapshot-id') snapshotPayload = args[2];
    return id;
  };

  const result = await store.createCloudSnapshot(state);
  assert.equal(result.verified, true);
  assert.equal(result.search_index_file_id, 'search-id');
  assert.equal(result.graph_index_file_id, 'graph-id');
  const search = writes.find(item => item.name.includes('.search.'))?.payload as { postings?: Record<string, string[]> };
  const graph = writes.find(item => item.name.includes('.graph.'))?.payload as { entities?: Record<string, string[]>; edges?: unknown[] };
  assert.deepEqual(search.postings?.etla, [linked.id]);
  assert.deepEqual(graph.entities?.etla, [linked.id]);
  assert.ok((graph.edges || []).length >= 3);
});

test('Drive namespace initialization is idempotent and snapshots only an empty namespace', async () => {
  const store = createStore();
  const existing: MaterializedCloudState = {
    namespace: 'project', memories: [memory()], cursor: null, event_count: 1, snapshot_id: 'existing', revision: 'existing',
  };
  store.loadCloudState = async () => existing;
  store.createCloudSnapshot = async () => { throw new Error('must not rewrite initialized state'); };
  assert.equal((await store.initializeCloudNamespace('project', [])).snapshot_id, 'existing');

  let loads = 0;
  let created = false;
  store.loadCloudState = async () => {
    loads += 1;
    return loads === 1
      ? { namespace: 'project', memories: [], cursor: null, event_count: 0, snapshot_id: null, revision: 'empty' }
      : existing;
  };
  store.createCloudSnapshot = async () => { created = true; return {}; };
  const initialized = await store.initializeCloudNamespace('project', [memory()]);
  assert.equal(created, true);
  assert.equal(initialized.snapshot_id, 'existing');
});

test('Drive nonce registry accepts once and rejects replay', async () => {
  const store = createStore();
  let registry: { nonces?: Record<string, number> } = { nonces: {} };
  store.coordinationFile = async () => 'nonce-file';
  store.readJsonWithEtag = async () => ({ payload: structuredClone(registry), etag: 'etag' });
  store.updateJsonById = async (_id: string, next: { nonces?: Record<string, number> }) => { registry = structuredClone(next); };
  store.readJsonById = async () => structuredClone(registry);

  assert.equal(await store.claimCloudNonce('nonce-value', 60_000), true);
  assert.equal(await store.claimCloudNonce('nonce-value', 60_000), false);
});

test('Drive audit listing bounds results and sorts newest events first', async () => {
  const store = createStore();
  const older = event('audit-old', '2026-07-13T00:00:01.000Z');
  const newer = event('audit-new', '2026-07-13T00:00:02.000Z');
  store.cloudNamespaceFolders = async () => ({ eventsRoot: 'events' });
  store.listChildren = async (parent: string) => parent === 'events'
    ? [{ id: 'month', name: '2026-07' }]
    : [
        { id: 'old', appProperties: { format: 'zenos-memory-event-v1' } },
        { id: 'new', appProperties: { format: 'zenos-memory-event-v1' } },
      ];
  store.readJsonById = async (id: string) => id === 'old' ? older : newer;

  const audit = await store.listCloudAudit('project', 2);
  assert.deepEqual(audit.map((item: Record<string, unknown>) => item.id), [newer.event_id, older.event_id]);
  assert.equal(audit[0].change_count, 1);
});

test('Drive backup snapshot creates manifest and verifies checksums', async () => {
  const store = createStore();
  const memories = [memory()];
  const checksum = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(JSON.stringify(memories)).digest('hex'));
  const snapshot = {
    format: 'zenos-memory-snapshot-v1' as const,
    generated_at: '2026-07-13T00:00:00.000Z',
    namespace: 'project',
    checksum,
    memories,
  };
  store.resolveRootFolderId = async () => 'root';
  store.ensureFolder = async (_parent: string, name: string) => name;
  const writes: string[] = [];
  store.createOrReuseJsonFile = async (_parent: string, name: string) => {
    writes.push(name);
    return name.includes('manifest') ? 'manifest-id' : 'snapshot-file';
  };
  const created = await store.createSnapshot(snapshot);
  assert.equal(created.file_id, 'snapshot-file');
  assert.equal(created.manifest_id, 'manifest-id');
  assert.equal(writes.length, 2);

  store.readJsonById = async () => snapshot;
  assert.equal(await store.verifySnapshot('snapshot-file', checksum), true);
  store.readJsonById = async () => ({ ...snapshot, checksum: 'wrong' });
  process.env.ZENOS_MEMORY_DRIVE_VERIFY_ATTEMPTS = '1';
  assert.equal(await store.verifySnapshot('snapshot-file', checksum), false);
  delete process.env.ZENOS_MEMORY_DRIVE_VERIFY_ATTEMPTS;
});
