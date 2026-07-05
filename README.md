# Zenos Memory

**Zenos Memory** is an elite, cloud-owned agent memory operating system for Hermes/Zenos.

It provides long-term memory, structured context compaction, bootstrap recovery, credential-aware storage, vector retrieval, temporal graph reasoning, background maintenance, and production-safe APIs backed by Google Drive OAuth.

- **Production:** https://zenos-memory.vercel.app
- **Dashboard:** https://zenos-memory.vercel.app
- **Public Status:** https://zenos-memory.vercel.app/api/memory/public-status
- **Runtime:** Next.js on Vercel
- **Storage:** Google Drive OAuth, owned by the user
- **Auth:** Etla HMAC for protected endpoints
- **LLM Enhancer:** OpenAI-compatible router (`MEMORY_LLM_*`) with deterministic fallback

## Highlights

- Google Drive OAuth structured storage
- Etla HMAC protected API surface
- Hermes provider integration
- LLM-powered structured handoff, not plain summaries
- Auto compact + bootstrap recovery
- Credential-aware memory with secret filtering
- Deterministic vector retrieval and neural-ready embedding endpoint
- Temporal graph with weighted nodes and edges
- Graph query and Mermaid visualization
- Background maintainer and daily scheduler
- Persistent lock lease audit
- Elite benchmark endpoint
- Public product dashboard with no sensitive data exposure

## Architecture

```text
Hermes / Zenos
  -> Zenos Memory Provider
  -> Etla HMAC signed HTTPS
  -> Vercel Zenos Memory API
  -> LLM enhancer (optional)
  -> Google Drive OAuth structured storage
```

Drive layout:

```text
zenos-memory/
  namespaces/
    zenos/
      memories.json
      entities.json
      relationships.json
      profile.json
      audit.json
      compactions.json
      indexes.json
      tasks.json
      decisions.json
      artifacts.json
      evals.json
```

## Public Endpoints

These endpoints are intentionally safe to expose:

```text
GET /                              Product dashboard
GET /dashboard                     Dashboard alias
GET /api/memory/public-status      Public service status
```

## Protected Runtime Endpoints

Protected endpoints require Etla HMAC headers:

```text
POST /api/memory/remember
POST /api/memory/recall
POST /api/memory/compact
POST /api/memory/bootstrap
POST /api/memory/vector
POST /api/memory/embed
GET  /api/memory/graph
POST /api/memory/graph-query
GET  /api/memory/graph-mermaid
POST /api/memory/maintain
POST /api/memory/benchmark
GET  /api/memory/dashboard
POST /api/memory/scheduler
POST /api/memory/lock
POST /api/memory/merge
```

## Environment Variables

Use Vercel Environment Variables for production. Do not commit real values.

```bash
ETLA_MASTER_SECRET=change_me
ZENOS_MEMORY_API_KEY=change_me

GOOGLE_OAUTH_CLIENT_ID=your_client_id
GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret
GOOGLE_OAUTH_REFRESH_TOKEN=your_refresh_token
ZENOS_MEMORY_DRIVE_FOLDER_ID=root_or_folder_id
ZENOS_MEMORY_DRIVE_STRUCTURED=true

MEMORY_LLM_BASE_URL=https://router.example.com/v1
MEMORY_LLM_API_KEY=your_router_key
MEMORY_LLM_MODEL=provider/model-name
MEMORY_LLM_FALLBACK_MODEL=provider/fallback-model
MEMORY_EMBEDDING_MODEL=text-embedding-3-small

CRON_SECRET=change_me
USE_LOCAL_STORE=false
```

A sanitized template is available in `.env.example`.

## Local Development

```bash
npm install
cp .env.example .env.local
npm run dev
```

The local server runs on the configured Next.js port.

## Deploy

```bash
npm run build
npx vercel --prod --yes
```

If using a saved Vercel token locally:

```bash
npx vercel --prod --token "$VERCEL_TOKEN" --yes
```

## Hermes Integration

Hermes should consume Zenos Memory as a remote provider rather than modifying this repository during normal use.

Hermes profile config:

```yaml
memory:
  provider: zenos-memory
```

Provider plugin path:

```text
~/.hermes/profiles/zenos/plugins/zenos-memory/__init__.py
```

Provider config example:

```json
{
  "base_url": "https://zenos-memory.vercel.app",
  "secret": "<ETLA_MASTER_SECRET>",
  "namespace": "zenos",
  "prefetch_limit": 5
}
```

## Hermes Tools

The provider can expose tools such as:

```text
zenos_memory_remember
zenos_memory_search
zenos_memory_report
zenos_memory_compact
zenos_memory_bootstrap
zenos_memory_store_credential
zenos_memory_get_credential
zenos_memory_maintain
zenos_memory_graph_query
zenos_memory_dashboard
zenos_memory_benchmark
zenos_memory_merge
zenos_memory_mermaid
```

## Security Model

- No production secrets are stored in this repository.
- Public dashboard and public status expose only safe metadata.
- Protected runtime endpoints require Etla HMAC signing.
- Credential memories are filtered from normal recall.
- Secret retrieval requires explicit credential tooling.
- Google Drive data is owned by the OAuth account, not by a third-party database.

## Operational Guide

See [`OPERATIONS.md`](./OPERATIONS.md) for deployment, troubleshooting, maintenance, and future-self instructions.

See [`CREDENTIALS.md`](./CREDENTIALS.md) for secret management policy and environment setup.

See [`SECURITY.md`](./SECURITY.md) for public repository security expectations.

## Project Status

This project is considered **done-final** as production infrastructure.

Recommended future work:

- Optional real neural embedding provider setup
- Graph visualization UI improvements
- Larger benchmark datasets
- More strict Drive lock leases
- Additional provider SDKs

Built for Zenos / Hermes.
