# Security Policy

Zenos Memory is designed to be safe as a public portfolio repository while keeping runtime data and credentials private.

## Public Repository Policy

This repository must not contain production secrets, API keys, OAuth refresh tokens, service account JSON, private keys, or deployment tokens.

Safe files may include:

- source code
- sanitized templates
- documentation
- endpoint descriptions
- architecture diagrams
- placeholder environment variables

Unsafe files must remain untracked:

- `.env*`
- `.vercel/`
- `.next/`
- `node_modules/`
- private key files
- local token files

## Runtime Secrets

Production secrets must live in Vercel Environment Variables.

Local helper secrets must live outside the repository, for example:

```text
/root/.zenos-secrets/vercel-token.txt
/root/.zenos-secrets/google-oauth-refresh-token.txt
```

## Protected APIs

Operational memory endpoints require Etla HMAC signatures. Public endpoints expose only safe service metadata.

Public endpoints:

```text
GET /
GET /dashboard
GET /api/memory/public-status
```

Protected endpoints require signed headers:

```text
x-etla-timestamp
x-etla-signature
```

## Credential Memory

Credentials can be stored as first-class memory objects with `type=credential`, but they are filtered from normal recall by default.

Credential retrieval must be explicit via provider tooling or `include_secrets=true` on protected server-side calls.

## Before Making The Repository Public

Run:

```bash
git grep -nE 'sk-|vcp_|ghp_|GOCSPX-|private_key|BEGIN PRIVATE KEY|shirinka' || true
```

Expected result: no real secrets. Placeholder values are acceptable if clearly redacted.

Also check ignored files:

```bash
git status --ignored --short
```

## Reporting Issues

If a real secret is found in Git history:

1. Rotate the secret immediately.
2. Remove it from Vercel/GitHub/local storage.
3. Rewrite Git history if necessary.
4. Force push only after confirming the new history is clean.

## Security Scope

This repository does not grant access to:

- VPS instances
- Google Drive contents
- Vercel deployments
- Hermes profile secrets
- LLM router credentials

Access depends on external secrets that must never be committed.
