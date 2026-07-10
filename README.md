# Zenos Memory

Zenos Memory is a serverless, user-owned context continuity layer for AI agents.

Production compute runs in Vercel Functions. Canonical data remains in the owner's Google Drive as immutable, checksummed events and snapshots. The VPS only runs Hermes and a thin client plugin; it does not need to host the memory API or database.

## Architecture

```text
Hermes / SDK / API client
          |
          | scoped bearer token
          v
Vercel Functions
  - validation and secret rejection
  - extraction and compaction
  - hybrid retrieval and graph projection
  - lifecycle and conflict logic
  - snapshot/index maintenance
          |
          | Google Drive API
          v
Google Drive (canonical, user-owned)
  zenos-memory-cloud/
    namespaces/<namespace>/
      events/YYYY-MM/*.json
      snapshots/*.json
      indexes/*.search.json
      indexes/*.graph.json
      coordination/*.json
```

A warm function instance materializes the latest verified snapshot plus delta events into an ephemeral SQLite FTS5 cache. The cache is disposable. Cold starts reconstruct the same state from Drive.

## Consistency model

- Writes are serialized per namespace with a Google Drive compare-and-swap lease.
- Reads on a warm instance wait for the active namespace write to commit or roll back.
- Failed or partially uploaded batches are re-materialized from durable Drive events before the cache is served again.
- Memory IDs are deterministic for identical namespace/type/content combinations.
- Idempotency keys produce deterministic event IDs, including document-ingestion chunks.
- Events are immutable, checksummed, cursor ordered, replayable, and uploaded concurrently in bounded batches.
- Snapshots and portable backups are content-addressed, immutable, and reused on duplicate cron delivery.
- Snapshot, index, and portable-backup retention is bounded while canonical event history remains append-only.
- Invalid snapshots are ignored; older verified snapshots remain available.
- Lifecycle state is explicit: `active`, `superseded`, or `archived`.

## Security model

- Production fails closed when authentication is not configured.
- HMAC v2 token exchange binds timestamp, nonce, method, path, and request body hash.
- Tokens are short lived and scoped: `memory:read`, `memory:write`, `memory:admin`.
- Raw credentials, tokens, passwords, cookies, and private keys are rejected.
- Memory may store only external references such as `vault://`, `secret://`, or `op://`.
- Public endpoints expose capability metadata and liveness only.

## Main endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/auth` | Exchange an anti-replay HMAC signature for a scoped token |
| `POST /api/memory/remember` | Append a durable memory mutation |
| `POST /api/memory/recall` | Retrieve current memories |
| `POST /api/memory/hybrid-recall` | Hybrid lexical/vector/graph/lifecycle retrieval |
| `POST /api/memory/compact` | Create a redacted structured handoff |
| `POST /api/memory/bootstrap` | Build a bounded recovery context |
| `GET /api/memory/graph` | Project evidence-backed relationships |
| `POST /api/memory/backup` | Write verified snapshot, search index, graph index, and portable backup |
| `POST /api/memory/restore` | Verify and restore a snapshot |
| `POST /api/memory/lock` | Acquire, renew, or release a Drive-backed lease |
| `GET /api/memory/health-check` | Authenticated readiness and dependency evidence |

## Environment

Required for cloud production:

```bash
ETLA_MASTER_SECRET=...
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REFRESH_TOKEN=...
GOOGLE_DRIVE_FOLDER_NAME=Zenos Memory
ZENOS_MEMORY_STORAGE_MODE=drive-events
CRON_SECRET=...
```

Optional LLM and embedding providers:

```bash
MEMORY_LLM_BASE_URL=https://router.example.com/v1
MEMORY_LLM_API_KEY=...
MEMORY_LLM_MODEL=provider/model
MEMORY_LLM_FALLBACK_MODEL=provider/fallback
MEMORY_EMBEDDING_MODEL=embedding-model
```

See `.env.example` for the complete list.

## Local development

```bash
npm ci
npm run dev
```

Local development defaults to SQLite. To test the real cloud path using configured Google OAuth credentials:

```bash
npm run smoke:cloud
npm run smoke:concurrency
```

## Quality gates

```bash
npm run typecheck
npm run lint
npm test
npm run test:smoke
npm run build
npm audit
```

The cloud integration gates verify real Drive CAS locking and handoff, cross-instance concurrent writes, global retry idempotency, bounded parallel event flushing, content-addressed snapshot/backup reuse, cold-start recovery, and archive replay.

## Migration

Export and migrate the legacy Vercel/Drive deployment before replacing it:

```bash
npm run migrate:legacy-vercel -- zenos
```

Initialize or compact a Drive event namespace:

```bash
npm run migrate:drive-events -- zenos
```

Legacy raw credential records are converted to archived vault references. Raw secret values are not copied into the new event store.

## Deployment

The repository is linked to Vercel. `vercel.json` configures:

- Vercel Functions in Singapore;
- Drive event mode;
- a daily cron snapshot/index job;
- strict build, test, and lint gates;
- serverless duration limits.

The production URL is:

```text
https://zenos-memory.vercel.app
```

## Hermes integration

The provider in `plugins/zenos-memory` performs token exchange, recall prefetch, turn synchronization, compact-before-compression, and bootstrap recovery. It never auto-stores credential-like turns.

Installation and configuration are documented in `docs/HERMES_PLUGIN.md`.

## Product boundary

Zenos Memory owns durable context, retrieval, lifecycle, compaction, and recovery. It does not own multi-agent execution, coding orchestration, or secret management. Those remain separate systems.
