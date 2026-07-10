# Zenos Memory 2.0 Production Readiness

## Production contract

Zenos Memory 2.0 is production-ready for its intended scope: a personal, serverless memory service with Vercel compute and Google Drive-owned canonical data.

It is not positioned as a multi-tenant database, distributed vector database, secret vault, or agent execution framework.

## Verified architecture

- Compute: Vercel Functions.
- Canonical store: append-only Google Drive event files.
- Coordination: per-namespace Drive compare-and-swap leases.
- Warm cache: disposable SQLite WAL + FTS5 in the function filesystem.
- Recovery: highest-cursor verified snapshot plus validated delta events.
- Maintenance: Vercel Cron snapshot, index, backup, and health run.
- VPS: thin Hermes client only.

## Release gates

The following gates must be green:

- strict TypeScript check;
- ESLint with zero warnings;
- unit, security, lifecycle, event replay, and snapshot tests;
- local engine smoke;
- real Google Drive cloud smoke;
- Next.js production build;
- zero known npm vulnerabilities;
- production Vercel smoke after deployment.

## Cloud integration evidence

`npm run smoke:cloud` performs real Google Drive operations and verifies:

- CAS lease acquisition and release;
- append-only event creation;
- deterministic duplicate convergence;
- update event replay;
- immutable snapshot verification;
- search index creation;
- graph index creation;
- deletion of the local cache followed by cold-start reconstruction;
- archive event recovery after a second cold start.

## Migrated data

The legacy Vercel deployment is exported before replacement. Valid memories are written to a verified cloud snapshot. Legacy secret records become archived vault references and raw secret values are not copied.

## Consistency guarantees

- A namespace has one active writer lease at a time.
- Writes are replayable and deterministic.
- Event and snapshot checksums detect mutation or partial upload.
- Snapshot selection uses event cursor order.
- Invalid snapshots do not replace verified history.
- Identical memory writes converge to one deterministic memory ID.

## Operational guarantees

- A VPS restart does not affect canonical memory data.
- A Vercel cold start rebuilds state from Drive.
- A corrupt newest snapshot falls back to older verified state and delta events.
- The public UI and status endpoint contain no private memory.
- Raw credentials are rejected at ingestion and before LLM processing.

## Known scope limits

- Google Drive API latency is higher than a dedicated database.
- This design is optimized for personal and low-to-moderate write concurrency.
- Search indexes are portable artifacts; active retrieval still materializes the current state in the function cache.
- External LLM quality depends on the configured provider and is not part of storage correctness.

These limits are intentional tradeoffs for zero-idle-compute, personal ownership, portability, and a minimal VPS footprint.
