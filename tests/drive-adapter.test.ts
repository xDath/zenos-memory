/* eslint-disable @typescript-eslint/no-explicit-any -- white-box tests exercise private Drive adapter invariants */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudSnapshot, MaterializedCloudState } from '../app/lib/cloud-events';
import { GoogleDriveMemoryStore, DriveLease } from '../app/lib/drive';
import { ConflictError } from '../app/lib/errors';

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
