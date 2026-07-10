# Zenos Memory Roadmap

## North star

Provide intelligent, persistent context without turning the VPS into a database server.

```text
VPS/Hermes = thin client
Vercel = scale-to-zero compute
Google Drive = canonical user-owned event history
```

## Completed: Cloud-native v2

- Append-only immutable Drive event store.
- Per-namespace compare-and-swap write leases.
- Deterministic memory IDs and idempotent event IDs.
- Verified snapshots selected by event cursor.
- Portable search and graph indexes.
- Cold-start materialization into disposable SQLite FTS5 cache.
- Active, superseded, and archived lifecycle.
- HMAC v2 token exchange with nonce and body binding.
- Raw-secret rejection and vault-reference-only policy.
- Legacy Vercel export migration with secret redaction.
- Vercel Cron compaction, indexing, backup, and health checks.
- JavaScript, Python, CLI, and Hermes clients.
- Unit, security, replay, restore, and real Drive integration gates.

## Current operating target

- Production URL: `https://zenos-memory.vercel.app`
- Production namespace: `zenos`
- Canonical storage: Google Drive event files and snapshots.
- VPS memory service: disabled after cloud cutover.

## Next improvements

### Retrieval quality

- Optional neural embeddings written into portable index artifacts.
- Learned reranking based on accepted/rejected recall outcomes.
- Query decomposition for multi-topic recovery requests.
- Evaluation against external long-context datasets.

### Storage efficiency

- Snapshot retention policy and pruning of obsolete index artifacts.
- Event pack files for old, fully snapshotted periods.
- Incremental index generation from event deltas.
- Drive quota and latency telemetry.

### Observability

- OpenTelemetry-compatible request traces.
- Redacted latency and failure metrics.
- Snapshot age, event lag, and lease-contention alerts.
- Deployment health summary without exposing memory content.

### Portability

- One-command export/import bundle.
- Optional S3-compatible event-store adapter.
- Optional Postgres adapter for higher-concurrency deployments.
- Stable storage interface for third-party adapters.

## Explicit non-goals

Zenos Memory will not become:

- a password manager;
- a multi-agent execution runtime;
- a general-purpose file synchronization service;
- an unbounded analytics warehouse;
- a replacement for Zenos Runtime or 9Router.

The product stays focused on memory lifecycle, retrieval, compaction, and recovery.
