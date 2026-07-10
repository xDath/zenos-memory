# Zenos Memory Security

## Trust boundaries

Zenos Memory separates four trust zones:

1. Hermes, SDKs, and API clients.
2. Vercel Functions as the stateless compute plane.
3. Google Drive as the canonical user-owned data plane.
4. External LLM, embedding, and secret-vault providers.

The VPS is not a memory database. Compromise or restart of the VPS must not destroy canonical Zenos Memory data.

## Authentication

Production APIs use a two-step protocol:

1. The client signs `timestamp`, `nonce`, HTTP method, canonical path, and SHA-256 request-body hash with `ETLA_MASTER_SECRET`.
2. `/api/auth` returns a short-lived bearer token containing explicit scopes.

Replay protection is enforced with timestamp windows and nonce tracking. Production does not fall back to unauthenticated access.

Supported scopes:

- `memory:read`
- `memory:write`
- `memory:admin`

## Secret policy

Zenos Memory is not a password manager.

Rejected content includes recognizable API keys, bearer tokens, passwords, refresh tokens, private keys, cookies, JWTs, and assigned-secret patterns. The legacy `credential` memory type is rejected for new writes.

Permitted secret records are references only:

```text
vault://...
secret://...
op://...
```

Legacy credentials migrated from the previous deployment are converted to archived, redacted `secret_reference` records. Raw values are not copied.

## Drive storage integrity

Canonical writes use immutable event files. Each event includes a checksum over its canonical payload. Snapshots also contain a checksum over the complete normalized memory state.

A snapshot is accepted only after:

- schema validation;
- checksum validation;
- namespace validation;
- cursor ordering validation.

Corrupt snapshots are skipped rather than replacing verified history.

## Concurrency

Write operations acquire a per-namespace Drive coordination lease. Lease updates use conditional HTTP writes with `If-Match`, providing compare-and-swap behavior. Only the holder can append a namespace mutation during the lease window.

Deterministic memory and event identifiers provide an additional convergence layer for retries and duplicate serverless invocations.

## Data minimization

Public endpoints expose only liveness and capability metadata. Authenticated health endpoints may expose counts, revisions, and storage status, but never memory contents or OAuth credentials.

Application logs must not contain:

- request authorization headers;
- HMAC secrets;
- OAuth refresh tokens;
- memory contents;
- raw LLM prompts containing private context.

## Dependency and build policy

A release requires:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

Moderate or higher production dependency vulnerabilities block release unless there is a documented, reviewed exception.

## Incident response

1. Rotate `ETLA_MASTER_SECRET` and affected OAuth credentials.
2. Disable the Vercel deployment or revoke the Google refresh token if active compromise is suspected.
3. Preserve immutable Drive events and snapshots for analysis.
4. Restore from the latest verified snapshot plus subsequent validated events.
5. Review cloud audit events and Vercel function logs.

Security reports should include the affected endpoint, expected behavior, reproduction steps, and whether any private memory content was exposed.
