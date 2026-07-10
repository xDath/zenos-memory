import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConflictError, StorageError } from './errors';
import { Memory, MemorySchema, MemoryType } from './schema';
import { contentHash, redactSensitiveText, sanitizeUnknown } from './secrets';

interface MemoryRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  type: string;
  content: string;
  metadata_json: string;
  embedding_json: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  deleted_at: string | null;
}

export interface StoreListOptions {
  namespace?: string;
  type?: MemoryType;
  limit?: number;
  includeArchived?: boolean;
  includeDeleted?: boolean;
  createdAfter?: string;
  createdBefore?: string;
}

export interface StoreSearchOptions extends StoreListOptions {
  query?: string;
  candidateLimit?: number;
}

export interface StoreHealth {
  ok: boolean;
  path: string;
  journal_mode: string;
  integrity: string;
  active_memories: number;
  deleted_memories: number;
  database_bytes: number | null;
  schema_version: number;
}

export interface LeaseRecord {
  resource: string;
  namespace: string;
  owner: string;
  token: string;
  acquired_at: string;
  expires_at: string;
}

function resolveDatabasePath(): string {
  const configured = process.env.ZENOS_MEMORY_DB_PATH?.trim();
  const production = process.env.NODE_ENV === 'production';
  const isVercel = process.env.VERCEL === '1';
  const cloudCache = process.env.ZENOS_MEMORY_STORAGE_MODE === 'drive-events';

  if (configured) {
    const resolved = path.resolve(configured);
    if (production && resolved.startsWith('/tmp/') && !cloudCache && process.env.ZENOS_MEMORY_ALLOW_EPHEMERAL !== 'true') {
      throw new StorageError('Production database path cannot be under /tmp unless it is an explicitly ephemeral cloud cache');
    }
    return resolved;
  }

  if (cloudCache || isVercel) {
    if (!cloudCache && process.env.ZENOS_MEMORY_ALLOW_EPHEMERAL !== 'true') {
      throw new StorageError('Vercel requires ZENOS_MEMORY_STORAGE_MODE=drive-events or an explicit demo override');
    }
    return '/tmp/zenos-memory-cache.sqlite';
  }

  return production
    ? '/var/lib/zenos-memory/zenos-memory.sqlite'
    : path.join(process.cwd(), '.data', 'zenos-memory.sqlite');
}

function jsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new StorageError('Stored JSON is invalid', error);
  }
}

function normalizeLegacyMemory(memory: Memory): Memory {
  if (memory.type !== 'credential' && !memory.metadata.is_secret) return memory;

  const service = memory.metadata.credential_for || 'legacy';
  return MemorySchema.parse({
    ...memory,
    type: 'secret_reference',
    content: `vault://legacy/${service}/${memory.id}`,
    metadata: {
      ...memory.metadata,
      is_secret: false,
      redacted: true,
      status: 'archived',
      secret_reference: `vault://legacy/${service}/${memory.id}`,
      description: memory.metadata.description || 'Legacy credential was redacted during production migration',
      tags: [...new Set([...(memory.metadata.tags || []), 'legacy-secret-redacted'])],
    },
  });
}

function rowToMemory(row: MemoryRow): Memory {
  const parsed = MemorySchema.safeParse({
    id: row.id,
    namespace: row.namespace,
    type: row.type,
    content: row.content,
    metadata: jsonParse(row.metadata_json, {}),
    embedding: jsonParse<number[] | undefined>(row.embedding_json, undefined),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  if (!parsed.success) {
    throw new StorageError(`Memory ${row.id} failed integrity validation`, parsed.error);
  }
  return normalizeLegacyMemory(parsed.data);
}

function tagsText(memory: Memory): string {
  return [
    ...(memory.metadata.tags || []),
    ...(memory.metadata.entities || []),
    memory.type,
  ].join(' ');
}

function ftsQuery(input: string): string | null {
  const terms = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .split(/\s+/)
    .filter(term => term.length > 1)
    .slice(0, 24);
  if (!terms.length) return null;
  return terms.map(term => `"${term.replace(/"/g, '""')}"*`).join(' OR ');
}

export class SqliteMemoryStore {
  private readonly databasePath: string;
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(databasePath = resolveDatabasePath()) {
    this.databasePath = databasePath;
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 10_000,
    });
    this.initialize();
    try {
      chmodSync(databasePath, 0o600);
    } catch {
      // Some managed filesystems do not support chmod. The readiness endpoint reports the path.
    }
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 10000;
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA secure_delete = ON;

      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        embedding_json TEXT,
        content_hash TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_namespace_updated
        ON memories(namespace, updated_at DESC)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memories_namespace_type
        ON memories(namespace, type)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_memories_hash
        ON memories(namespace, content_hash)
        WHERE deleted_at IS NULL;

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        namespace UNINDEXED,
        content,
        tags,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        namespace TEXT,
        memory_id TEXT,
        request_id TEXT,
        details_json TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_namespace_time
        ON audit_events(namespace, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at);

      CREATE TABLE IF NOT EXISTS lock_leases (
        resource TEXT NOT NULL,
        namespace TEXT NOT NULL,
        owner TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(resource, namespace)
      );
      CREATE INDEX IF NOT EXISTS idx_lock_leases_expiry ON lock_leases(expires_at);

      INSERT INTO schema_meta(key, value, updated_at)
      VALUES ('schema_version', '2', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    `);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original exception.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private refreshFts(memory: Memory): void {
    this.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(memory.id);
    this.db.prepare(
      'INSERT INTO memory_fts(id, namespace, content, tags) VALUES (?, ?, ?, ?)',
    ).run(memory.id, memory.namespace, memory.content, tagsText(memory));
  }

  insert(memory: Memory): Memory {
    const normalized = normalizeLegacyMemory(MemorySchema.parse(memory));
    return this.transaction(() => {
      this.db.prepare(`
        INSERT INTO memories(
          id, namespace, type, content, metadata_json, embedding_json,
          content_hash, revision, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        normalized.id,
        normalized.namespace,
        normalized.type,
        normalized.content,
        JSON.stringify(normalized.metadata),
        normalized.embedding ? JSON.stringify(normalized.embedding) : null,
        contentHash(normalized.content),
        normalized.metadata.version || 1,
        normalized.created_at,
        normalized.updated_at,
      );
      this.refreshFts(normalized);
      return normalized;
    });
  }

  insertMany(memories: Memory[]): Memory[] {
    return this.transaction(() => memories.map(memory => this.insert(memory)));
  }

  update(memory: Memory, expectedVersion?: number): Memory {
    const normalized = normalizeLegacyMemory(MemorySchema.parse(memory));
    return this.transaction(() => {
      const current = this.get(normalized.id, normalized.namespace, true);
      if (!current) throw new ConflictError(`Memory ${normalized.id} no longer exists`);
      const currentVersion = current.metadata.version || 1;
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new ConflictError('Memory changed since it was read', {
          expected_version: expectedVersion,
          current_version: currentVersion,
        });
      }

      const result = this.db.prepare(`
        UPDATE memories SET
          namespace = ?, type = ?, content = ?, metadata_json = ?, embedding_json = ?,
          content_hash = ?, revision = ?, updated_at = ?, deleted_at = NULL
        WHERE id = ? AND revision = ?
      `).run(
        normalized.namespace,
        normalized.type,
        normalized.content,
        JSON.stringify(normalized.metadata),
        normalized.embedding ? JSON.stringify(normalized.embedding) : null,
        contentHash(normalized.content),
        normalized.metadata.version || currentVersion + 1,
        normalized.updated_at,
        normalized.id,
        currentVersion,
      );

      if (result.changes !== 1) {
        throw new ConflictError('Concurrent memory update detected');
      }
      this.refreshFts(normalized);
      return normalized;
    });
  }

  get(id: string, namespace?: string, includeDeleted = false): Memory | null {
    const conditions = ['id = ?'];
    const params: unknown[] = [id];
    if (namespace) {
      conditions.push('namespace = ?');
      params.push(namespace);
    }
    if (!includeDeleted) conditions.push('deleted_at IS NULL');
    const row = this.db.prepare(`SELECT * FROM memories WHERE ${conditions.join(' AND ')} LIMIT 1`).get(...params) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  findByContentHash(namespace: string, hash: string, limit = 20): Memory[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE namespace = ? AND content_hash = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT ?
    `).all(namespace, hash, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  list(options: StoreListOptions = {}): Memory[] {
    const conditions = ['1 = 1'];
    const params: unknown[] = [];
    if (options.namespace) {
      conditions.push('namespace = ?');
      params.push(options.namespace);
    }
    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (!options.includeDeleted) conditions.push('deleted_at IS NULL');
    if (!options.includeArchived) conditions.push("json_extract(metadata_json, '$.status') != 'archived'");
    if (options.createdAfter) {
      conditions.push('created_at >= ?');
      params.push(options.createdAfter);
    }
    if (options.createdBefore) {
      conditions.push('created_at <= ?');
      params.push(options.createdBefore);
    }
    const limit = Math.max(1, Math.min(options.limit || 1000, 10_000));
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...params) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  searchCandidates(options: StoreSearchOptions): Memory[] {
    const query = options.query?.trim() || '';
    const candidateLimit = Math.max(20, Math.min(options.candidateLimit || 300, 2000));
    const match = ftsQuery(query);

    if (!match) return this.list({ ...options, limit: candidateLimit });

    const conditions = ['m.deleted_at IS NULL', 'm.namespace = ?'];
    const params: unknown[] = [match, options.namespace || 'zenos'];
    if (options.type) {
      conditions.push('m.type = ?');
      params.push(options.type);
    }
    if (!options.includeArchived) conditions.push("json_extract(m.metadata_json, '$.status') != 'archived'");
    if (options.createdAfter) {
      conditions.push('m.created_at >= ?');
      params.push(options.createdAfter);
    }
    if (options.createdBefore) {
      conditions.push('m.created_at <= ?');
      params.push(options.createdBefore);
    }
    params.push(candidateLimit);

    const rows = this.db.prepare(`
      SELECT m.*
      FROM memory_fts f
      JOIN memories m ON m.id = f.id
      WHERE f.memory_fts MATCH ? AND ${conditions.join(' AND ')}
      ORDER BY bm25(memory_fts, 0.0, 4.0, 1.5), m.updated_at DESC
      LIMIT ?
    `).all(...params) as MemoryRow[];

    if (rows.length >= Math.min(20, candidateLimit)) return rows.map(rowToMemory);

    const fallback = this.list({ ...options, limit: candidateLimit });
    const seen = new Set(rows.map(row => row.id));
    return [...rows.map(rowToMemory), ...fallback.filter(memory => !seen.has(memory.id))].slice(0, candidateLimit);
  }

  touch(ids: string[], namespace?: string): void {
    if (!ids.length) return;
    const now = new Date().toISOString();
    this.transaction(() => {
      const statement = this.db.prepare(`
        UPDATE memories
        SET metadata_json = json_set(
          metadata_json,
          '$.access_count', COALESCE(json_extract(metadata_json, '$.access_count'), 0) + 1,
          '$.last_accessed_at', ?
        ), updated_at = ?
        WHERE id = ? AND deleted_at IS NULL${namespace ? ' AND namespace = ?' : ''}
      `);
      for (const id of ids) {
        if (namespace) statement.run(now, now, id, namespace);
        else statement.run(now, now, id);
      }
    });
  }

  softDelete(id: string, namespace?: string, expectedVersion?: number): boolean {
    return this.transaction(() => {
      const current = this.get(id, namespace);
      if (!current) return false;
      const version = current.metadata.version || 1;
      if (expectedVersion !== undefined && version !== expectedVersion) {
        throw new ConflictError('Memory changed since it was read', {
          expected_version: expectedVersion,
          current_version: version,
        });
      }
      const now = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE memories
        SET deleted_at = ?, updated_at = ?, revision = revision + 1,
            metadata_json = json_set(metadata_json, '$.status', 'archived', '$.version', revision + 1)
        WHERE id = ? AND revision = ?${namespace ? ' AND namespace = ?' : ''}
      `).run(...(namespace ? [now, now, id, version, namespace] : [now, now, id, version]));
      if (result.changes === 1) this.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id);
      return result.changes === 1;
    });
  }

  hardDelete(id: string, namespace?: string): boolean {
    return this.transaction(() => {
      const result = this.db.prepare(`DELETE FROM memories WHERE id = ?${namespace ? ' AND namespace = ?' : ''}`)
        .run(...(namespace ? [id, namespace] : [id]));
      this.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id);
      return result.changes === 1;
    });
  }

  replaceNamespace(namespace: string, memories: Memory[]): void {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM memories WHERE namespace = ?').all(namespace) as Array<{ id: string }>;
      this.db.prepare('DELETE FROM memories WHERE namespace = ?').run(namespace);
      for (const row of existing) this.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(row.id);

      const canonical = new Map<string, Memory>();
      for (const candidate of memories) {
        const memory = MemorySchema.parse({ ...candidate, namespace });
        const current = canonical.get(memory.id);
        if (!current) {
          canonical.set(memory.id, memory);
          continue;
        }
        const currentVersion = current.metadata.version || 1;
        const nextVersion = memory.metadata.version || 1;
        if (nextVersion > currentVersion || (nextVersion === currentVersion && memory.updated_at > current.updated_at)) {
          canonical.set(memory.id, memory);
        }
      }
      for (const memory of canonical.values()) this.insert(memory);
    });
  }

  count(namespace?: string, includeDeleted = false): number {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (namespace) {
      conditions.push('namespace = ?');
      params.push(namespace);
    }
    if (!includeDeleted) conditions.push('deleted_at IS NULL');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM memories ${where}`).get(...params) as { total?: number } | undefined;
    return Number(row?.total || 0);
  }

  appendAudit(input: {
    actor?: string;
    action: string;
    namespace?: string;
    memoryId?: string;
    requestId?: string;
    details?: Record<string, unknown>;
  }): void {
    const previous = this.db.prepare('SELECT event_hash FROM audit_events ORDER BY occurred_at DESC, rowid DESC LIMIT 1').get() as { event_hash?: string } | undefined;
    const event = {
      id: randomUUID(),
      occurred_at: new Date().toISOString(),
      actor: input.actor || 'system',
      action: input.action,
      namespace: input.namespace || null,
      memory_id: input.memoryId || null,
      request_id: input.requestId || null,
      details: sanitizeUnknown(input.details || {}),
      previous_hash: previous?.event_hash || null,
    };
    const eventHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    this.db.prepare(`
      INSERT INTO audit_events(
        id, occurred_at, actor, action, namespace, memory_id, request_id,
        details_json, previous_hash, event_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.occurred_at,
      event.actor,
      event.action,
      event.namespace,
      event.memory_id,
      event.request_id,
      JSON.stringify(event.details),
      event.previous_hash,
      eventHash,
    );
  }

  listAudit(namespace?: string, limit = 100): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`
      SELECT id, occurred_at, actor, action, namespace, memory_id, request_id,
             details_json, previous_hash, event_hash
      FROM audit_events
      ${namespace ? 'WHERE namespace = ?' : ''}
      ORDER BY occurred_at DESC, rowid DESC
      LIMIT ?
    `).all(...(namespace ? [namespace, Math.min(limit, 1000)] : [Math.min(limit, 1000)]));
    return rows.map(row => ({
      ...row,
      details: jsonParse(String(row.details_json || '{}'), {}),
      details_json: undefined,
    }));
  }

  getIdempotent<T>(key: string, operation: string): T | null {
    this.db.prepare('DELETE FROM idempotency_keys WHERE expires_at < ?').run(new Date().toISOString());
    const row = this.db.prepare(`
      SELECT response_json FROM idempotency_keys
      WHERE key = ? AND operation = ? AND expires_at >= ?
    `).get(key, operation, new Date().toISOString()) as { response_json?: string } | undefined;
    return row?.response_json ? jsonParse<T>(row.response_json, null as T) : null;
  }

  putIdempotent(key: string, operation: string, response: unknown, ttlMs = 24 * 60 * 60 * 1000): void {
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs);
    this.db.prepare(`
      INSERT INTO idempotency_keys(key, operation, response_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        operation = excluded.operation,
        response_json = excluded.response_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(key, operation, JSON.stringify(response), now.toISOString(), expires.toISOString());
  }

  acquireLease(resource: string, namespace: string, owner: string, ttlMs: number): LeaseRecord | null {
    return this.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      this.db.prepare('DELETE FROM lock_leases WHERE expires_at <= ?').run(nowIso);
      const existing = this.db.prepare(`
        SELECT resource, namespace, owner, token, acquired_at, expires_at
        FROM lock_leases WHERE resource = ? AND namespace = ?
      `).get(resource, namespace) as LeaseRecord | undefined;
      if (existing) return existing.owner === owner ? existing : null;

      const lease: LeaseRecord = {
        resource,
        namespace,
        owner,
        token: randomUUID(),
        acquired_at: nowIso,
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      };
      this.db.prepare(`
        INSERT INTO lock_leases(resource, namespace, owner, token, acquired_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(lease.resource, lease.namespace, lease.owner, lease.token, lease.acquired_at, lease.expires_at);
      return lease;
    });
  }

  renewLease(token: string, owner: string, ttlMs: number): LeaseRecord | null {
    return this.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const result = this.db.prepare(`
        UPDATE lock_leases SET expires_at = ?
        WHERE token = ? AND owner = ? AND expires_at > ?
      `).run(expiresAt, token, owner, nowIso);
      if (result.changes !== 1) return null;
      return this.db.prepare(`
        SELECT resource, namespace, owner, token, acquired_at, expires_at
        FROM lock_leases WHERE token = ?
      `).get(token) as LeaseRecord | undefined || null;
    });
  }

  releaseLease(token: string, owner: string): boolean {
    const result = this.db.prepare('DELETE FROM lock_leases WHERE token = ? AND owner = ?').run(token, owner);
    return result.changes === 1;
  }

  listLeases(namespace?: string): LeaseRecord[] {
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM lock_leases WHERE expires_at <= ?').run(now);
    const rows = this.db.prepare(`
      SELECT resource, namespace, owner, token, acquired_at, expires_at
      FROM lock_leases
      ${namespace ? 'WHERE namespace = ?' : ''}
      ORDER BY expires_at ASC
    `).all(...(namespace ? [namespace] : []));
    return rows.map(row => ({
      resource: String(row.resource),
      namespace: String(row.namespace),
      owner: String(row.owner),
      token: String(row.token),
      acquired_at: String(row.acquired_at),
      expires_at: String(row.expires_at),
    }));
  }

  health(): StoreHealth {
    const quick = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const journal = this.db.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined;
    const pageCount = this.db.prepare('PRAGMA page_count').get() as Record<string, unknown> | undefined;
    const pageSize = this.db.prepare('PRAGMA page_size').get() as Record<string, unknown> | undefined;
    const schema = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    const active = this.count(undefined, false);
    const total = this.count(undefined, true);
    const integrity = String(Object.values(quick || {})[0] || 'unknown');
    return {
      ok: integrity === 'ok',
      path: this.databasePath,
      journal_mode: String(Object.values(journal || {})[0] || 'unknown'),
      integrity,
      active_memories: active,
      deleted_memories: Math.max(0, total - active),
      database_bytes: Number(Object.values(pageCount || {})[0] || 0) * Number(Object.values(pageSize || {})[0] || 0) || null,
      schema_version: Number(schema?.value || 0),
    };
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  exportSnapshot(namespace?: string): {
    format: 'zenos-memory-snapshot-v1';
    generated_at: string;
    namespace: string | null;
    checksum: string;
    memories: Memory[];
  } {
    const memories = this.list({ namespace, limit: 10_000, includeArchived: true });
    const payload = JSON.stringify(memories);
    return {
      format: 'zenos-memory-snapshot-v1',
      generated_at: new Date().toISOString(),
      namespace: namespace || null,
      checksum: createHash('sha256').update(payload).digest('hex'),
      memories,
    };
  }
}

let singleton: SqliteMemoryStore | null = null;

export function getSqliteStore(): SqliteMemoryStore {
  if (!singleton) singleton = new SqliteMemoryStore();
  return singleton;
}

export function resetSqliteStoreForTests(): void {
  singleton?.close();
  singleton = null;
}

export function describeDatabasePath(): string {
  return resolveDatabasePath();
}

export function redactDatabasePath(input: string): string {
  return redactSensitiveText(input).replace(/^\/root\//, '~/');
}
