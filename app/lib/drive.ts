import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { drive_v3, google } from 'googleapis';
import {
  buildCloudSnapshot,
  CloudMemoryEvent,
  CloudSnapshot,
  cloudCursor,
  compareCloudCursor,
  MaterializedCloudState,
  materializeCloudState,
  validateCloudEvent,
  validateCloudSnapshot,
} from './cloud-events';
import { ConflictError, StorageError } from './errors';
import { Memory, MemorySchema } from './schema';
import { sanitizeUnknown } from './secrets';

interface DriveConfig {
  folderId?: string;
  folderName?: string;
  credentials?: Record<string, unknown>;
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

export interface DriveSnapshot {
  format: 'zenos-memory-snapshot-v1';
  generated_at: string;
  namespace: string | null;
  checksum: string;
  memories: Memory[];
}

export interface DriveLease {
  namespace: string;
  resource: string;
  owner: string;
  token: string;
  acquired_at: string;
  expires_at: string;
  file_id: string;
}

const JSON_MIME = 'application/json';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const CLOUD_ROOT_NAME = 'zenos-memory-cloud';

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function safeNamespace(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96) || 'zenos';
}

function parseCredentialJson(raw: string, source: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new StorageError(`Invalid Google credential JSON from ${source}`, error);
  }
}

function headerValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function mapLimit<T, R>(values: T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => run()));
  return results;
}

export function hasDriveConfiguration(): boolean {
  const hasFolder = Boolean(process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_NAME);
  const hasOAuth = Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID
    && process.env.GOOGLE_OAUTH_CLIENT_SECRET
    && process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  );
  const hasServiceAccount = Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    || process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
  );
  return hasFolder && (hasOAuth || hasServiceAccount);
}

export class GoogleDriveMemoryStore {
  private readonly drive: drive_v3.Drive;
  private rootFolderId: string | null;
  private readonly rootFolderName: string | null;
  private readonly folderIds = new Map<string, string>();

  constructor(config: DriveConfig) {
    if (config.oauth) {
      const oauthClient = new google.auth.OAuth2(config.oauth.clientId, config.oauth.clientSecret);
      oauthClient.setCredentials({ refresh_token: config.oauth.refreshToken });
      this.drive = google.drive({ version: 'v3', auth: oauthClient });
    } else {
      const auth = new google.auth.GoogleAuth({
        credentials: config.credentials,
        scopes: ['https://www.googleapis.com/auth/drive'],
      });
      this.drive = google.drive({ version: 'v3', auth });
    }
    this.rootFolderId = config.folderId?.trim() || null;
    this.rootFolderName = config.folderName?.trim() || null;
  }

  private async resolveRootFolderId(): Promise<string> {
    if (this.rootFolderId) return this.rootFolderId;
    if (!this.rootFolderName) throw new StorageError('Drive folder id or name is required');
    const existing = (await this.findChildren('root', this.rootFolderName, FOLDER_MIME))[0]?.id;
    if (existing) {
      this.rootFolderId = existing;
      return existing;
    }
    this.rootFolderId = await this.ensureFolder('root', this.rootFolderName);
    return this.rootFolderId;
  }

  private async listChildren(
    parentId: string,
    options: { name?: string; mimeType?: string; orderBy?: string; pageSize?: number; maxItems?: number } = {},
  ): Promise<drive_v3.Schema$File[]> {
    const clauses = [`'${parentId}' in parents`, 'trashed=false'];
    if (options.name) clauses.push(`name='${escapeDriveQuery(options.name)}'`);
    if (options.mimeType) clauses.push(`mimeType='${options.mimeType}'`);
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.drive.files.list({
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        q: clauses.join(' and '),
        fields: 'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,md5Checksum,size,appProperties,version)',
        orderBy: options.orderBy || 'createdTime asc,name asc',
        pageSize: Math.min(
          1000,
          Math.max(1, Math.min(options.pageSize || 1000, options.maxItems || 1000)),
        ),
        pageToken,
      });
      files.push(...(response.data.files || []));
      if (options.maxItems && files.length >= options.maxItems) break;
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
    return options.maxItems ? files.slice(0, options.maxItems) : files;
  }

  private async findChildren(parentId: string, name: string, mimeType?: string): Promise<drive_v3.Schema$File[]> {
    return this.listChildren(parentId, { name, mimeType, orderBy: 'modifiedTime desc' });
  }

  private async findByAppProperties(properties: Record<string, string>): Promise<drive_v3.Schema$File[]> {
    const clauses = ['trashed=false'];
    for (const [key, value] of Object.entries(properties)) {
      clauses.push(`appProperties has { key='${escapeDriveQuery(key)}' and value='${escapeDriveQuery(value)}' }`);
    }
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.drive.files.list({
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        q: clauses.join(' and '),
        fields: 'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,appProperties)',
        orderBy: 'createdTime asc',
        pageSize: 1000,
        pageToken,
      });
      files.push(...(response.data.files || []));
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
    return files;
  }

  private async ensureFolder(parentId: string, name: string): Promise<string> {
    const key = `${parentId}:${name}`;
    const cached = this.folderIds.get(key);
    if (cached) return cached;
    const canonical = (files: drive_v3.Schema$File[]) => files
      .filter(file => Boolean(file.id))
      .sort((left, right) => {
        const created = String(left.createdTime || '').localeCompare(String(right.createdTime || ''));
        return created || String(left.id).localeCompare(String(right.id));
      })[0]?.id;
    const existing = canonical(await this.listChildren(parentId, {
      name,
      mimeType: FOLDER_MIME,
      orderBy: 'createdTime asc',
    }));
    if (existing) {
      this.folderIds.set(key, existing);
      return existing;
    }

    const response = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: { name, parents: [parentId], mimeType: FOLDER_MIME },
      fields: 'id,createdTime',
    });
    const createdId = response.data.id;
    if (!createdId) throw new StorageError(`Drive did not return an id for folder ${name}`);

    // Folder creation has no uniqueness constraint. Concurrent cold starts may
    // both create the same path, so re-list and converge on one deterministic
    // canonical folder before any child is written.
    const selected = canonical(await this.listChildren(parentId, {
      name,
      mimeType: FOLDER_MIME,
      orderBy: 'createdTime asc',
    })) || createdId;
    if (selected !== createdId) {
      await this.drive.files.update({
        supportsAllDrives: true,
        fileId: createdId,
        requestBody: { trashed: true },
        fields: 'id',
      }).catch(() => undefined);
    }
    this.folderIds.set(key, selected);
    return selected;
  }

  private async createJsonFile(
    parentId: string,
    name: string,
    payload: unknown,
    appProperties?: Record<string, string>,
    sanitizePayload = true,
  ): Promise<string> {
    const body = JSON.stringify(sanitizePayload ? sanitizeUnknown(payload) : payload);
    const response = await this.drive.files.create({
      supportsAllDrives: true,
      requestBody: { name, parents: [parentId], mimeType: JSON_MIME, appProperties },
      media: { mimeType: JSON_MIME, body: Readable.from([body]) },
      fields: 'id',
    });
    if (!response.data.id) throw new StorageError(`Drive did not return an id for file ${name}`);
    return response.data.id;
  }

  private async createOrReuseJsonFile(
    parentId: string,
    name: string,
    payload: unknown,
    identity: Record<string, string>,
    sanitizePayload = true,
  ): Promise<string> {
    const matchesIdentity = (file: drive_v3.Schema$File) => Object.entries(identity)
      .every(([key, value]) => file.appProperties?.[key] === value);
    const canonical = (files: drive_v3.Schema$File[]) => files
      .filter(file => Boolean(file.id) && matchesIdentity(file))
      .sort((left, right) => {
        const created = String(left.createdTime || '').localeCompare(String(right.createdTime || ''));
        return created || String(left.id).localeCompare(String(right.id));
      })[0]?.id;
    const existing = canonical(await this.listChildren(parentId, {
      mimeType: JSON_MIME,
      orderBy: 'createdTime asc',
    }));
    if (existing) return existing;

    const createdId = await this.createJsonFile(parentId, name, payload, identity, sanitizePayload);
    const selected = canonical(await this.listChildren(parentId, {
      mimeType: JSON_MIME,
      orderBy: 'createdTime asc',
    })) || createdId;
    if (selected !== createdId) {
      await this.drive.files.update({
        supportsAllDrives: true,
        fileId: createdId,
        requestBody: { trashed: true },
        fields: 'id',
      }).catch(() => undefined);
    }
    return selected;
  }

  private async readJsonById(fileId: string): Promise<unknown> {
    try {
      const response = await this.drive.files.get({ supportsAllDrives: true, fileId, alt: 'media' });
      if (typeof response.data === 'string') return JSON.parse(response.data);
      return response.data;
    } catch (error) {
      throw new StorageError(`Failed to read Drive file ${fileId}`, error);
    }
  }

  private async readJsonWithEtag(fileId: string): Promise<{ payload: unknown; etag: string | null }> {
    try {
      const response = await this.drive.files.get({ supportsAllDrives: true, fileId, alt: 'media' });
      const payload = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      return { payload, etag: headerValue(response.headers.etag) };
    } catch (error) {
      throw new StorageError(`Failed to read Drive coordination file ${fileId}`, error);
    }
  }

  private async updateJsonById(fileId: string, payload: unknown, etag?: string | null): Promise<void> {
    const body = JSON.stringify(sanitizeUnknown(payload));
    try {
      await this.drive.files.update({
        supportsAllDrives: true,
        fileId,
        requestBody: { mimeType: JSON_MIME },
        media: { mimeType: JSON_MIME, body: Readable.from([body]) },
        fields: 'id,modifiedTime,version',
      }, etag ? { headers: { 'If-Match': etag } } : undefined);
    } catch (error) {
      const status = Number((error as { response?: { status?: number } }).response?.status || 0);
      if (status === 409 || status === 412) throw new ConflictError('Drive coordination compare-and-swap failed');
      throw new StorageError(`Failed to update Drive file ${fileId}`, error);
    }
  }

  private async cloudNamespaceFolders(namespace: string): Promise<{
    namespaceRoot: string;
    eventsRoot: string;
    snapshotsRoot: string;
    indexesRoot: string;
    coordinationRoot: string;
  }> {
    const root = await this.resolveRootFolderId();
    const cloudRoot = await this.ensureFolder(root, CLOUD_ROOT_NAME);
    const namespacesRoot = await this.ensureFolder(cloudRoot, 'namespaces');
    const namespaceRoot = await this.ensureFolder(namespacesRoot, safeNamespace(namespace));
    const [eventsRoot, snapshotsRoot, indexesRoot, coordinationRoot] = await Promise.all([
      this.ensureFolder(namespaceRoot, 'events'),
      this.ensureFolder(namespaceRoot, 'snapshots'),
      this.ensureFolder(namespaceRoot, 'indexes'),
      this.ensureFolder(namespaceRoot, 'coordination'),
    ]);
    return { namespaceRoot, eventsRoot, snapshotsRoot, indexesRoot, coordinationRoot };
  }

  private async findStructuredMemories(namespace: string): Promise<string | null> {
    const rootFolderId = await this.resolveRootFolderId();
    const roots = await this.findChildren(rootFolderId, 'zenos-memory', FOLDER_MIME);
    const root = roots[0]?.id;
    if (!root) return null;
    const namespaceRoots = await this.findChildren(root, 'namespaces', FOLDER_MIME);
    const namespaceRoot = namespaceRoots[0]?.id;
    if (!namespaceRoot) return null;
    const namespaces = await this.findChildren(namespaceRoot, namespace, FOLDER_MIME);
    const namespaceFolder = namespaces[0]?.id;
    if (!namespaceFolder) return null;
    return (await this.findChildren(namespaceFolder, 'memories.json', JSON_MIME))[0]?.id || null;
  }

  async readLegacyMemories(namespace = 'zenos'): Promise<Memory[]> {
    const candidates: string[] = [];
    const structured = await this.findStructuredMemories(namespace);
    if (structured) candidates.push(structured);

    const rootFolderId = await this.resolveRootFolderId();
    const defaultNamespace = process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos';
    const legacyNames = [`zenos-memories-${namespace}.json`];
    if (namespace === defaultNamespace) legacyNames.push('zenos-memories.json');
    for (const name of legacyNames) {
      const id = (await this.findChildren(rootFolderId, name, JSON_MIME))[0]?.id;
      if (id && !candidates.includes(id)) candidates.push(id);
    }

    if (!candidates.length) return [];
    const raw = await this.readJsonById(candidates[0]);
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { memories?: unknown }).memories)
        ? (raw as { memories: unknown[] }).memories
        : [];

    const memories: Memory[] = [];
    for (const item of list) {
      const parsed = MemorySchema.safeParse(item);
      if (parsed.success) memories.push(parsed.data);
    }
    return memories;
  }

  async findCloudEvent(namespace: string, eventId: string): Promise<CloudMemoryEvent | null> {
    const matches = await this.findByAppProperties({
      format: 'zenos-memory-event-v1',
      namespace,
      eventId,
    });
    for (const match of matches) {
      if (!match.id) continue;
      try {
        return validateCloudEvent(await this.readJsonById(match.id));
      } catch {
        // Continue to another duplicate only when the first matching file is corrupt.
      }
    }
    return null;
  }

  async appendCloudEvent(eventInput: CloudMemoryEvent): Promise<{ file_id: string; cursor: string; deduplicated: boolean }> {
    const event = validateCloudEvent(eventInput);
    const existingEvent = await this.findCloudEvent(event.namespace, event.event_id);
    if (existingEvent) {
      const matches = await this.findByAppProperties({
        format: 'zenos-memory-event-v1',
        namespace: event.namespace,
        eventId: event.event_id,
      });
      return {
        file_id: String(matches[0]?.id || ''),
        cursor: cloudCursor(existingEvent.occurred_at, existingEvent.event_id),
        deduplicated: true,
      };
    }
    const { eventsRoot } = await this.cloudNamespaceFolders(event.namespace);
    const monthRoot = await this.ensureFolder(eventsRoot, event.occurred_at.slice(0, 7));
    const name = `${event.occurred_at.replace(/[:.]/g, '-')}-${event.event_id}.json`;
    const fileId = await this.createJsonFile(monthRoot, name, event, {
      format: event.format,
      namespace: event.namespace,
      eventId: event.event_id,
      occurredAt: event.occurred_at,
      action: event.action,
    }, false);
    return { file_id: fileId, cursor: cloudCursor(event.occurred_at, event.event_id), deduplicated: false };
  }

  async appendCloudEvents(
    events: CloudMemoryEvent[],
    concurrency = 4,
  ): Promise<Array<{ file_id: string; cursor: string; deduplicated: boolean }>> {
    const boundedConcurrency = Math.max(1, Math.min(8, concurrency));
    const outcomes = await mapLimit(events, boundedConcurrency, async event => {
      try {
        return { ok: true as const, value: await this.appendCloudEvent(event) };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    const failure = outcomes.find(outcome => !outcome.ok);
    if (failure && !failure.ok) throw failure.error;
    return outcomes.map(outcome => {
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
  }

  private async latestCloudSnapshot(namespace: string): Promise<CloudSnapshot | null> {
    const { snapshotsRoot } = await this.cloudNamespaceFolders(namespace);
    const files = await this.listChildren(snapshotsRoot, {
      mimeType: JSON_MIME,
      orderBy: 'createdTime desc',
      pageSize: 20,
      maxItems: 20,
    });
    for (const file of files) {
      if (!file.id || file.appProperties?.format !== 'zenos-memory-cloud-snapshot-v1') continue;
      try {
        // Namespace writes are serialized and snapshots are immutable, so the
        // newest verified snapshot is also the furthest durable cursor. Return
        // immediately instead of downloading and parsing every historical one.
        return validateCloudSnapshot(await this.readJsonById(file.id));
      } catch {
        // Corrupt or partially uploaded snapshots are ignored; try the next
        // newest verified snapshot before replaying the event log.
      }
    }
    return null;
  }

  private async cloudEventsAfter(namespace: string, cursor: string | null): Promise<CloudMemoryEvent[]> {
    const { eventsRoot } = await this.cloudNamespaceFolders(namespace);
    const monthFolders = (await this.listChildren(eventsRoot, { mimeType: FOLDER_MIME, orderBy: 'name asc' }))
      .filter(file => file.id && file.name && /^\d{4}-\d{2}$/.test(file.name));
    const cursorMonth = cursor?.slice(0, 7) || '';
    const relevantMonths = monthFolders.filter(folder => !cursorMonth || String(folder.name) >= cursorMonth);
    const eventFiles: drive_v3.Schema$File[] = [];
    for (const month of relevantMonths) {
      eventFiles.push(...await this.listChildren(String(month.id), { mimeType: JSON_MIME, orderBy: 'name asc' }));
    }
    const relevantFiles = eventFiles.filter(file => {
      const occurredAt = file.appProperties?.occurredAt;
      const eventId = file.appProperties?.eventId;
      if (!occurredAt || !eventId) return true;
      return !cursor || compareCloudCursor(cloudCursor(occurredAt, eventId), cursor) > 0;
    });
    const events = await mapLimit(relevantFiles.filter(file => Boolean(file.id)), 8, async file => {
      return validateCloudEvent(await this.readJsonById(String(file.id)));
    });
    return events.sort((a, b) => compareCloudCursor(
      cloudCursor(a.occurred_at, a.event_id),
      cloudCursor(b.occurred_at, b.event_id),
    ));
  }

  async loadCloudState(namespace: string): Promise<MaterializedCloudState> {
    const snapshot = await this.latestCloudSnapshot(namespace);
    const events = await this.cloudEventsAfter(namespace, snapshot?.through_cursor || null);
    return materializeCloudState({ namespace, snapshot, events });
  }

  private buildSearchIndex(state: MaterializedCloudState): Record<string, unknown> {
    const postings: Record<string, string[]> = {};
    for (const memory of state.memories) {
      const tokens = `${memory.content} ${(memory.metadata.tags || []).join(' ')} ${(memory.metadata.entities || []).join(' ')}`
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
        .split(/\s+/)
        .filter(token => token.length > 2)
        .slice(0, 256);
      for (const token of new Set(tokens)) {
        const ids = postings[token] || [];
        if (ids.length < 250) ids.push(memory.id);
        postings[token] = ids;
      }
    }
    return {
      format: 'zenos-memory-search-index-v1',
      namespace: state.namespace,
      generated_at: new Date().toISOString(),
      through_cursor: state.cursor,
      postings,
    };
  }

  private buildGraphIndex(state: MaterializedCloudState): Record<string, unknown> {
    const entities: Record<string, string[]> = {};
    const edges: Array<{ source: string; target: string; type: string }> = [];
    for (const memory of state.memories) {
      for (const entity of memory.metadata.entities || []) {
        const key = entity.toLowerCase();
        const ids = entities[key] || [];
        if (!ids.includes(memory.id)) ids.push(memory.id);
        entities[key] = ids;
        edges.push({ source: memory.id, target: `entity:${key}`, type: 'mentions' });
      }
      for (const target of memory.metadata.related_ids || []) edges.push({ source: memory.id, target, type: 'related_to' });
      for (const target of memory.metadata.supersedes_ids || []) edges.push({ source: memory.id, target, type: 'supersedes' });
    }
    return {
      format: 'zenos-memory-graph-index-v1',
      namespace: state.namespace,
      generated_at: new Date().toISOString(),
      through_cursor: state.cursor,
      entities,
      edges: edges.slice(0, 50_000),
    };
  }

  async createCloudSnapshot(stateInput: MaterializedCloudState): Promise<{
    snapshot_file_id: string;
    search_index_file_id: string;
    graph_index_file_id: string;
    snapshot: CloudSnapshot;
    verified: boolean;
  }> {
    const snapshot = buildCloudSnapshot(stateInput);
    const { snapshotsRoot, indexesRoot } = await this.cloudNamespaceFolders(snapshot.namespace);
    const stamp = snapshot.generated_at.replace(/[:.]/g, '-');
    const snapshotName = `${stamp}-${snapshot.snapshot_id}.json`;
    const snapshotFileId = await this.createOrReuseJsonFile(snapshotsRoot, snapshotName, snapshot, {
      format: snapshot.format,
      namespace: snapshot.namespace,
      snapshotId: snapshot.snapshot_id,
      throughCursor: snapshot.through_cursor || '',
      checksum: snapshot.checksum,
    }, false);
    const [searchIndexFileId, graphIndexFileId] = await Promise.all([
      this.createOrReuseJsonFile(indexesRoot, `${stamp}-${snapshot.snapshot_id}.search.json`, this.buildSearchIndex(stateInput), {
        format: 'zenos-memory-search-index-v1',
        namespace: snapshot.namespace,
        snapshotId: snapshot.snapshot_id,
      }, false),
      this.createOrReuseJsonFile(indexesRoot, `${stamp}-${snapshot.snapshot_id}.graph.json`, this.buildGraphIndex(stateInput), {
        format: 'zenos-memory-graph-index-v1',
        namespace: snapshot.namespace,
        snapshotId: snapshot.snapshot_id,
      }, false),
    ]);
    const verified = validateCloudSnapshot(await this.readJsonById(snapshotFileId)).checksum === snapshot.checksum;
    return {
      snapshot_file_id: snapshotFileId,
      search_index_file_id: searchIndexFileId,
      graph_index_file_id: graphIndexFileId,
      snapshot,
      verified,
    };
  }

  async compactCloudNamespace(namespace: string): Promise<ReturnType<GoogleDriveMemoryStore['createCloudSnapshot']>> {
    const state = await this.loadCloudState(namespace);
    return this.createCloudSnapshot(state);
  }

  async initializeCloudNamespace(namespace: string, memories: Memory[]): Promise<MaterializedCloudState> {
    const current = await this.loadCloudState(namespace);
    if (current.snapshot_id || current.event_count > 0 || current.memories.length > 0) return current;
    const normalized = memories.map(memory => MemorySchema.parse({ ...memory, namespace }));
    const state: MaterializedCloudState = {
      namespace,
      memories: normalized,
      cursor: null,
      event_count: 0,
      snapshot_id: null,
      revision: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
    };
    await this.createCloudSnapshot(state);
    return this.loadCloudState(namespace);
  }

  private async coordinationFile(namespace: string, resource: string): Promise<string> {
    const { coordinationRoot } = await this.cloudNamespaceFolders(namespace);
    const name = `${safeNamespace(resource)}.json`;
    const selectCanonical = (files: drive_v3.Schema$File[]) => files
      .filter(file => Boolean(file.id))
      .sort((left, right) => {
        const created = String(left.createdTime || '').localeCompare(String(right.createdTime || ''));
        return created || String(left.id).localeCompare(String(right.id));
      })[0]?.id;
    const existing = selectCanonical(await this.listChildren(coordinationRoot, {
      name,
      mimeType: JSON_MIME,
      orderBy: 'createdTime asc',
    }));
    if (existing) return existing;

    const createdId = await this.createJsonFile(coordinationRoot, name, {
      format: 'zenos-memory-drive-lease-v1',
      namespace,
      resource,
      owner: '',
      token: '',
      acquired_at: new Date(0).toISOString(),
      expires_at: new Date(0).toISOString(),
    }, { format: 'zenos-memory-drive-lease-v1', namespace, resource });
    const selected = selectCanonical(await this.listChildren(coordinationRoot, {
      name,
      mimeType: JSON_MIME,
      orderBy: 'createdTime asc',
    })) || createdId;
    if (selected !== createdId) {
      await this.drive.files.update({
        supportsAllDrives: true,
        fileId: createdId,
        requestBody: { trashed: true },
        fields: 'id',
      }).catch(() => undefined);
    }
    return selected;
  }

  async acquireCloudLease(
    namespace: string,
    resource: string,
    owner: string,
    ttlMs = 20_000,
    waitMs = 12_000,
  ): Promise<DriveLease> {
    const fileId = await this.coordinationFile(namespace, resource);
    const deadline = Date.now() + waitMs;
    const token = randomUUID();
    while (Date.now() < deadline) {
      const { payload, etag } = await this.readJsonWithEtag(fileId);
      const current = payload && typeof payload === 'object' ? payload as Partial<DriveLease> : {};
      const now = new Date();
      const expiresAt = current.expires_at ? new Date(current.expires_at).getTime() : 0;
      if (!current.owner || expiresAt <= now.getTime() || current.owner === owner) {
        const lease: DriveLease = {
          namespace,
          resource,
          owner,
          token,
          acquired_at: now.toISOString(),
          expires_at: new Date(now.getTime() + ttlMs).toISOString(),
          file_id: fileId,
        };
        try {
          await this.updateJsonById(fileId, { format: 'zenos-memory-drive-lease-v1', ...lease }, etag);
          const confirmed = await this.readJsonById(fileId) as Partial<DriveLease>;
          if (confirmed.token === token && confirmed.owner === owner) return lease;
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
        }
      }
      await sleep(120 + Math.floor(Math.random() * 180));
    }
    throw new ConflictError(`Timed out waiting for Drive lease ${resource}`);
  }

  async renewCloudLease(lease: DriveLease, ttlMs = 20_000): Promise<DriveLease> {
    const { payload, etag } = await this.readJsonWithEtag(lease.file_id);
    const current = payload as Partial<DriveLease>;
    if (current.token !== lease.token || current.owner !== lease.owner) {
      throw new ConflictError(`Drive lease ${lease.resource} is no longer owned by ${lease.owner}`);
    }
    const renewed = { ...lease, expires_at: new Date(Date.now() + ttlMs).toISOString() };
    await this.updateJsonById(lease.file_id, { format: 'zenos-memory-drive-lease-v1', ...renewed }, etag);
    return renewed;
  }

  async releaseCloudLease(lease: DriveLease): Promise<boolean> {
    const { payload, etag } = await this.readJsonWithEtag(lease.file_id);
    const current = payload as Partial<DriveLease>;
    if (current.token !== lease.token || current.owner !== lease.owner) return false;
    await this.updateJsonById(lease.file_id, {
      format: 'zenos-memory-drive-lease-v1',
      namespace: lease.namespace,
      resource: lease.resource,
      owner: '',
      token: '',
      acquired_at: lease.acquired_at,
      expires_at: new Date(0).toISOString(),
    }, etag);
    return true;
  }

  async renewCloudLeaseByIdentity(
    namespace: string,
    resource: string,
    token: string,
    owner: string,
    ttlMs = 30_000,
  ): Promise<DriveLease | null> {
    const fileId = await this.coordinationFile(namespace, resource);
    const { payload, etag } = await this.readJsonWithEtag(fileId);
    const current = payload as Partial<DriveLease>;
    if (current.token !== token || current.owner !== owner || !current.expires_at || new Date(current.expires_at).getTime() <= Date.now()) {
      return null;
    }
    const renewed: DriveLease = {
      namespace,
      resource,
      owner,
      token,
      acquired_at: current.acquired_at || new Date().toISOString(),
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      file_id: fileId,
    };
    await this.updateJsonById(fileId, { format: 'zenos-memory-drive-lease-v1', ...renewed }, etag);
    return renewed;
  }

  async releaseCloudLeaseByIdentity(namespace: string, resource: string, token: string, owner: string): Promise<boolean> {
    const fileId = await this.coordinationFile(namespace, resource);
    return this.releaseCloudLease({
      namespace,
      resource,
      owner,
      token,
      acquired_at: new Date(0).toISOString(),
      expires_at: new Date(0).toISOString(),
      file_id: fileId,
    });
  }

  async listCloudLeases(namespace: string): Promise<DriveLease[]> {
    const { coordinationRoot } = await this.cloudNamespaceFolders(namespace);
    const files = await this.listChildren(coordinationRoot, { mimeType: JSON_MIME, orderBy: 'name asc' });
    const leases = await mapLimit(files.filter(file => Boolean(file.id)), 6, async file => {
      const value = await this.readJsonById(String(file.id)) as Partial<DriveLease>;
      if (!value.token || !value.owner || !value.resource || !value.expires_at) return null;
      if (new Date(value.expires_at).getTime() <= Date.now()) return null;
      return {
        namespace,
        resource: value.resource,
        owner: value.owner,
        token: value.token,
        acquired_at: value.acquired_at || new Date().toISOString(),
        expires_at: value.expires_at,
        file_id: String(file.id),
      } satisfies DriveLease;
    });
    return leases.filter((lease): lease is DriveLease => Boolean(lease));
  }

  async listCloudAudit(namespace: string, limit = 100): Promise<Array<Record<string, unknown>>> {
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const { eventsRoot } = await this.cloudNamespaceFolders(namespace);
    const monthFolders = (await this.listChildren(eventsRoot, {
      mimeType: FOLDER_MIME,
      orderBy: 'name desc',
    })).filter(file => file.id && /^\d{4}-\d{2}$/.test(String(file.name || '')));
    const selected: drive_v3.Schema$File[] = [];
    for (const month of monthFolders) {
      const files = (await this.listChildren(String(month.id), {
        mimeType: JSON_MIME,
        orderBy: 'name desc',
      })).filter(file => file.id && file.appProperties?.format === 'zenos-memory-event-v1');
      selected.push(...files.slice(0, boundedLimit - selected.length));
      if (selected.length >= boundedLimit) break;
    }
    const events = await mapLimit(selected, 8, async file => {
      return validateCloudEvent(await this.readJsonById(String(file.id)));
    });
    return events
      .sort((left, right) => compareCloudCursor(
        cloudCursor(right.occurred_at, right.event_id),
        cloudCursor(left.occurred_at, left.event_id),
      ))
      .map(event => ({
        id: event.event_id,
        occurred_at: event.occurred_at,
        actor: event.actor,
        action: event.action,
        namespace: event.namespace,
        request_id: event.request_id || null,
        event_hash: event.checksum,
        previous_cursor: event.previous_cursor || null,
        change_count: event.changes.length,
      }));
  }

  async claimCloudNonce(nonce: string, ttlMs = 2 * 60_000): Promise<boolean> {
    const namespace = '_system';
    const resource = 'auth-nonces';
    const fileId = await this.coordinationFile(namespace, resource);
    const nonceHash = createHash('sha256').update(nonce).digest('hex');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const { payload, etag } = await this.readJsonWithEtag(fileId);
      const raw = payload && typeof payload === 'object'
        ? payload as { nonces?: Record<string, number> }
        : {};
      const now = Date.now();
      const nonces = Object.fromEntries(
        Object.entries(raw.nonces || {}).filter(([, expires]) => Number(expires) > now),
      );
      if (nonces[nonceHash]) return false;
      nonces[nonceHash] = now + ttlMs;
      try {
        await this.updateJsonById(fileId, {
          format: 'zenos-memory-nonce-registry-v1',
          updated_at: new Date(now).toISOString(),
          nonces,
        }, etag);
        const confirmed = await this.readJsonById(fileId) as { nonces?: Record<string, number> };
        if (confirmed.nonces?.[nonceHash] === nonces[nonceHash]) return true;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
      }
      await sleep(30 + Math.floor(Math.random() * 70));
    }
    throw new ConflictError('Unable to claim authentication nonce after concurrent updates');
  }

  async trashCloudNamespace(namespace: string): Promise<{ trashed_roots: number }> {
    const normalized = safeNamespace(namespace);
    const rootFolderId = await this.resolveRootFolderId();
    const targets: string[] = [];

    const cloudRoot = (await this.findChildren(rootFolderId, CLOUD_ROOT_NAME, FOLDER_MIME))[0]?.id;
    if (cloudRoot) {
      const namespacesRoot = (await this.findChildren(cloudRoot, 'namespaces', FOLDER_MIME))[0]?.id;
      if (namespacesRoot) {
        const namespaceRoots = await this.findChildren(namespacesRoot, normalized, FOLDER_MIME);
        targets.push(...namespaceRoots.map(file => String(file.id || '')).filter(Boolean));
      }
    }

    const backupsRoot = (await this.findChildren(rootFolderId, 'zenos-memory-backups', FOLDER_MIME))[0]?.id;
    if (backupsRoot) {
      const backupNamespaces = await this.findChildren(backupsRoot, normalized, FOLDER_MIME);
      targets.push(...backupNamespaces.map(file => String(file.id || '')).filter(Boolean));
    }

    await mapLimit([...new Set(targets)], 4, async fileId => {
      await this.drive.files.update({
        supportsAllDrives: true,
        fileId,
        requestBody: { trashed: true },
        fields: 'id',
      });
    });
    return { trashed_roots: new Set(targets).size };
  }

  async pruneCloudTestNamespaces(olderThanMs = 24 * 60 * 60 * 1000): Promise<{ trashed_test_namespaces: number }> {
    const cutoff = Date.now() - Math.max(60 * 60 * 1000, olderThanMs);
    const testPattern = /^(?:cloud-smoke|concurrency-smoke|smoke)-\d{10,}$/;
    const rootFolderId = await this.resolveRootFolderId();
    const names = new Set<string>();

    const cloudRoot = (await this.findChildren(rootFolderId, CLOUD_ROOT_NAME, FOLDER_MIME))[0]?.id;
    if (cloudRoot) {
      const namespacesRoot = (await this.findChildren(cloudRoot, 'namespaces', FOLDER_MIME))[0]?.id;
      if (namespacesRoot) {
        const folders = await this.listChildren(namespacesRoot, { mimeType: FOLDER_MIME, orderBy: 'createdTime asc' });
        for (const folder of folders) {
          if (folder.name && testPattern.test(folder.name) && new Date(folder.createdTime || 0).getTime() <= cutoff) {
            names.add(folder.name);
          }
        }
      }
    }

    const backupsRoot = (await this.findChildren(rootFolderId, 'zenos-memory-backups', FOLDER_MIME))[0]?.id;
    if (backupsRoot) {
      const folders = await this.listChildren(backupsRoot, { mimeType: FOLDER_MIME, orderBy: 'createdTime asc' });
      for (const folder of folders) {
        if (folder.name && testPattern.test(folder.name) && new Date(folder.createdTime || 0).getTime() <= cutoff) {
          names.add(folder.name);
        }
      }
    }

    let trashed = 0;
    for (const name of names) {
      const result = await this.trashCloudNamespace(name);
      if (result.trashed_roots > 0) trashed += 1;
    }
    return { trashed_test_namespaces: trashed };
  }

  async pruneCloudArtifacts(
    namespace: string,
    options: { snapshotRetention?: number; backupDayRetention?: number; testNamespaceRetentionHours?: number } = {},
  ): Promise<{
    retained_snapshots: number;
    trashed_snapshots: number;
    trashed_indexes: number;
    retained_backup_days: number;
    trashed_backup_days: number;
    trashed_test_namespaces: number;
  }> {
    const snapshotRetention = Math.max(2, Math.min(120, options.snapshotRetention || 14));
    const backupDayRetention = Math.max(2, Math.min(120, options.backupDayRetention || 14));
    const { snapshotsRoot, indexesRoot } = await this.cloudNamespaceFolders(namespace);
    const snapshots = (await this.listChildren(snapshotsRoot, {
      mimeType: JSON_MIME,
      orderBy: 'createdTime desc',
    })).filter(file => file.appProperties?.format === 'zenos-memory-cloud-snapshot-v1' && file.id);
    const obsoleteSnapshots = snapshots.slice(snapshotRetention);
    const obsoleteSnapshotIds = new Set(
      obsoleteSnapshots.map(file => file.appProperties?.snapshotId).filter((value): value is string => Boolean(value)),
    );
    const indexes = (await this.listChildren(indexesRoot, {
      mimeType: JSON_MIME,
      orderBy: 'createdTime desc',
    })).filter(file => file.id && file.appProperties?.snapshotId && obsoleteSnapshotIds.has(file.appProperties.snapshotId));

    const trash = async (files: drive_v3.Schema$File[]) => {
      await mapLimit(files, 6, async file => {
        await this.drive.files.update({
          supportsAllDrives: true,
          fileId: String(file.id),
          requestBody: { trashed: true },
          fields: 'id',
        });
      });
    };
    await trash(indexes);
    await trash(obsoleteSnapshots);

    const rootFolderId = await this.resolveRootFolderId();
    const backupsRoot = (await this.findChildren(rootFolderId, 'zenos-memory-backups', FOLDER_MIME))[0]?.id;
    let backupDays: drive_v3.Schema$File[] = [];
    if (backupsRoot) {
      const namespaceRoot = (await this.findChildren(backupsRoot, safeNamespace(namespace), FOLDER_MIME))[0]?.id;
      if (namespaceRoot) {
        backupDays = (await this.listChildren(namespaceRoot, {
          mimeType: FOLDER_MIME,
          orderBy: 'name desc',
        })).filter(file => file.id && /^\d{4}-\d{2}-\d{2}$/.test(String(file.name || '')));
      }
    }
    const obsoleteBackupDays = backupDays.slice(backupDayRetention);
    await trash(obsoleteBackupDays);
    const testCleanup = process.env.ZENOS_MEMORY_PRUNE_TEST_NAMESPACES === 'true'
      ? await this.pruneCloudTestNamespaces(
          Math.max(1, options.testNamespaceRetentionHours || 24) * 60 * 60 * 1000,
        )
      : { trashed_test_namespaces: 0 };

    return {
      retained_snapshots: Math.min(snapshotRetention, snapshots.length),
      trashed_snapshots: obsoleteSnapshots.length,
      trashed_indexes: indexes.length,
      retained_backup_days: Math.min(backupDayRetention, backupDays.length),
      trashed_backup_days: obsoleteBackupDays.length,
      trashed_test_namespaces: testCleanup.trashed_test_namespaces,
    };
  }

  async createSnapshot(snapshot: DriveSnapshot): Promise<{ file_id: string; manifest_id: string; checksum: string }> {
    const rootFolderId = await this.resolveRootFolderId();
    const backupsRoot = await this.ensureFolder(rootFolderId, 'zenos-memory-backups');
    const namespace = safeNamespace(snapshot.namespace || 'all');
    const namespaceRoot = await this.ensureFolder(backupsRoot, namespace);
    const dayRoot = await this.ensureFolder(namespaceRoot, snapshot.generated_at.slice(0, 10));
    const stamp = snapshot.generated_at.replace(/[:.]/g, '-');
    const base = `snapshot-${namespace}-${stamp}`;
    const fileId = await this.createOrReuseJsonFile(dayRoot, `${base}.json`, snapshot, {
      format: snapshot.format,
      namespace,
      checksum: snapshot.checksum,
    });
    const manifest = {
      format: 'zenos-memory-backup-manifest-v1',
      snapshot_file_id: fileId,
      snapshot_name: `${base}.json`,
      generated_at: snapshot.generated_at,
      namespace: snapshot.namespace,
      count: snapshot.memories.length,
      checksum: snapshot.checksum,
    };
    const manifestId = await this.createOrReuseJsonFile(dayRoot, `${base}.manifest.json`, manifest, {
      format: 'zenos-memory-backup-manifest-v1',
      namespace,
      checksum: snapshot.checksum,
      snapshotFileId: fileId,
    });
    return { file_id: fileId, manifest_id: manifestId, checksum: snapshot.checksum };
  }

  async verifySnapshot(fileId: string, expectedChecksum: string): Promise<boolean> {
    const attempts = Math.max(1, Math.min(6, Number(process.env.ZENOS_MEMORY_DRIVE_VERIFY_ATTEMPTS || 4)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const raw = await this.readJsonById(fileId);
        if (raw && typeof raw === 'object') {
          const snapshot = raw as Partial<DriveSnapshot>;
          if (Array.isArray(snapshot.memories)) {
            const checksum = createHash('sha256').update(JSON.stringify(snapshot.memories)).digest('hex');
            if (checksum === expectedChecksum && snapshot.checksum === expectedChecksum) return true;
          }
        }
      } catch (error) {
        if (attempt === attempts - 1) throw error;
      }
      if (attempt < attempts - 1) await sleep(250 * (2 ** attempt));
    }
    return false;
  }

  async readAll(namespace = 'zenos'): Promise<Memory[]> {
    return (await this.loadCloudState(namespace)).memories;
  }

  async writeAll(memories: Memory[], namespace = 'zenos'): Promise<void> {
    await this.createCloudSnapshot({
      namespace,
      memories,
      cursor: null,
      event_count: 0,
      snapshot_id: null,
      revision: createHash('sha256').update(JSON.stringify(memories)).digest('hex'),
    });
  }

  async listFilesInFolder(): Promise<drive_v3.Schema$File[]> {
    return this.listChildren(await this.resolveRootFolderId(), { orderBy: 'modifiedTime desc', pageSize: 100 });
  }
}

export function createDriveStore(): GoogleDriveMemoryStore {
  const folderId = process.env.ZENOS_MEMORY_DRIVE_FOLDER_ID?.trim();
  const folderName = process.env.GOOGLE_DRIVE_FOLDER_NAME?.trim();
  if (!folderId && !folderName) throw new StorageError('Google Drive folder id or name is not configured');

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();
  if (clientId && clientSecret && refreshToken) {
    return new GoogleDriveMemoryStore({ folderId, folderName, oauth: { clientId, clientSecret, refreshToken } });
  }

  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim();
  if (keyFile) {
    return new GoogleDriveMemoryStore({
      folderId,
      folderName,
      credentials: parseCredentialJson(readFileSync(keyFile, 'utf8'), keyFile),
    });
  }
  if (keyJson) {
    return new GoogleDriveMemoryStore({
      folderId,
      folderName,
      credentials: parseCredentialJson(keyJson, 'GOOGLE_SERVICE_ACCOUNT_KEY'),
    });
  }

  throw new StorageError('Google Drive credentials are not configured');
}

export function createDriveStoreIfConfigured(): GoogleDriveMemoryStore | null {
  return hasDriveConfiguration() ? createDriveStore() : null;
}
