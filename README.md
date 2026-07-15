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

## Retrieval intelligence

Zenos Memory 2.5 uses a retrieval pipeline that keeps storage correctness independent from model availability:

1. provider-backed dense embeddings are generated during writes and stored with an explicit model-and-dimension vector-space identifier;
2. queries are embedded in the same vector space, and vectors from different models or dimensions are never compared;
3. BM25-style sparse relevance, dense similarity, graph proximity, lifecycle state, recency, confidence, and importance are fused with reciprocal-rank fusion;
4. when no dense provider is available, an optional LLM semantic-expansion stage creates language-neutral concepts and paraphrases inside one stable, model-independent semantic hash space;
5. semantic expansion can retry a configured fallback model within one total latency budget, while all-provider failure is explicitly marked degraded instead of silently reported as healthy;
6. provider outages still fall back to a deterministic multilingual character/token embedding without blocking durable writes or recall;
7. batches use one embedding or semantic-expansion request instead of one request per memory.

This is a real dense+sparse+graph retrieval path, not a detached embedding demo. The deterministic benchmark remains a contract regression; live quality must additionally be measured with longitudinal datasets and human feedback.

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
| `POST /api/memory/compact` | Create a redacted, coverage-checked structured handoff from a separately bounded source transcript |
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

The route-contract suite additionally invokes real Next.js Route Handlers and verifies scoped authentication, malformed JSON, validation status codes, raw-secret rejection, bounded compact/bootstrap schemas, no-store headers, and stable `429` rate-limit responses.

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

## Context continuity contract

Compaction accepts a large but explicitly bounded source transcript (`input_max_chars`, up to 500,000 characters) while keeping the durable handoff independently bounded (`max_chars`, up to 24,000 characters). Long inputs are scanned across the whole transcript: stable evidence anchors preserve the durable goal plus high-signal decisions, tasks, failures, constraints, questions, and artifacts from the middle as well as the head and recent tail.

The response reports source-message and category coverage alongside the active goal, decisions, pending work, open questions, and files/artifacts. Deterministic extraction fills missing LLM fields, session/conversation-scoped compacts supersede only their own prior handoffs, and the raw transcript remains outside Memory as the canonical evidence source.

Runtime recall is compiled into a task-specific Cognitive Brief rather than a flat search dump. Records are grouped into current project state, active tasks, prior decisions, procedures, failures, preferences, and facts, with explicit source/confidence metadata and an instruction-injection boundary.

## Hermes integration

The provider in `plugins/zenos-memory` performs token exchange, recall prefetch, turn synchronization, compact-before-compression, and bootstrap recovery. Etla Runtime can additionally request a durable handoff when the Hermes Host working set crosses its absolute token limit. It never auto-stores credential-like turns.

Installation and configuration are documented in `docs/HERMES_PLUGIN.md`.

## Product boundary

Zenos Memory owns durable context, retrieval, lifecycle, compaction, and recovery. It does not own multi-agent execution, coding orchestration, or secret management. Those remain separate systems.
