# Zenos Memory Operations

## Production topology

```text
Hermes on VPS -> https://zenos-memory.vercel.app -> Google Drive
```

The VPS should not run `zenos-memory.service` in normal production. The Vercel deployment handles compute and Google Drive stores canonical data.

## Health checks

Public liveness:

```bash
curl -fsS https://zenos-memory.vercel.app/api/health
```

Public capability metadata:

```bash
curl -fsS https://zenos-memory.vercel.app/api/memory/public-status
```

Authenticated readiness is available at `/api/memory/health-check` through the SDK or Hermes provider.

## Release procedure

1. Run the full local gate.
2. Run the real Google Drive cloud smoke test.
3. Confirm legacy data migration and snapshot verification.
4. Commit and push `master`.
5. Wait for the GitHub-linked Vercel production deployment.
6. Run production smoke against the Vercel URL.
7. Point Hermes back to the Vercel URL.
8. Stop and disable the VPS fallback service.

Commands:

```bash
npm run check
npm run smoke:cloud
npm run smoke:concurrency
npm run migrate:legacy-vercel -- zenos
git push origin master
ZENOS_MEMORY_URL=https://zenos-memory.vercel.app npm run smoke:prod
```

## Daily maintenance

Vercel Cron calls:

```text
/api/memory/scheduler
```

The route defaults to namespace `zenos`, backup enabled, retention enabled, and report storage disabled. `CRON_SECRET` authenticates the request.

The job:

- acquires a Drive-backed maintenance lease;
- refreshes the namespace event stream;
- applies temporal decay where required;
- creates an immutable canonical snapshot;
- creates search and graph indexes;
- creates or reuses a content-addressed portable checksum-verified backup;
- prunes old snapshots, indexes, portable-backup day folders, and expired smoke-test namespaces according to retention settings;
- applies temporal decay at most once per memory per UTC day;
- runs memory health checks.

## Recovery

Canonical recovery requires no VPS disk.

1. Find the highest-cursor valid snapshot.
2. Verify its checksum.
3. List event month folders at or after the snapshot cursor month.
4. Validate and sort delta events by cursor.
5. Replay events into an empty materialized view.
6. Skip corrupt snapshots, but fail closed and alert on an invalid delta event instead of silently losing a mutation.

The application performs these steps automatically on a cold function instance.

## Manual snapshot

Using the authenticated client:

```bash
npm run cli -- backup zenos
```

Or call:

```text
POST /api/memory/backup
{"namespace":"zenos"}
```

## Migration tools

Legacy Vercel export to Drive events:

```bash
npm run migrate:legacy-vercel -- zenos
```

Drive event initialization or compaction:

```bash
npm run migrate:drive-events -- zenos
```

These commands print counts and identifiers only. They do not print memory contents or credentials.

## Hermes cutover

The Hermes profile file should contain:

```json
{
  "base_url": "https://zenos-memory.vercel.app",
  "namespace": "zenos"
}
```

The secret remains in the private profile configuration. Restart `hermes-gateway.service` after changing the URL.

## Failure modes

### Drive OAuth failure

Symptoms: readiness failure, token refresh errors, event append failure.

Actions:

- verify OAuth client ID, client secret, refresh token, and Drive folder setting in Vercel;
- refresh or re-authorize OAuth;
- do not switch to an ephemeral filesystem as canonical storage.

### Partial batch upload

Completed immutable events remain durable. The warm cache is rebuilt from Drive before another read is served, local idempotency entries are cleared, and retrying the same batch converges through deterministic event IDs.

### Lease contention

Symptoms: HTTP 409 or write timeout.

Actions:

- allow the active lease to expire;
- inspect the namespace coordination file;
- verify Vercel functions are not exceeding their duration and the write lease remains longer than the function timeout;
- avoid manually editing coordination files while writes are active.

### Invalid snapshot

The loader skips it automatically. Create a new snapshot from the previous verified snapshot plus delta events.

### Vercel outage

Canonical data remains in Drive. Hermes memory calls may temporarily fail, but no memory data is lost. A local fallback can be started manually only during an extended outage.

## Cost and VPS footprint

Normal VPS footprint is limited to the Hermes client and short HTTP calls. Zenos Memory has no always-on Node process, SQLite database, maintenance timer, or graph compute on the VPS.
