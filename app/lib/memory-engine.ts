import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createDriveStoreIfConfigured,
  DriveLease,
  GoogleDriveMemoryStore,
} from './drive';
import {
  buildCloudEvent,
  CloudMemoryChange,
  CloudMemoryEvent,
  cloudCursor,
  deterministicEventId,
  deterministicMemoryId,
  MaterializedCloudState,
} from './cloud-events';
import { ConflictError, StorageError, ValidationError } from './errors';
import { rankHybrid } from './hybrid-retrieval';
import { buildKnowledgeMemories } from './knowledge-ingestion';
import {
  RecallFeedbackRequest,
  RecallFeedbackRequestSchema,
  RecallFeedbackResult,
} from './recall-feedback';
import { buildMutationPlan } from './memory-mutation';
import { buildMaintenanceReport } from './memory-maintainer';
import { EmbeddingResult, getEmbedding, getEmbeddings } from './neural-embedding';
import { memoryOperationMode, resourceLimits } from './resource-policy';
import {
  InternalRecallRequestSchema,
  Memory,
  MemoryMetadata,
  MemoryMetadataSchema,
  MemorySchema,
  MemorySnapshotSchema,
  MemoryType,
  normalizeNamespace,
  NormalizedRememberRequest,
  RecallRequest,
  RememberRequest,
  RememberRequestSchema,
} from './schema';
import { assertMemorySafe, contentHash, redactSensitiveText } from './secrets';
import { getSqliteStore, resetSqliteStoreForTests, SqliteMemoryStore } from './sqlite-store';

type ScoredMemory = Memory & {
  quality?: number;
  score?: number;
  reason?: string;
  signals?: Record<string, number>;
};

interface MaintenanceBackupResult {
  destination: string;
  verified: boolean;
  count: number;
  [key: string]: unknown;
}

interface MemoryHealthResult {
  ok: boolean;
  total: number;
  unhealthy: number;
  items: Array<{
    id: string;
    quality: number;
    content: string;
    updated_at: string;
    status: Memory['metadata']['status'];
  }>;
  storage: ReturnType<SqliteMemoryStore['health']>;
  recommendations: string[];
}

interface MaintenanceCycleResult {
  namespace: string;
  decayed: number;
  embeddings: { updated: number; space: string; degraded: number };
  backup: MaintenanceBackupResult | null;
  retention: Record<string, unknown> | null;
  health: MemoryHealthResult;
  maintenance: ReturnType<typeof buildMaintenanceReport> | null;
}

export interface MemoryUpdate {
  type?: MemoryType;
  content?: string;
  namespace?: string;
  metadata?: Partial<MemoryMetadata>;
  embedding?: number[];
}

type TokenVector = Map<string, number>;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'with',
  'yang', 'dan', 'atau', 'ini', 'itu', 'buat', 'dari', 'ke', 'di', 'gue', 'lu', 'kan', 'jadi', 'aja', 'sama',
]);

const SECRET_TYPES = new Set<MemoryType>(['credential', 'secret_reference']);

function uniqueStrings(values: Array<string | undefined>, max = 256): string[] {
  return [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, max);
}

function metadataExtra(metadata: Partial<MemoryMetadata> | undefined): Record<string, unknown> {
  return (metadata || {}) as Record<string, unknown>;
}

function embeddingMetadata(result: EmbeddingResult): Partial<MemoryMetadata> {
  return {
    embedding_provider: result.provider,
    embedding_space: result.space,
    embedding_dimensions: result.dimensions,
    embedding_generated_at: new Date().toISOString(),
    embedding_degraded: !result.ok,
    embedding_error: result.ok ? undefined : result.error?.slice(0, 500),
  };
}

export class MemoryEngine {
  private readonly store: SqliteMemoryStore;
  private readonly driveBackup: GoogleDriveMemoryStore | null;
  private readonly cloudMode: boolean;
  private readonly cloudRefreshMs: number;
  private readonly namespaceState = new Map<string, { revision: string; loadedAt: number; cursor: string | null; eventCount: number }>();
  private readonly namespaceRefreshes = new Map<string, Promise<void>>();
  private readonly readinessRefreshStartedAt = new Map<string, number>();
  private readonly namespaceWriteGates = new Map<string, Promise<void>>();
  private readonly writeContext = new AsyncLocalStorage<{
    namespace: string;
    lease: DriveLease;
    assertLease: () => Promise<DriveLease>;
    deferred?: {
      events: CloudMemoryEvent[];
      idempotencyKeys: Set<string>;
    };
  }>();
  private readyPromise: Promise<void> | null = null;
  private readonly readinessRefreshMs: number;

  constructor(options: { store?: SqliteMemoryStore; driveBackup?: GoogleDriveMemoryStore | null } = {}) {
    this.store = options.store || getSqliteStore();
    this.driveBackup = options.driveBackup === undefined ? createDriveStoreIfConfigured() : options.driveBackup;
    this.cloudMode = process.env.ZENOS_MEMORY_STORAGE_MODE === 'drive-events';
    this.cloudRefreshMs = Math.max(0, Number(process.env.ZENOS_MEMORY_CLOUD_REFRESH_MS || 1500));
    this.readinessRefreshMs = Math.max(
      5_000,
      Number(process.env.ZENOS_MEMORY_READINESS_REFRESH_MS || 60_000),
    );
    if (this.cloudMode && !this.driveBackup) {
      throw new StorageError('Drive event mode requires Google Drive OAuth or service-account configuration');
    }
  }

  private async ensureReady(namespace = process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos', force = false): Promise<void> {
    const normalized = normalizeNamespace(namespace);
    if (this.cloudMode) {
      const activeWrite = this.namespaceWriteGates.get(normalized);
      const ownWrite = this.writeContext.getStore()?.namespace === normalized;
      if (ownWrite) return;
      if (activeWrite) await activeWrite;
      await this.refreshCloudNamespace(normalized, force);
      return;
    }
    if (!this.readyPromise) this.readyPromise = this.importLegacyDataIfNeeded();
    await this.readyPromise;
  }

  private async importLegacyDataIfNeeded(): Promise<void> {
    if (this.store.count(undefined, true) > 0) return;
    if (process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START !== 'true' || !this.driveBackup) return;

    const namespaces = uniqueStrings(
      (process.env.ZENOS_MEMORY_LEGACY_NAMESPACES || 'zenos')
        .split(',')
        .map(value => value.trim()),
      32,
    );

    for (const namespace of namespaces) {
      const memories = await this.driveBackup.readLegacyMemories(namespace);
      if (!memories.length) continue;
      const normalized = memories.map(memory => MemorySchema.parse({ ...memory, namespace }));
      this.store.replaceNamespace(namespace, normalized);
      this.store.appendAudit({
        action: 'legacy_import',
        namespace,
        details: { imported: normalized.length, source: 'google-drive' },
      });
    }
  }

  private async refreshCloudNamespace(namespace: string, force = false): Promise<void> {
    if (!this.cloudMode || !this.driveBackup) return;
    const normalized = normalizeNamespace(namespace);
    const current = this.namespaceState.get(normalized);
    if (!force && current && Date.now() - current.loadedAt < this.cloudRefreshMs) return;
    const existing = this.namespaceRefreshes.get(normalized);
    if (existing) return existing;

    const refresh = (async () => {
      let state = await this.driveBackup!.loadCloudState(normalized);
      if (!state.snapshot_id && state.event_count === 0 && state.memories.length === 0
        && process.env.ZENOS_MEMORY_IMPORT_LEGACY_ON_START !== 'false') {
        const legacy = await this.driveBackup!.readLegacyMemories(normalized);
        if (legacy.length) state = await this.driveBackup!.initializeCloudNamespace(normalized, legacy);
      }
      const known = this.namespaceState.get(normalized);
      if (force || !known || known.revision !== state.revision) {
        this.store.replaceNamespace(normalized, state.memories);
      }
      this.namespaceState.set(normalized, {
        revision: state.revision,
        loadedAt: Date.now(),
        cursor: state.cursor,
        eventCount: state.event_count,
      });
    })().finally(() => this.namespaceRefreshes.delete(normalized));
    this.namespaceRefreshes.set(normalized, refresh);
    return refresh;
  }

  private async withCloudWrite<T>(
    namespace: string,
    action: string,
    operation: () => Promise<T>,
    options: { deferEvents?: boolean } = {},
  ): Promise<T> {
    const normalized = normalizeNamespace(namespace);
    if (!this.cloudMode || !this.driveBackup) {
      await this.ensureReady(normalized);
      return operation();
    }
    const active = this.writeContext.getStore();
    if (active?.namespace === normalized) return operation();
    const pendingLocalWrite = this.namespaceWriteGates.get(normalized);
    if (pendingLocalWrite) await pendingLocalWrite;

    const owner = `${process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_REGION || 'node'}:${process.pid}:${action}:${randomUUID()}`;
    const leaseTtlMs = Math.max(
      30_000,
      Math.min(5 * 60_000, Number(process.env.ZENOS_MEMORY_WRITE_LEASE_MS || 90_000)),
    );
    let currentLease = await this.driveBackup.acquireCloudLease(
      normalized,
      'namespace-write',
      owner,
      leaseTtlMs,
      Math.max(5_000, Number(process.env.ZENOS_MEMORY_WRITE_WAIT_MS || 15_000)),
    );
    let leaseFailure: Error | null = null;
    let renewInFlight: Promise<DriveLease> | null = null;
    const assertLease = async (): Promise<DriveLease> => {
      if (leaseFailure) throw leaseFailure;
      if (!renewInFlight) {
        renewInFlight = this.driveBackup!.renewCloudLease(currentLease, leaseTtlMs)
          .then((renewed) => {
            currentLease = renewed;
            return renewed;
          })
          .catch((error) => {
            leaseFailure = error instanceof Error ? error : new ConflictError('Drive lease renewal failed');
            throw leaseFailure;
          })
          .finally(() => {
            renewInFlight = null;
          });
      }
      return renewInFlight;
    };
    const heartbeat = setInterval(() => {
      void assertLease().catch(() => undefined);
    }, Math.max(5_000, Math.floor(leaseTtlMs / 3)));
    heartbeat.unref?.();

    const deferred = options.deferEvents
      ? { events: [] as CloudMemoryEvent[], idempotencyKeys: new Set<string>() }
      : undefined;
    let releaseWriteGate!: () => void;
    const writeGate = new Promise<void>(resolve => {
      releaseWriteGate = resolve;
    });
    this.namespaceWriteGates.set(normalized, writeGate);
    try {
      await this.refreshCloudNamespace(normalized, true);
      const result = await this.writeContext.run({
        namespace: normalized,
        lease: currentLease,
        assertLease,
        deferred,
      }, operation);
      // Fencing check: never publish a final event batch after ownership was
      // lost or the lease silently expired during a slow embedding/LLM call.
      await assertLease();
      if (deferred?.events.length) {
        await this.reserveCloudResources({
          driveWrites: deferred.events.length + 1,
          storageBytesWritten: deferred.events.reduce(
            (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
            0,
          ),
        });
        await this.driveBackup.appendCloudEvents(
          deferred.events,
          Number(process.env.ZENOS_MEMORY_EVENT_UPLOAD_CONCURRENCY || 4),
        );
        await this.refreshCloudNamespace(normalized, true);
      }
      return result;
    } catch (error) {
      for (const key of deferred?.idempotencyKeys || []) {
        this.store.deleteIdempotent(key, 'remember');
      }
      // A cloud write mutates only the ephemeral materialized view before its
      // immutable Drive event is uploaded. Re-materialize on failure so a warm
      // function can never serve an uncommitted (phantom) mutation.
      await this.refreshCloudNamespace(normalized, true).catch(() => {
        this.namespaceState.delete(normalized);
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      const pendingRenewal = renewInFlight as Promise<DriveLease> | null;
      if (pendingRenewal) await pendingRenewal.catch(() => undefined);
      if (this.namespaceWriteGates.get(normalized) === writeGate) {
        this.namespaceWriteGates.delete(normalized);
      }
      releaseWriteGate();
      await this.driveBackup.releaseCloudLease(currentLease).catch(() => false);
    }
  }

  private async reserveCloudResources(input: {
    driveWrites?: number;
    storageBytesWritten?: number;
    llmTokens?: number;
  }): Promise<void> {
    if (!this.cloudMode || !this.driveBackup) return;
    const quotaAware = this.driveBackup as GoogleDriveMemoryStore & {
      reserveResourceUsage?: (reservation: {
        driveWrites?: number;
        storageBytesWritten?: number;
        llmTokens?: number;
      }) => Promise<unknown>;
    };
    if (typeof quotaAware.reserveResourceUsage !== 'function') return;
    await quotaAware.reserveResourceUsage(input);
  }

  private async persistCloudChanges(input: {
    namespace: string;
    action: string;
    changes: CloudMemoryChange[];
    idempotencyKey?: string;
    requestId?: string;
    actor?: string;
  }): Promise<void> {
    if (!this.cloudMode || !this.driveBackup || !input.changes.length) return;
    const normalized = normalizeNamespace(input.namespace);
    const state = this.namespaceState.get(normalized);
    const active = this.writeContext.getStore();
    const deferred = active?.namespace === normalized ? active.deferred : undefined;
    const previousEvent = deferred?.events.at(-1);
    const previousCursor = previousEvent
      ? cloudCursor(previousEvent.occurred_at, previousEvent.event_id)
      : state?.cursor;
    const event = buildCloudEvent({
      namespace: normalized,
      action: input.action,
      actor: input.actor,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      changes: input.changes,
      previousCursor,
    });

    if (deferred) {
      deferred.events.push(event);
      if (input.idempotencyKey) deferred.idempotencyKeys.add(input.idempotencyKey);
      return;
    }

    if (active?.namespace === normalized) await active.assertLease();
    await this.reserveCloudResources({
      driveWrites: 2,
      storageBytesWritten: Buffer.byteLength(JSON.stringify(event)),
    });
    const uploaded = await this.driveBackup.appendCloudEvent(event);
    const nextState: MaterializedCloudState = {
      namespace: normalized,
      memories: this.store.list({ namespace: normalized, limit: 10_000, includeArchived: true }),
      cursor: uploaded.cursor,
      event_count: (state?.eventCount || 0) + (uploaded.deduplicated ? 0 : 1),
      snapshot_id: null,
      revision: createHash('sha256').update(JSON.stringify({ cursor: uploaded.cursor, changes: input.changes })).digest('hex'),
    };
    this.namespaceState.set(normalized, {
      revision: nextState.revision,
      loadedAt: Date.now(),
      cursor: nextState.cursor,
      eventCount: nextState.event_count,
    });
  }

  private tokenize(text: string): string[] {
    return text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length > 2 && !STOP_WORDS.has(token));
  }

  private vectorize(text: string): TokenVector {
    const vector = new Map<string, number>();
    for (const token of this.tokenize(text)) vector.set(token, (vector.get(token) || 0) + 1);
    return vector;
  }

  private cosineSimilarity(a: string, b: string): number {
    const left = this.vectorize(a);
    const right = this.vectorize(b);
    if (!left.size || !right.size) return 0;
    let dot = 0;
    let normLeft = 0;
    let normRight = 0;
    for (const value of left.values()) normLeft += value * value;
    for (const value of right.values()) normRight += value * value;
    for (const [key, value] of left) dot += value * (right.get(key) || 0);
    return dot / ((Math.sqrt(normLeft) * Math.sqrt(normRight)) || 1);
  }

  private jaccardSimilarity(a: string, b: string): number {
    const left = new Set(this.tokenize(a));
    const right = new Set(this.tokenize(b));
    if (!left.size || !right.size) return 0;
    const intersection = [...left].filter(token => right.has(token)).length;
    return intersection / new Set([...left, ...right]).size;
  }

  private textSimilarity(a: string, b: string): number {
    return this.cosineSimilarity(a, b) * 0.7 + this.jaccardSimilarity(a, b) * 0.3;
  }

  private inferType(content: string): MemoryType {
    const lower = content.toLowerCase();
    if (/\b(prefer|like|love|hate|dislike|suka|gasuka|seneng|preferensi)\b/.test(lower)) return 'preference';
    if (/\b(project|repo|deploy|build|roadmap|phase|vercel|github)\b/.test(lower)) return 'project';
    if (/\b(todo|task|deadline|lanjut|kerjain|fix)\b/.test(lower)) return 'task';
    if (/\b(insight|conclusion|learned|pattern)\b/.test(lower)) return 'insight';
    return 'fact';
  }

  async autoTag(content: string): Promise<string[]> {
    const lower = content.toLowerCase();
    const tags = new Set<string>();
    const keywords = [
      'preference', 'project', 'memory', 'drive', 'google', 'vercel', 'github', 'agent', 'etla', 'zenos',
      'auth', 'security', 'roadmap', 'deploy', 'api', 'backup', 'runtime', 'hermes', 'telegram', 'whatsapp',
    ];
    for (const keyword of keywords) if (lower.includes(keyword)) tags.add(keyword);
    if (content.length > 120) tags.add('detailed');
    if (/\d+/.test(content)) tags.add('numeric');
    if (/\b(always|never|selalu|jangan|harus)\b/.test(lower)) tags.add('strong-signal');
    return [...tags];
  }

  private extractEntities(content: string): string[] {
    const titleCased = content.match(/\b[A-Z][a-zA-Z0-9_.-]{2,}\b/g) || [];
    const known = this.tokenize(content).filter(token => [
      'zenos', 'etla', 'vercel', 'github', 'drive', 'memory', 'hermes', 'telegram', 'whatsapp', 'codex',
    ].includes(token));
    return uniqueStrings([...titleCased, ...known], 24);
  }

  private extractFacts(content: string, namespace: string): RememberRequest[] {
    return content
      .split(/\n+|(?<=[.!?])\s+/)
      .map(piece => piece.trim())
      .filter(piece => piece.length > 12)
      .slice(0, 12)
      .map(piece => ({
        content: piece,
        namespace,
        type: this.inferType(piece),
        metadata: {
          confidence: /\b(always|never|must|harus|jangan|prefer|suka|hate|love)\b/i.test(piece) ? 0.88 : 0.72,
          importance: /\b(project|deploy|auth|security|prefer|suka|jangan)\b/i.test(piece) ? 8 : 5,
          tags: [],
          entities: this.extractEntities(piece),
        },
      }));
  }

  private findDuplicate(content: string, namespace: string, type: MemoryType): Memory | null {
    const exact = this.store.findByContentHash(namespace, contentHash(content), 5)
      .find(memory => memory.type === type);
    if (exact) return exact;

    const candidates = this.store.searchCandidates({ query: content, namespace, candidateLimit: 80, includeArchived: false });
    let best: { memory: Memory; similarity: number } | null = null;
    for (const memory of candidates) {
      if (memory.type !== type || SECRET_TYPES.has(memory.type)) continue;
      const similarity = this.textSimilarity(content, memory.content);
      if (similarity >= 0.9 && (!best || similarity > best.similarity)) best = { memory, similarity };
    }
    return best?.memory || null;
  }

  private normalizedMetadata(
    input: Partial<MemoryMetadata> | undefined,
    content: string,
    now: string,
    mutation?: ReturnType<typeof buildMutationPlan>,
  ): MemoryMetadata {
    const extras = metadataExtra(input);
    return MemoryMetadataSchema.parse({
      ...extras,
      confidence: input?.confidence ?? 0.8,
      importance: input?.importance ?? 5,
      status: input?.status ?? 'active',
      tags: uniqueStrings([
        ...(input?.tags || []),
        ...(mutation ? [mutation.reason] : []),
      ], 128),
      entities: uniqueStrings([...(input?.entities || []), ...this.extractEntities(content)], 128),
      related_ids: uniqueStrings([...(input?.related_ids || []), ...(mutation?.related_ids || [])], 256),
      supersedes_ids: uniqueStrings([...(input?.supersedes_ids || []), ...(mutation?.supersedes_ids || [])], 256),
      contradictions: uniqueStrings([...(input?.contradictions || []), ...(mutation?.contradictions || [])], 128),
      provenance: {
        ...(input?.provenance || {}),
        valid_from: input?.provenance?.valid_from || mutation?.valid_from,
      },
      timestamp: input?.timestamp || now,
      is_secret: false,
    });
  }

  private validateRememberInput(parsed: NormalizedRememberRequest): { namespace: string; type: MemoryType } {
    const namespace = normalizeNamespace(parsed.namespace);
    const type = parsed.type || this.inferType(parsed.content);
    // This must run before any embedding or semantic-expansion provider sees
    // the content. Persistence rejection after provider processing is too late.
    assertMemorySafe(parsed.content, type);
    return { namespace, type };
  }

  private async findIdempotentMemory(
    parsed: NormalizedRememberRequest,
    namespace: string,
  ): Promise<Memory | undefined> {
    if (!parsed.idempotency_key) return undefined;
    await this.ensureReady(namespace);
    const cached = this.store.getIdempotent<Memory>(parsed.idempotency_key, 'remember');
    if (cached) return MemorySchema.parse(cached);
    if (!this.cloudMode || !this.driveBackup) return undefined;
    const eventId = deterministicEventId(namespace, 'memory_created', parsed.idempotency_key);
    const priorEvent = await this.driveBackup.findCloudEvent(namespace, eventId);
    const priorMemory = priorEvent?.changes.find(change => change.operation === 'upsert');
    if (priorMemory?.operation !== 'upsert') return undefined;
    const current = this.store.get(priorMemory.memory.id, namespace, true) || priorMemory.memory;
    const memory = MemorySchema.parse(current);
    this.store.putIdempotent(parsed.idempotency_key, 'remember', memory);
    return memory;
  }

  async remember(request: RememberRequest): Promise<Memory> {
    const parsed = RememberRequestSchema.parse(request);
    const { namespace } = this.validateRememberInput(parsed);
    const idempotent = await this.findIdempotentMemory(parsed, namespace);
    if (idempotent) return idempotent;
    // External embedding latency must not consume the distributed write lease.
    // Idempotency/deduplication and safety are rechecked after lease acquisition.
    const preparedEmbedding = await getEmbedding(parsed.content);
    return this.withCloudWrite(
      namespace,
      'memory_created',
      () => this.rememberUnlocked(parsed, preparedEmbedding),
    );
  }

  private async rememberUnlocked(parsed: NormalizedRememberRequest, preparedEmbedding?: EmbeddingResult): Promise<Memory> {
    const namespace = normalizeNamespace(parsed.namespace);
    await this.ensureReady(namespace);
    const type = parsed.type || this.inferType(parsed.content);
    assertMemorySafe(parsed.content, type);

    if (parsed.idempotency_key) {
      const cached = this.store.getIdempotent<Memory>(parsed.idempotency_key, 'remember');
      if (cached) return MemorySchema.parse(cached);
      if (this.cloudMode && this.driveBackup) {
        const eventId = deterministicEventId(namespace, 'memory_created', parsed.idempotency_key);
        const priorEvent = await this.driveBackup.findCloudEvent(namespace, eventId);
        const priorMemory = priorEvent?.changes.find(change => change.operation === 'upsert');
        if (priorMemory?.operation === 'upsert') {
          const current = this.store.get(priorMemory.memory.id, namespace, true) || priorMemory.memory;
          const parsedMemory = MemorySchema.parse(current);
          this.store.putIdempotent(parsed.idempotency_key, 'remember', parsedMemory);
          return parsedMemory;
        }
      }
    }

    const now = new Date().toISOString();
    const procedureSignature = type === 'procedure'
      ? String(parsed.metadata?.procedure_signature || '').trim()
      : '';
    const continuityCheckpointIdentity = String(
      parsed.metadata?.continuity_packet_hash
      || parsed.metadata?.source_cursor
      || '',
    ).trim();
    const existing = procedureSignature
      ? this.store.list({ namespace, limit: 10_000, includeArchived: false })
          .find(memory => memory.type === 'procedure'
            && memory.metadata.status === 'active'
            && String(memory.metadata.procedure_signature || '') === procedureSignature) || null
      : continuityCheckpointIdentity
        ? null
        : this.findDuplicate(parsed.content, namespace, type);
    if (existing) {
      const mergedTags = uniqueStrings([
        ...(existing.metadata.tags || []),
        ...(parsed.metadata?.tags || []),
        ...(await this.autoTag(parsed.content)),
      ], 128);
      const incomingValidated = parsed.metadata?.deterministic_validation === 'passed';
      const isProcedureCandidate = type === 'procedure'
        && incomingValidated
        && mergedTags.includes('validated-procedure-candidate');
      const existingSessions = Array.isArray(existing.metadata.procedure_success_sessions)
        ? existing.metadata.procedure_success_sessions
        : [];
      const incomingSessions = Array.isArray(parsed.metadata?.procedure_success_sessions)
        ? parsed.metadata.procedure_success_sessions
        : [];
      const provenanceSession = parsed.metadata?.provenance?.session_id;
      const validatedSessions = uniqueStrings([
        ...existingSessions,
        ...(incomingValidated ? incomingSessions : []),
        ...(incomingValidated && provenanceSession ? [provenanceSession] : []),
      ], 128);
      const previousProcedureSuccesses = Math.max(
        Number(existing.metadata.procedure_success_count || 0),
        existingSessions.length,
      );
      const procedureSuccessCount = isProcedureCandidate
        ? Math.max(previousProcedureSuccesses, validatedSessions.length)
        : previousProcedureSuccesses;
      const procedurePromoted = (existing.metadata.procedure_promotion_status === 'promoted')
        || (isProcedureCandidate && procedureSuccessCount >= 3);
      const updated = await this.editUnlocked(existing.id, {
        content: parsed.content.length > existing.content.length ? parsed.content : existing.content,
        metadata: {
          ...existing.metadata,
          ...parsed.metadata,
          status: 'active',
          confidence: procedurePromoted
            ? Math.max(0.96, existing.metadata.confidence || 0.8, parsed.metadata?.confidence || 0.8)
            : Math.max(existing.metadata.confidence || 0.8, parsed.metadata?.confidence || 0.8),
          importance: procedurePromoted
            ? Math.max(10, existing.metadata.importance || 5, parsed.metadata?.importance || 5)
            : Math.max(existing.metadata.importance || 5, parsed.metadata?.importance || 5),
          tags: uniqueStrings([
            ...mergedTags,
            ...(procedurePromoted ? ['validated-procedure', 'procedure-promoted'] : []),
          ], 128),
          procedure_success_count: procedureSuccessCount || undefined,
          procedure_success_sessions: validatedSessions.length ? validatedSessions : undefined,
          deterministic_validation: procedurePromoted ? 'passed' : parsed.metadata?.deterministic_validation,
          procedure_promotion_status: procedurePromoted
            ? 'promoted'
            : isProcedureCandidate
              ? 'candidate'
              : existing.metadata.procedure_promotion_status,
        },
      }, namespace, existing.metadata.version, parsed.idempotency_key, 'memory_deduplicated', preparedEmbedding);
      if (!updated) throw new StorageError('Duplicate memory disappeared during update');
      if (parsed.idempotency_key) this.store.putIdempotent(parsed.idempotency_key, 'remember', updated);
      return updated;
    }

    const active = this.store.list({ namespace, limit: 5000, includeArchived: false });
    const invalidatesProcedureSignature = String(
      parsed.metadata?.invalidates_procedure_signature || '',
    ).trim();
    const invalidatedProcedureIds = invalidatesProcedureSignature
      ? active
          .filter(memory => memory.type === 'procedure'
            && memory.metadata.status === 'active'
            && String(memory.metadata.procedure_signature || '') === invalidatesProcedureSignature)
          .map(memory => memory.id)
      : [];
    const mutation = buildMutationPlan(parsed.content, active);
    const [autoTags, embedding] = await Promise.all([
      this.autoTag(parsed.content),
      preparedEmbedding ? Promise.resolve(preparedEmbedding) : getEmbedding(parsed.content),
    ]);
    const metadata = MemoryMetadataSchema.parse({
      ...this.normalizedMetadata({
        ...parsed.metadata,
        tags: [
          ...(parsed.metadata?.tags || []),
          ...autoTags,
          ...(invalidatedProcedureIds.length ? ['procedure-invalidated-by-failure'] : []),
        ],
        supersedes_ids: uniqueStrings([
          ...(parsed.metadata?.supersedes_ids || []),
          ...invalidatedProcedureIds,
        ], 256),
      }, parsed.content, now, mutation),
      ...embeddingMetadata(embedding),
    });
    const memoryId = deterministicMemoryId(namespace, type, contentHash(parsed.content));
    const memory = MemorySchema.parse({
      id: memoryId,
      type,
      content: parsed.content,
      namespace,
      metadata,
      embedding: embedding.vector,
      created_at: now,
      updated_at: now,
    });

    const changed: Memory[] = [];
    const stored = this.store.transaction(() => {
      const inserted = this.store.insert(memory);
      changed.push(inserted);
      for (const supersededId of inserted.metadata.supersedes_ids || []) {
        const superseded = this.store.get(supersededId, namespace);
        if (!superseded) continue;
        const updated = MemorySchema.parse({
          ...superseded,
          metadata: {
            ...superseded.metadata,
            status: 'superseded',
            version: (superseded.metadata.version || 1) + 1,
            provenance: {
              ...(superseded.metadata.provenance || {}),
              valid_to: now,
            },
          },
          updated_at: now,
        });
        const saved = this.store.update(updated, superseded.metadata.version || 1);
        changed.push(saved);
      }
      this.store.appendAudit({
        action: 'memory_created',
        namespace,
        memoryId: inserted.id,
        details: { type: inserted.type, tags: inserted.metadata.tags },
      });
      return inserted;
    });

    await this.persistCloudChanges({
      namespace,
      action: 'memory_created',
      idempotencyKey: parsed.idempotency_key,
      changes: changed.map(item => ({ operation: 'upsert' as const, memory: item })),
    });
    if (parsed.idempotency_key) this.store.putIdempotent(parsed.idempotency_key, 'remember', stored);
    return stored;
  }

  async rememberBatch(requests: RememberRequest[]): Promise<Memory[]> {
    if (!requests.length) return [];
    const maxBatch = this.cloudMode ? 100 : 250;
    if (requests.length > maxBatch) throw new ConflictError(`Batch exceeds ${maxBatch} memories`);
    const parsed = requests.map((request, index) => {
      const normalized = RememberRequestSchema.parse(request);
      const { namespace } = this.validateRememberInput(normalized);
      return { index, namespace, request: normalized };
    });
    const groups = new Map<string, typeof parsed>();
    for (const item of parsed) {
      const group = groups.get(item.namespace) || [];
      group.push(item);
      groups.set(item.namespace, group);
    }

    const results = new Array<Memory>(requests.length);
    for (const [namespace, group] of groups) {
      const pending: typeof group = [];
      for (const item of group) {
        const idempotent = await this.findIdempotentMemory(item.request, namespace);
        if (idempotent) results[item.index] = idempotent;
        else pending.push(item);
      }
      if (!pending.length) continue;

      const embeddings = await getEmbeddings(pending.map(item => item.request.content));
      await this.withCloudWrite(namespace, 'memory_batch_created', async () => {
        for (let groupIndex = 0; groupIndex < pending.length; groupIndex += 1) {
          const item = pending[groupIndex];
          results[item.index] = await this.rememberUnlocked(item.request, embeddings[groupIndex]);
        }
      }, { deferEvents: true });
    }
    return results;
  }

  async rememberFromConversation(
    conversation: Array<{ role: string; content: string }>,
    namespace = 'zenos',
    conversationId?: string,
  ): Promise<Memory[]> {
    const safeNamespace = normalizeNamespace(namespace);
    const candidates: RememberRequest[] = [];
    const seen = new Set<string>();
    const durableSignal = /\b(prefer|preference|suka|jangan|always|never|harus|must|decid|putus|pilih|pakai|project|repo|service|blocker|deadline|todo|pending|artifact|file|deploy|birthday|lahir|name is|nama|works? at|kerja|correction|koreksi|maksud)\b/i;
    for (const turn of conversation.filter(item => item.content && ['user', 'assistant'].includes(item.role))) {
      const redacted = redactSensitiveText(turn.content);
      for (const fact of this.extractFacts(redacted, safeNamespace)) {
        // Conversation import is a semantic-memory path, not a raw archive.
        // Assistant prose needs an explicit durable signal; user statements are
        // retained only when they look like identity, preference, decision, or
        // active project state.
        if (!durableSignal.test(fact.content)) continue;
        const key = fact.content.toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          ...fact,
          metadata: {
            ...fact.metadata,
            source: conversationId ? `conversation:${conversationId}` : 'conversation',
            provenance: { conversation_id: conversationId },
            importance: Math.max(fact.metadata?.importance || 5, turn.role === 'user' ? 8 : 6),
          },
        });
        if (candidates.length >= 80) break;
      }
      if (candidates.length >= 80) break;
    }
    return this.rememberBatch(candidates);
  }

  async recall(request: RecallRequest): Promise<Memory[]> {
    const scored = await this.recallWithQuality(request);
    return scored.map(memory => MemorySchema.parse(memory));
  }

  async recordRecallFeedback(raw: RecallFeedbackRequest): Promise<RecallFeedbackResult> {
    const request = RecallFeedbackRequestSchema.parse(raw);
    const namespace = normalizeNamespace(request.namespace);
    const operation = 'recall-feedback';
    const cached = this.store.getIdempotent<RecallFeedbackResult>(request.feedback_id, operation);
    if (cached) return { ...cached, deduplicated: true };

    if (this.cloudMode && this.driveBackup) {
      await this.ensureReady(namespace);
      const eventId = deterministicEventId(namespace, 'memory_feedback_recorded', request.feedback_id);
      const priorEvent = await this.driveBackup.findCloudEvent(namespace, eventId);
      if (priorEvent) {
        const updatedIds = priorEvent.changes
          .filter(change => change.operation === 'upsert')
          .map(change => change.operation === 'upsert' ? change.memory.id : '')
          .filter(Boolean);
        const result: RecallFeedbackResult = {
          feedback_id: request.feedback_id,
          namespace,
          outcome: request.outcome,
          requested: request.memory_ids.length,
          updated: updatedIds.length,
          missing: request.memory_ids.filter(id => !updatedIds.includes(id)),
          deduplicated: true,
          updated_at: priorEvent.occurred_at,
        };
        this.store.putIdempotent(request.feedback_id, operation, result);
        return result;
      }
    }

    const result = await this.withCloudWrite(namespace, 'memory_feedback_recorded', async () => {
      await this.ensureReady(namespace);
      const updatedAt = new Date().toISOString();
      const missing: string[] = [];
      const changed: Memory[] = [];
      this.store.transaction(() => {
        for (const id of request.memory_ids) {
          const current = this.store.get(id, namespace, true);
          if (!current || current.type === 'credential' || current.metadata.is_secret) {
            missing.push(id);
            continue;
          }
          const metadata = MemoryMetadataSchema.parse({
            ...current.metadata,
            version: (current.metadata.version || 1) + 1,
            recall_positive_count: Number(current.metadata.recall_positive_count || 0)
              + (request.outcome === 'helpful' ? 1 : 0),
            recall_negative_count: Number(current.metadata.recall_negative_count || 0)
              + (request.outcome === 'not_helpful' ? 1 : 0),
            recall_neutral_count: Number(current.metadata.recall_neutral_count || 0)
              + (request.outcome === 'unused' ? 1 : 0),
            recall_feedback_at: updatedAt,
          });
          const next = MemorySchema.parse({
            ...current,
            metadata,
            updated_at: updatedAt,
          });
          const stored = this.store.update(next, current.metadata.version || 1);
          changed.push(stored);
          this.store.appendAudit({
            action: 'memory_feedback_recorded',
            namespace,
            memoryId: stored.id,
            requestId: request.run_id,
            details: {
              feedback_id: request.feedback_id,
              outcome: request.outcome,
              source: request.source,
              session_id: request.session_id,
            },
          });
        }
      });
      if (changed.length) {
        await this.persistCloudChanges({
          namespace,
          action: 'memory_feedback_recorded',
          idempotencyKey: request.feedback_id,
          requestId: request.run_id,
          actor: request.source,
          changes: changed.map(memory => ({ operation: 'upsert' as const, memory })),
        });
      }
      return {
        feedback_id: request.feedback_id,
        namespace,
        outcome: request.outcome,
        requested: request.memory_ids.length,
        updated: changed.length,
        missing,
        deduplicated: false,
        updated_at: updatedAt,
      } satisfies RecallFeedbackResult;
    }, { deferEvents: true });

    this.store.putIdempotent(request.feedback_id, operation, result);
    return result;
  }

  async recallWithQuality(request: RecallRequest): Promise<ScoredMemory[]> {
    const parsed = InternalRecallRequestSchema.parse(request);
    const namespace = normalizeNamespace(parsed.namespace);
    await this.ensureReady(namespace);
    const query = parsed.query?.trim() || '';
    const limit = parsed.limit || 10;
    let memories = this.store.searchCandidates({
      query,
      namespace,
      type: parsed.type,
      candidateLimit: Math.min(2000, Math.max(150, limit * 20)),
      includeArchived: parsed.include_archived || false,
      createdAfter: parsed.created_after,
      createdBefore: parsed.created_before,
    });

    memories = memories.filter(memory => {
      if (memory.type === 'credential') return false;
      if (memory.type === 'secret_reference' && parsed.type !== 'secret_reference') return false;
      if ((memory.metadata.status || 'active') !== 'active' && !parsed.include_archived) return false;
      if (parsed.min_confidence !== undefined && memory.metadata.confidence < parsed.min_confidence) return false;
      if (parsed.tags?.length && !parsed.tags.some(tag => memory.metadata.tags.includes(tag))) return false;
      if (memory.metadata.expires_at && new Date(memory.metadata.expires_at).getTime() <= Date.now()) return false;
      return true;
    });

    const queryEmbedding = query ? await getEmbedding(query) : undefined;
    const ranked = rankHybrid(
      query,
      memories,
      limit,
      queryEmbedding ? { vector: queryEmbedding.vector, space: queryEmbedding.space } : undefined,
    )
      .map(item => ({
        ...item.memory,
        quality: this.computeQualityScore(item.memory),
        score: item.score,
        reason: item.reason,
        signals: item.signals,
      }))
      .filter(memory => parsed.include_low_quality || (memory.quality || 0) >= 0.25 || query === '');

    // Access counters are intentionally not mutated in cloud mode. Updating
    // only an instance-local cache would make snapshots depend on which warm
    // Vercel instance happened to serve the reads.
    if (!this.cloudMode) this.store.touch(ranked.map(memory => memory.id), namespace);
    return ranked;
  }

  private recencyScore(memory: Memory): number {
    const updated = new Date(memory.updated_at || memory.created_at).getTime();
    if (!Number.isFinite(updated)) return 0;
    const ageDays = Math.max(0, (Date.now() - updated) / 86_400_000);
    return Math.max(0, 1 - ageDays / 90);
  }

  computeQualityScore(memory: Memory): number {
    const confidence = memory.metadata.confidence || 0.5;
    const importance = (memory.metadata.importance || 5) / 10;
    const recency = this.recencyScore(memory);
    const provenance = memory.metadata.provenance?.source_id || memory.metadata.source ? 1 : 0;
    const tags = Math.min((memory.metadata.tags?.length || 0) / 5, 1);
    const relations = Math.min((memory.metadata.related_ids?.length || 0) / 3, 1);
    const access = Math.min(Math.log2((memory.metadata.access_count || 0) + 1) / 4, 1);
    const status = memory.metadata.status === 'active' ? 1 : memory.metadata.status === 'superseded' ? 0.35 : 0.15;
    const quality = confidence * 0.26
      + importance * 0.22
      + recency * 0.14
      + provenance * 0.12
      + tags * 0.1
      + relations * 0.06
      + access * 0.05
      + status * 0.05;
    return Math.max(0, Math.min(1, quality));
  }

  async detectConflicts(newMemory: Memory, namespace?: string): Promise<Memory[]> {
    const normalized = normalizeNamespace(namespace || newMemory.namespace);
    await this.ensureReady(normalized);
    const memories = this.store.searchCandidates({
      query: newMemory.content,
      namespace: normalized,
      candidateLimit: 150,
      includeArchived: false,
    });
    const lower = newMemory.content.toLowerCase();
    const negative = /\b(not|never|hate|dislike|jangan|gasuka|tidak|bukan)\b/.test(lower);
    const positive = /\b(like|love|prefer|always|suka|senang|mau|adalah)\b/.test(lower);
    return memories.filter(memory => {
      if (memory.id === newMemory.id) return false;
      if (this.textSimilarity(newMemory.content, memory.content) < 0.22) return false;
      const existing = memory.content.toLowerCase();
      const existingNegative = /\b(not|never|hate|dislike|jangan|gasuka|tidak|bukan)\b/.test(existing);
      const existingPositive = /\b(like|love|prefer|always|suka|senang|mau|adalah)\b/.test(existing);
      return (negative && existingPositive) || (positive && existingNegative);
    });
  }

  async edit(
    id: string,
    updates: MemoryUpdate,
    namespace?: string,
    expectedVersion?: number,
  ): Promise<Memory | null> {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    return this.withCloudWrite(normalized, 'memory_updated', () => this.editUnlocked(
      id,
      updates,
      normalized,
      expectedVersion,
      undefined,
      'memory_updated',
    ));
  }

  private async editUnlocked(
    id: string,
    updates: MemoryUpdate,
    namespace: string,
    expectedVersion?: number,
    idempotencyKey?: string,
    action = 'memory_updated',
    preparedEmbedding?: EmbeddingResult,
  ): Promise<Memory | null> {
    const normalized = normalizeNamespace(namespace);
    await this.ensureReady(normalized);
    const current = this.store.get(id, normalized);
    if (!current) return null;
    const nextType = updates.type || current.type;
    const nextContent = updates.content || current.content;
    assertMemorySafe(nextContent, nextType);
    const embedding = updates.embedding
      ? undefined
      : updates.content
        ? preparedEmbedding || await getEmbedding(nextContent)
        : undefined;
    const now = new Date().toISOString();
    const nextVersion = (current.metadata.version || 1) + 1;
    const metadata = MemoryMetadataSchema.parse({
      ...current.metadata,
      ...(updates.metadata || {}),
      ...(embedding ? embeddingMetadata(embedding) : {}),
      version: nextVersion,
      tags: uniqueStrings([
        ...(current.metadata.tags || []),
        ...((updates.metadata?.tags as string[] | undefined) || []),
      ], 128),
      entities: uniqueStrings([
        ...(current.metadata.entities || []),
        ...((updates.metadata?.entities as string[] | undefined) || []),
        ...this.extractEntities(nextContent),
      ], 128),
      is_secret: false,
    });
    const updated = MemorySchema.parse({
      ...current,
      ...updates,
      type: nextType,
      content: nextContent,
      namespace: normalizeNamespace(updates.namespace || current.namespace),
      metadata,
      embedding: updates.embedding || embedding?.vector || current.embedding,
      updated_at: now,
    });
    if (updated.namespace !== normalized && this.cloudMode) {
      throw new ConflictError('Moving a memory across cloud namespaces is not supported; create it in the target namespace instead');
    }
    const stored = this.store.update(updated, expectedVersion ?? current.metadata.version);
    this.store.appendAudit({
      action,
      namespace: stored.namespace,
      memoryId: stored.id,
      details: { version: stored.metadata.version, type: stored.type },
    });
    await this.persistCloudChanges({
      namespace: stored.namespace,
      action,
      idempotencyKey,
      changes: [{ operation: 'upsert', memory: stored }],
    });
    return stored;
  }

  async forget(id: string, namespace?: string, expectedVersion?: number, hardDelete = false): Promise<boolean> {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    return this.withCloudWrite(normalized, hardDelete ? 'memory_hard_deleted' : 'memory_archived', async () => {
      await this.ensureReady(normalized);
      const current = this.store.get(id, normalized, true);
      if (!current) return false;
      if (hardDelete) {
        if (process.env.ZENOS_MEMORY_ALLOW_HARD_DELETE !== 'true') {
          throw new ConflictError('Hard delete is disabled; use soft deletion or explicitly enable the maintenance override');
        }
        const removed = this.store.hardDelete(id, normalized);
        if (removed) {
          this.store.appendAudit({ action: 'memory_hard_deleted', namespace: normalized, memoryId: id });
          await this.persistCloudChanges({
            namespace: normalized,
            action: 'memory_hard_deleted',
            changes: [{ operation: 'hard_delete', memory_id: id }],
          });
        }
        return removed;
      }
      const archivedAt = new Date().toISOString();
      const version = expectedVersion ?? current.metadata.version;
      const removed = this.store.softDelete(id, normalized, version);
      if (removed) {
        this.store.appendAudit({ action: 'memory_archived', namespace: normalized, memoryId: id });
        await this.persistCloudChanges({
          namespace: normalized,
          action: 'memory_archived',
          changes: [{
            operation: 'archive',
            memory_id: id,
            expected_version: version,
            archived_at: archivedAt,
          }],
        });
      }
      return removed;
    });
  }

  async list(namespace?: string, limit = 20): Promise<Memory[]> {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    await this.ensureReady(normalized);
    return this.store.list({
      namespace: normalized,
      limit,
      includeArchived: false,
    }).filter(memory => !SECRET_TYPES.has(memory.type));
  }

  async getStats(namespace?: string) {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    await this.ensureReady(normalized);
    const memories = this.store.list({ namespace: normalized, limit: 10_000, includeArchived: true });
    const visible = memories.filter(memory => !SECRET_TYPES.has(memory.type));
    const byType: Record<string, number> = {};
    for (const memory of visible) byType[memory.type] = (byType[memory.type] || 0) + 1;
    const average = visible.length
      ? visible.reduce((sum, memory) => sum + this.computeQualityScore(memory), 0) / visible.length
      : 0;
    return {
      total: visible.length,
      archived: visible.filter(memory => memory.metadata.status !== 'active').length,
      byType,
      avgQuality: Number(average.toFixed(4)),
      namespace: normalized,
      storage: this.store.health(),
      drive_backup_configured: Boolean(this.driveBackup),
    };
  }

  async enhanceMemoryWithAutoTags(id: string, namespace?: string): Promise<Memory | null> {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    await this.ensureReady(normalized);
    const current = this.store.get(id, normalized);
    if (!current) return null;
    return this.edit(id, {
      metadata: {
        tags: uniqueStrings([...(current.metadata.tags || []), ...(await this.autoTag(current.content))], 128),
      },
    }, current.namespace, current.metadata.version);
  }

  async linkMemories(id1: string, id2: string, relation = 'related', namespace?: string): Promise<boolean> {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    return this.withCloudWrite(normalized, 'memories_linked', async () => {
      await this.ensureReady(normalized);
      const first = this.store.get(id1, normalized);
      const second = this.store.get(id2, normalized);
      if (!first || !second || first.namespace !== second.namespace) return false;
      const now = new Date().toISOString();
      const updatedFirst = MemorySchema.parse({
        ...first,
        metadata: {
          ...first.metadata,
          version: (first.metadata.version || 1) + 1,
          related_ids: uniqueStrings([...(first.metadata.related_ids || []), id2], 256),
          relationship_labels: {
            ...((first.metadata.relationship_labels as Record<string, string> | undefined) || {}),
            [id2]: relation,
          },
        },
        updated_at: now,
      });
      const updatedSecond = MemorySchema.parse({
        ...second,
        metadata: {
          ...second.metadata,
          version: (second.metadata.version || 1) + 1,
          related_ids: uniqueStrings([...(second.metadata.related_ids || []), id1], 256),
          relationship_labels: {
            ...((second.metadata.relationship_labels as Record<string, string> | undefined) || {}),
            [id1]: relation,
          },
        },
        updated_at: now,
      });
      this.store.transaction(() => {
        this.store.update(updatedFirst, first.metadata.version);
        this.store.update(updatedSecond, second.metadata.version);
        this.store.appendAudit({
          action: 'memories_linked',
          namespace: first.namespace,
          memoryId: first.id,
          details: { target: second.id, relation },
        });
      });
      await this.persistCloudChanges({
        namespace: normalized,
        action: 'memories_linked',
        changes: [
          { operation: 'upsert', memory: updatedFirst },
          { operation: 'upsert', memory: updatedSecond },
        ],
      });
      return true;
    });
  }

  async applyTemporalDecay(namespace?: string): Promise<number> {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    return this.withCloudWrite(normalized, 'temporal_decay_applied', async () => {
      await this.ensureReady(normalized);
      const memories = this.store.list({ namespace: normalized, limit: 10_000, includeArchived: false });
      const now = new Date().toISOString();
      const decayDay = now.slice(0, 10);
      const updates: Array<{ previousVersion: number; memory: Memory }> = [];

      for (const memory of memories) {
        if (SECRET_TYPES.has(memory.type)) continue;
        if (String(memory.metadata.last_decay_at || '').slice(0, 10) === decayDay) continue;
        const ageDays = Math.max(0, (Date.now() - new Date(memory.updated_at).getTime()) / 86_400_000);
        if (ageDays < 90 || memory.metadata.importance >= 9) continue;
        const confidence = Math.max(0.2, (memory.metadata.confidence || 0.8) * Math.max(0.7, 1 - ageDays / 1095));
        if (Math.abs(confidence - memory.metadata.confidence) < 0.01) continue;
        const previousVersion = memory.metadata.version || 1;
        updates.push({
          previousVersion,
          memory: MemorySchema.parse({
            ...memory,
            metadata: {
              ...memory.metadata,
              confidence,
              last_decay_at: now,
              version: previousVersion + 1,
            },
            updated_at: now,
          }),
        });
      }

      if (!updates.length) return 0;
      this.store.transaction(() => {
        for (const update of updates) this.store.update(update.memory, update.previousVersion);
        this.store.appendAudit({
          action: 'temporal_decay_applied',
          namespace: normalized,
          details: { updated: updates.length },
        });
      });
      await this.persistCloudChanges({
        namespace: normalized,
        action: 'temporal_decay_applied',
        changes: updates.map(update => ({ operation: 'upsert' as const, memory: update.memory })),
      });
      return updates.length;
    });
  }

  async runMaintenanceCycle(options: {
    namespace?: string;
    applyDecay?: boolean;
    backup?: boolean;
    prune?: boolean;
    includeReport?: boolean;
    reindexEmbeddings?: boolean;
  } = {}): Promise<MaintenanceCycleResult> {
    const normalized = normalizeNamespace(
      options.namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos',
    );
    return this.withCloudWrite(normalized, 'scheduled_maintenance', async () => {
      const maintenance = options.includeReport
        ? buildMaintenanceReport(this.store.list({
            namespace: normalized,
            limit: 10_000,
            includeArchived: true,
          }))
        : null;
      const decayed = options.applyDecay === false ? 0 : await this.applyTemporalDecay(normalized);
      const embeddings = options.reindexEmbeddings === false
        ? { updated: 0, space: 'skipped', degraded: 0 }
        : await this.reindexEmbeddings(normalized, 100);
      const backup = options.backup === false
        ? null
        : await this.backupMemories(normalized) as MaintenanceBackupResult;
      const [retention, health] = await Promise.all([
        options.prune === false
          ? Promise.resolve(null)
          : this.pruneCloudArtifacts(normalized) as Promise<Record<string, unknown>>,
        this.memoryHealthCheck(normalized) as Promise<MemoryHealthResult>,
      ]);
      return {
        namespace: normalized,
        decayed,
        embeddings,
        backup,
        retention,
        health,
        maintenance,
      };
    });
  }

  async reindexEmbeddings(namespace = 'zenos', limit = 100): Promise<{ updated: number; space: string; degraded: number }> {
    const normalized = normalizeNamespace(namespace);
    return this.withCloudWrite(normalized, 'memory_embeddings_reindexed', async () => {
      await this.ensureReady(normalized);
      const active = this.store.list({
        namespace: normalized,
        limit: 10_000,
        includeArchived: false,
      }).filter(memory => !SECRET_TYPES.has(memory.type)
        && memory.type !== 'conversation'
        && memory.metadata.status === 'active');
      if (!active.length) return { updated: 0, space: 'empty', degraded: 0 };
      const probe = await getEmbedding('zenos semantic vector space probe');
      const candidates = active
        .filter(memory => memory.metadata.embedding_space !== probe.space
          || memory.embedding?.length !== probe.dimensions)
        .slice(0, Math.max(1, Math.min(limit, 500)));
      if (!candidates.length) return { updated: 0, space: probe.space, degraded: 0 };
      const embeddings = await getEmbeddings(candidates.map(memory => memory.content));
      const now = new Date().toISOString();
      const updates = candidates.map((memory, index) => {
        const embedding = embeddings[index];
        return MemorySchema.parse({
          ...memory,
          metadata: {
            ...memory.metadata,
            ...embeddingMetadata(embedding),
            version: (memory.metadata.version || 1) + 1,
          },
          embedding: embedding.vector,
          updated_at: now,
        });
      });
      this.store.transaction(() => {
        for (let index = 0; index < updates.length; index += 1) {
          this.store.update(updates[index], candidates[index].metadata.version || 1);
        }
        this.store.appendAudit({
          action: 'memory_embeddings_reindexed',
          namespace: normalized,
          details: { updated: updates.length, space: embeddings[0]?.space, degraded: embeddings.filter(item => !item.ok).length },
        });
      });
      await this.persistCloudChanges({
        namespace: normalized,
        action: 'memory_embeddings_reindexed',
        changes: updates.map(memory => ({ operation: 'upsert' as const, memory })),
      });
      return {
        updated: updates.length,
        space: embeddings[0]?.space || probe.space,
        degraded: embeddings.filter(item => !item.ok).length,
      };
    });
  }

  async dailyIntelligenceReport(namespace = 'zenos') {
    const normalized = normalizeNamespace(namespace);
    const memories = await this.list(normalized, 10_000);
    if (!memories.length) return { summary: 'No memories', insights: [], health: { total: 0, avgQuality: 0 } };
    const byType: Record<string, number> = {};
    const tagCounts: Record<string, number> = {};
    const entityCounts: Record<string, number> = {};
    for (const memory of memories) {
      byType[memory.type] = (byType[memory.type] || 0) + 1;
      for (const tag of memory.metadata.tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      for (const entity of memory.metadata.entities || []) entityCounts[entity] = (entityCounts[entity] || 0) + 1;
    }
    const avgQuality = memories.reduce((sum, memory) => sum + this.computeQualityScore(memory), 0) / memories.length;
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag]) => tag);
    const topEntities = Object.entries(entityCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([entity]) => entity);
    const unhealthy = memories.filter(memory => this.computeQualityScore(memory) < 0.4).length;
    return {
      summary: `${memories.length} active memories in ${normalized}; average quality ${avgQuality.toFixed(2)}`,
      insights: [
        `Dominant type: ${Object.entries(byType).sort((a, b) => b[1] - a[1])[0]?.[0] || 'none'}`,
        ...(topTags.length ? [`Top tags: ${topTags.join(', ')}`] : []),
        ...(topEntities.length ? [`Top entities: ${topEntities.join(', ')}`] : []),
        unhealthy ? `${unhealthy} memories need review` : 'No low-quality memories require immediate review',
      ],
      health: { total: memories.length, avgQuality, unhealthy, byType, topTags, topEntities },
    };
  }

  async resolveConflict(id1: string, id2: string, namespace?: string) {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    await this.ensureReady(normalized);
    const first = this.store.get(id1, normalized);
    const second = this.store.get(id2, normalized);
    if (!first || !second) return { suggestion: 'not found' };
    const firstQuality = this.computeQualityScore(first);
    const secondQuality = this.computeQualityScore(second);
    const newer = new Date(first.updated_at) >= new Date(second.updated_at) ? first : second;
    const winner = Math.abs(firstQuality - secondQuality) > 0.08
      ? (firstQuality > secondQuality ? first : second)
      : newer;
    return {
      suggestion: `prefer ${winner.id}`,
      winner,
      scores: { [first.id]: firstQuality, [second.id]: secondQuality },
    };
  }

  async getRelationshipGraph(namespace = 'zenos') {
    const memories = await this.list(normalizeNamespace(namespace), 5000);
    const nodes = memories.map(memory => ({
      id: memory.id,
      label: memory.content.slice(0, 100),
      type: memory.type,
      quality: this.computeQualityScore(memory),
      tags: memory.metadata.tags,
      status: memory.metadata.status,
    }));
    const nodeIds = new Set(nodes.map(node => node.id));
    const edges: Array<{ from: string; to: string; type: string; weight: number }> = [];
    for (const memory of memories) {
      for (const target of memory.metadata.related_ids || []) {
        if (nodeIds.has(target)) edges.push({ from: memory.id, to: target, type: 'explicit', weight: 1 });
      }
      for (const target of memory.metadata.supersedes_ids || []) {
        if (nodeIds.has(target)) edges.push({ from: memory.id, to: target, type: 'supersedes', weight: 1.5 });
      }
    }
    return { nodes, edges, totalConnections: edges.length };
  }

  async getDeeperRelationshipGraph(namespace = 'zenos') {
    return this.getRelationshipGraph(namespace);
  }

  async generateInsights(namespace = 'zenos') {
    const memories = await this.list(normalizeNamespace(namespace), 10_000);
    const report = await this.dailyIntelligenceReport(namespace);
    const highQuality = memories.filter(memory => this.computeQualityScore(memory) >= 0.75).length;
    const stale = memories.filter(memory => Date.now() - new Date(memory.updated_at).getTime() > 90 * 86_400_000).length;
    return {
      insights: [...report.insights, `${highQuality} high-quality memories`, `${stale} stale memories`],
      memoryCount: memories.length,
    };
  }

  async memoryHealthCheck(namespace = 'zenos', options: { refresh?: boolean } = {}) {
    const normalized = normalizeNamespace(namespace);
    if (options.refresh !== false || !this.cloudMode || !this.namespaceState.has(normalized)) {
      await this.ensureReady(normalized);
    }
    const memories = this.store.list({ namespace: normalized, limit: 10_000, includeArchived: true })
      .filter(memory => !SECRET_TYPES.has(memory.type));
    const items = memories
      .map(memory => ({
        id: memory.id,
        quality: this.computeQualityScore(memory),
        content: memory.content.slice(0, 120),
        updated_at: memory.updated_at,
        status: memory.metadata.status,
      }))
      .filter(memory => memory.quality < 0.4);
    const storage = this.store.health();
    return {
      ok: storage.ok && items.length <= Math.max(5, memories.length * 0.25),
      total: memories.length,
      unhealthy: items.length,
      items: items.slice(0, 100),
      storage,
      recommendations: items.length
        ? ['Review, merge, or archive low-quality memories']
        : ['No urgent memory quality issues'],
    };
  }

  async createAgent(agentId: string, name: string, config: Record<string, unknown> = {}) {
    return this.remember({
      content: name,
      type: 'custom',
      namespace: 'agents',
      metadata: {
        ...config,
        agent_id: agentId,
        source: 'agent-registry',
        tags: ['agent'],
        importance: 7,
      },
    });
  }

  async listAgents() {
    await this.ensureReady('agents');
    const agents = this.store.list({ namespace: 'agents', limit: 1000, includeArchived: false });
    return agents.map(memory => ({
      agentId: String(memory.metadata.agent_id || memory.id),
      name: memory.content,
      config: memory.metadata,
    }));
  }

  async indexFile(content: string, filename: string, namespace = 'zenos', agentId?: string) {
    assertMemorySafe(content, 'file');
    const safeNamespace = normalizeNamespace(namespace);
    const requests = buildKnowledgeMemories(content, filename, safeNamespace, agentId);
    const memories = await this.rememberBatch(requests);
    return {
      indexed: memories.filter(memory => memory.type === 'file').length,
      relationship_indexes: memories.filter(memory => memory.type === 'relationship').length,
      entity_indexes: memories.filter(memory => memory.type === 'insight' && memory.metadata.tags.includes('entity-index')).length,
      filename,
      namespace: safeNamespace,
      mode: 'knowledge-graph-ingestion',
    };
  }

  async exportMemories(namespace: string | null = null, format = 'json') {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    await this.ensureReady(normalized);
    const memories = this.store.list({
      namespace: normalized,
      limit: 10_000,
      includeArchived: true,
    }).filter(memory => !SECRET_TYPES.has(memory.type));
    if (format === 'csv') {
      const rows = ['id,type,namespace,status,content,created_at,updated_at'];
      for (const memory of memories) {
        const values = [
          memory.id,
          memory.type,
          memory.namespace,
          memory.metadata.status,
          memory.content,
          memory.created_at,
          memory.updated_at,
        ].map(value => `"${String(value).replace(/"/g, '""')}"`);
        rows.push(values.join(','));
      }
      return { format, count: memories.length, data: rows.join('\n') };
    }
    return { format: 'json', count: memories.length, data: memories };
  }

  async backupMemories(namespace?: string) {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    if (this.cloudMode && this.driveBackup) {
      return this.withCloudWrite(normalized, 'cloud_snapshot_created', async () => {
        if (this.writeContext.getStore()?.namespace !== normalized) {
          await this.refreshCloudNamespace(normalized, true);
        }
        const stateInfo = this.namespaceState.get(normalized);
        const state: MaterializedCloudState = {
          namespace: normalized,
          memories: this.store.list({ namespace: normalized, limit: 10_000, includeArchived: true }),
          cursor: stateInfo?.cursor || null,
          event_count: stateInfo?.eventCount || 0,
          snapshot_id: null,
          revision: stateInfo?.revision || createHash('sha256').update(normalized).digest('hex'),
        };
        const portable = this.store.exportSnapshot(normalized);
        const [cloudSnapshot, backup] = await Promise.all([
          this.driveBackup!.createCloudSnapshot(state),
          this.driveBackup!.createSnapshot(portable),
        ]);
        if (!cloudSnapshot.verified) throw new StorageError('Cloud snapshot checksum verification failed');
        const backupVerified = await this.driveBackup!.verifySnapshot(backup.file_id, portable.checksum);
        if (!backupVerified) throw new StorageError('Portable Drive backup checksum verification failed');
        this.store.appendAudit({
          action: 'cloud_snapshot_created',
          namespace: normalized,
          details: {
            destination: 'google-drive',
            count: state.memories.length,
            snapshot_id: cloudSnapshot.snapshot.snapshot_id,
            through_cursor: state.cursor,
          },
        });
        return {
          destination: 'google-drive-cloud',
          verified: true,
          count: state.memories.length,
          snapshot_id: cloudSnapshot.snapshot.snapshot_id,
          snapshot_file_id: cloudSnapshot.snapshot_file_id,
          search_index_file_id: cloudSnapshot.search_index_file_id,
          graph_index_file_id: cloudSnapshot.graph_index_file_id,
          portable_backup_file_id: backup.file_id,
          portable_backup_manifest_id: backup.manifest_id,
        };
      });
    }

    await this.ensureReady(normalized);
    this.store.checkpoint();
    const snapshot = this.store.exportSnapshot(normalized);
    if (this.driveBackup) {
      const uploaded = await this.driveBackup.createSnapshot(snapshot);
      const verified = await this.driveBackup.verifySnapshot(uploaded.file_id, snapshot.checksum);
      if (!verified) throw new StorageError('Drive backup checksum verification failed');
      this.store.appendAudit({
        action: 'backup_created',
        namespace: normalized,
        details: { destination: 'google-drive', count: snapshot.memories.length, checksum: snapshot.checksum },
      });
      return { destination: 'google-drive', verified, count: snapshot.memories.length, ...uploaded };
    }

    const backupDir = path.resolve(process.env.ZENOS_MEMORY_BACKUP_DIR || path.join(path.dirname(this.store.health().path), 'backups'));
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const stamp = snapshot.generated_at.replace(/[:.]/g, '-');
    const target = path.join(backupDir, `zenos-memory-${normalized}-${stamp}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await rename(temporary, target);
    this.store.appendAudit({
      action: 'backup_created',
      namespace: normalized,
      details: { destination: 'local', count: snapshot.memories.length, checksum: snapshot.checksum },
    });
    return { destination: 'local', verified: true, count: snapshot.memories.length, path: target, checksum: snapshot.checksum };
  }

  async pruneCloudArtifacts(namespace = process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos') {
    const normalized = normalizeNamespace(namespace);
    if (!this.cloudMode || !this.driveBackup) {
      return {
        skipped: true,
        reason: 'Drive event mode is not active',
      };
    }
    return this.withCloudWrite(normalized, 'cloud_artifacts_pruned', () => {
      return this.driveBackup!.pruneCloudArtifacts(normalized, {
        snapshotRetention: Number(process.env.ZENOS_MEMORY_SNAPSHOT_RETENTION || 14),
        backupDayRetention: Number(process.env.ZENOS_MEMORY_BACKUP_DAY_RETENTION || 14),
        testNamespaceRetentionHours: Number(process.env.ZENOS_MEMORY_TEST_NAMESPACE_RETENTION_HOURS || 24),
      });
    });
  }

  async restoreSnapshot(
    input: unknown,
    options: { mode?: 'merge' | 'replace'; namespace?: string } = {},
  ) {
    const snapshot = MemorySnapshotSchema.parse(input);
    const checksum = createHash('sha256').update(JSON.stringify(snapshot.memories)).digest('hex');
    if (checksum !== snapshot.checksum) {
      throw new ValidationError('Snapshot checksum does not match its memory payload');
    }
    const targetNamespace = options.namespace ? normalizeNamespace(options.namespace) : null;
    const memories = snapshot.memories.map(memory => MemorySchema.parse({
      ...memory,
      namespace: targetNamespace || memory.namespace,
    }));
    const groups = new Map<string, Memory[]>();
    for (const memory of memories) {
      const group = groups.get(memory.namespace) || [];
      group.push(memory);
      groups.set(memory.namespace, group);
    }
    if (this.cloudMode && groups.size > 1) {
      throw new ValidationError('Cloud restore must target one namespace at a time');
    }

    const mode = options.mode || 'merge';
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const [namespace, group] of groups) {
      await this.withCloudWrite(namespace, 'snapshot_restored', async () => {
        await this.ensureReady(namespace);
        const changes: CloudMemoryChange[] = [];
        this.store.transaction(() => {
          if (mode === 'replace') {
            this.store.replaceNamespace(namespace, group);
            inserted += group.length;
            changes.push({ operation: 'replace_namespace', memories: group });
          } else {
            for (const incoming of group) {
              const current = this.store.get(incoming.id, namespace, true);
              if (!current) {
                this.store.insert(incoming);
                changes.push({ operation: 'upsert', memory: incoming });
                inserted += 1;
                continue;
              }
              if (incoming.updated_at <= current.updated_at) {
                skipped += 1;
                continue;
              }
              const merged = MemorySchema.parse({
                ...incoming,
                metadata: {
                  ...incoming.metadata,
                  version: (current.metadata.version || 1) + 1,
                },
              });
              this.store.update(merged, current.metadata.version || 1);
              changes.push({ operation: 'upsert', memory: merged });
              updated += 1;
            }
          }
          this.store.appendAudit({
            action: 'snapshot_restored',
            namespace,
            details: {
              mode,
              checksum: snapshot.checksum,
              generated_at: snapshot.generated_at,
              imported: group.length,
            },
          });
        });
        await this.persistCloudChanges({
          namespace,
          action: 'snapshot_restored',
          idempotencyKey: `${snapshot.checksum}:${mode}:${namespace}`,
          changes,
        });
      });
    }
    return {
      mode,
      checksum: snapshot.checksum,
      inserted,
      updated,
      skipped,
      total: memories.length,
    };
  }

  async logAudit(action: string, details: Record<string, unknown>, namespace = 'zenos') {
    this.store.appendAudit({ action, details, namespace: normalizeNamespace(namespace) });
    return { success: true };
  }

  async getAuditTrail(namespace = 'zenos', limit = 20) {
    const normalized = normalizeNamespace(namespace);
    await this.ensureReady(normalized);
    if (this.cloudMode && this.driveBackup) return this.driveBackup.listCloudAudit(normalized, limit);
    return this.store.listAudit(normalized, limit);
  }

  async acquireLease(resource: string, owner: string, namespace = 'zenos', ttlMs = 30_000) {
    const normalized = normalizeNamespace(namespace);
    await this.ensureReady(normalized);
    if (this.cloudMode && this.driveBackup) {
      return this.driveBackup.acquireCloudLease(normalized, resource, owner, ttlMs, Math.min(ttlMs, 15_000));
    }
    const lease = this.store.acquireLease(resource, normalized, owner, ttlMs);
    this.store.appendAudit({
      action: lease ? 'lease_acquired' : 'lease_contended',
      namespace: normalized,
      details: { resource, owner, ttl_ms: ttlMs },
    });
    return lease;
  }

  async renewLease(
    token: string,
    owner: string,
    ttlMs = 30_000,
    namespace = 'zenos',
    resource = 'generic',
  ) {
    const normalized = normalizeNamespace(namespace);
    await this.ensureReady(normalized);
    if (this.cloudMode && this.driveBackup) {
      return this.driveBackup.renewCloudLeaseByIdentity(normalized, resource, token, owner, ttlMs);
    }
    const lease = this.store.renewLease(token, owner, ttlMs);
    if (lease) {
      this.store.appendAudit({
        action: 'lease_renewed',
        namespace: lease.namespace,
        details: { resource: lease.resource, owner, ttl_ms: ttlMs },
      });
    }
    return lease;
  }

  async releaseLease(token: string, owner: string, namespace = 'zenos', resource = 'generic') {
    const normalized = normalizeNamespace(namespace);
    await this.ensureReady(normalized);
    if (this.cloudMode && this.driveBackup) {
      return this.driveBackup.releaseCloudLeaseByIdentity(normalized, resource, token, owner);
    }
    const released = this.store.releaseLease(token, owner);
    if (released) this.store.appendAudit({ action: 'lease_released', details: { owner } });
    return released;
  }

  async listLeases(namespace?: string) {
    const normalized = normalizeNamespace(namespace || process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos');
    await this.ensureReady(normalized);
    if (this.cloudMode && this.driveBackup) return this.driveBackup.listCloudLeases(normalized);
    return this.store.listLeases(normalized);
  }

  async revision(namespace = process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos', force = false) {
    const normalized = normalizeNamespace(namespace);
    await this.ensureReady(normalized, force);
    const cloud = this.namespaceState.get(normalized);
    if (cloud?.revision) return cloud.revision;
    const latest = this.store.list({ namespace: normalized, limit: 1, includeArchived: true, includeDeleted: true })[0];
    return createHash('sha256').update(JSON.stringify({
      namespace: normalized,
      count: this.store.count(normalized, true),
      latestId: latest?.id || null,
      latestUpdatedAt: latest?.updated_at || null,
      latestStatus: latest?.metadata.status || null,
    })).digest('hex');
  }

  async resourcePolicyStatus(options: { includeRemote?: boolean } = {}) {
    const limits = resourceLimits();
    const signingKids = (() => {
      const raw = process.env.ZENOS_MEMORY_SIGNING_KEYS || '';
      if (!raw.trim()) return process.env.ZENOS_MEMORY_SECRET || process.env.ETLA_MASTER_SECRET ? ['legacy'] : [];
      try {
        return Object.keys(JSON.parse(raw) as Record<string, unknown>).filter((kid) => /^[a-zA-Z0-9._:-]{1,64}$/.test(kid));
      } catch {
        return raw.split(',').map((entry) => entry.split(':', 1)[0].trim()).filter(Boolean);
      }
    })();
    const includeRemote = options.includeRemote === true;
    const drive = includeRemote && this.cloudMode && this.driveBackup
      ? await Promise.all([
          this.driveBackup.resourceUsage().catch(() => null),
          this.driveBackup.driveStorageQuota().catch(() => null),
        ])
      : [null, null];
    return {
      operation_mode: memoryOperationMode(),
      degradation_mode: limits.degradationMode,
      event_pack_mode: (process.env.ZENOS_MEMORY_EVENT_PACK_MODE || 'shadow').trim().toLowerCase(),
      limits: {
        max_daily_drive_writes: limits.maxDailyDriveWrites,
        max_daily_llm_tokens: limits.maxDailyLlmTokens,
        max_storage_bytes: limits.maxStorageBytes,
        min_free_storage_bytes: limits.minFreeStorageBytes,
      },
      usage: drive[0],
      drive_storage: drive[1],
      remote_probe: includeRemote ? 'requested' : 'deferred_to_resource_policy_endpoint',
      signing: {
        active_kid: process.env.ZENOS_MEMORY_ACTIVE_KID || (signingKids.includes('legacy') ? 'legacy' : signingKids[0] || null),
        accepted_kids: signingKids,
        rotation_enabled: signingKids.length > 1,
        runtime_secret_separated: Boolean(process.env.ZENOS_MEMORY_SIGNING_KEYS || process.env.ZENOS_MEMORY_SECRET),
      },
    };
  }

  async readiness(namespace = process.env.ZENOS_MEMORY_DEFAULT_NAMESPACE || 'zenos') {
    const normalized = normalizeNamespace(namespace);
    // A cold instance verifies and materializes Drive synchronously once. Warm
    // readiness probes serve the last verified materialization immediately and
    // refresh it in the background. This keeps monitoring from turning every
    // probe into a 10+ second Drive event scan while normal reads/writes retain
    // their existing freshness and lease guarantees.
    if (!this.namespaceState.has(normalized)) {
      await this.ensureReady(normalized, true);
    } else {
      const state = this.namespaceState.get(normalized)!;
      const refreshStartedAt = this.readinessRefreshStartedAt.get(normalized) || 0;
      if (
        Date.now() - state.loadedAt >= this.readinessRefreshMs
        && Date.now() - refreshStartedAt >= this.readinessRefreshMs
        && !this.namespaceRefreshes.has(normalized)
      ) {
        this.readinessRefreshStartedAt.set(normalized, Date.now());
        void this.refreshCloudNamespace(normalized, true).catch(() => undefined);
      }
    }
    const storage = this.store.health();
    const cloud = this.namespaceState.get(normalized);
    const driveHealthy = this.cloudMode ? Boolean(this.driveBackup && cloud) : true;
    return {
      ready: storage.ok && driveHealthy,
      architecture: this.cloudMode ? 'vercel-compute-drive-event-store' : 'local-sqlite',
      canonical_store: this.cloudMode ? 'google-drive-append-only-events' : 'sqlite-wal',
      storage,
      cache: {
        ...storage,
        durable: !this.cloudMode,
        role: this.cloudMode ? 'ephemeral-materialized-view' : 'primary-store',
      },
      cloud: this.cloudMode ? {
        configured: Boolean(this.driveBackup),
        namespace: normalized,
        cursor: cloud?.cursor || null,
        event_count: cloud?.eventCount || 0,
        revision: cloud?.revision || null,
        last_verified_at: cloud ? new Date(cloud.loadedAt).toISOString() : null,
        last_verified_age_ms: cloud ? Math.max(0, Date.now() - cloud.loadedAt) : null,
        refresh_in_progress: this.namespaceRefreshes.has(normalized),
        readiness_strategy: 'cached-stale-while-revalidate',
        coordination: 'google-drive-conditional-lease',
        snapshots: 'immutable-checksum-verified',
      } : null,
      backup: {
        configured: Boolean(this.driveBackup),
        required: this.cloudMode || process.env.ZENOS_MEMORY_REQUIRE_DRIVE_BACKUP === 'true',
        healthy: driveHealthy,
      },
      policy: {
        operation_mode: memoryOperationMode(),
        degradation_mode: resourceLimits().degradationMode,
        event_pack_mode: (process.env.ZENOS_MEMORY_EVENT_PACK_MODE || 'shadow').trim().toLowerCase(),
      },
      security: {
        fail_closed: Boolean(process.env.ZENOS_MEMORY_SIGNING_KEYS || process.env.ETLA_MASTER_SECRET || process.env.ZENOS_MEMORY_SECRET || process.env.ZENOS_MEMORY_API_KEY),
        legacy_hmac_enabled: process.env.ZENOS_MEMORY_ALLOW_LEGACY_HMAC === 'true',
        static_api_key_enabled: process.env.ZENOS_MEMORY_ALLOW_STATIC_API_KEY === 'true',
        raw_secret_storage: false,
      },
    };
  }
}

let engine: MemoryEngine | null = null;

export function getMemoryEngine(): MemoryEngine {
  if (!engine) engine = new MemoryEngine();
  return engine;
}

export function resetMemoryEngineForTests(): void {
  engine = null;
  resetSqliteStoreForTests();
}
