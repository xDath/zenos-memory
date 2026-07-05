# Zenos Memory

**Status:** Production-ready / Done Final  
**Production:** https://zenos-memory.vercel.app  
**Dashboard:** https://zenos-memory.vercel.app  
**Repo:** `xDath/zenos-memory`  
**Owner:** Zenos / Hermes profile `zenos`

Zenos Memory is a cloud-owned agent memory operating system for Hermes/Zenos.
It stores long-term agent memory in Google Drive via OAuth, uses Etla HMAC for protected APIs, and provides LLM-powered structured compaction, bootstrap recovery, vector retrieval, temporal graph, credential memory, maintenance, benchmarks, and scheduler automation.

## Should We Delete The Files?

**No. Do not delete this repo/project.**

Now that it is production-ready, we should treat this folder as the **source-of-truth codebase** and mostly act as a **consumer** from Hermes.

Recommended mode:

- Keep `/root/openclaw-projects/zenos-memory` as the maintenance repo.
- Do not edit daily unless upgrading/fixing.
- Hermes/Zenos should use it as a remote memory service via `https://zenos-memory.vercel.app`.
- Do not delete `.zenos-secrets`; they hold deploy/OAuth helpers.
- Do not commit secrets.

Think of it like:

```text
Repo/local files = engine source code + maintenance
Vercel = runtime API
Google Drive = memory data
Hermes plugin = consumer/client
```

## Runtime Architecture

```text
Hermes / Zenos profile
  -> zenos-memory provider plugin
  -> Etla HMAC signed HTTPS
  -> Vercel Zenos Memory API
  -> LLM enhancer via router.etla.me
  -> Google Drive OAuth structured storage
```

## Storage

Primary storage is **Google Drive OAuth** using the user's Google account quota.

Drive structure:

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

Legacy service account support exists only as fallback. The main production path is OAuth.

## Core Features

- Google Drive OAuth cloud-owned memory
- Etla HMAC protected APIs
- Hermes default provider integration
- LLM structured handoff / auto compact
- Bootstrap recovery after context reset
- Credential-aware memory (`type=credential`)
- Deterministic vector retrieval + neural-ready embedding endpoint
- Temporal graph with weighted nodes/edges
- Graph query + Mermaid graph visualization
- Background maintainer
- Daily scheduler cron
- Persistent lock lease audit
- Elite benchmark/regression endpoint
- Public safe dashboard/status

## Important URLs

Public/safe:

```text
GET /
GET /dashboard
GET /api/memory/public-status
```

Protected runtime APIs (require Etla signature):

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

## Hermes Consumer Setup

Hermes profile config:

```yaml
memory:
  provider: zenos-memory
```

Plugin path:

```text
/root/.hermes/profiles/zenos/plugins/zenos-memory/__init__.py
```

Plugin config:

```text
/root/.hermes/profiles/zenos/zenos-memory.json
```

Expected fields:

```json
{
  "base_url": "https://zenos-memory.vercel.app",
  "secret": "<ETLA_MASTER_SECRET>",
  "namespace": "zenos",
  "prefetch_limit": 5
}
```

## Hermes Tools

The provider exposes tools such as:

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

Auto behavior:

- Auto bootstrap on provider initialize
- Auto compact every 20 turns
- Auto credential detection for obvious API keys/tokens

## Credentials / Secrets

See `CREDENTIALS.md` for details.

Current secret locations:

```text
/root/.zenos-secrets/vercel-token.txt
/root/.zenos-secrets/google-oauth-refresh-token.txt
/root/.zenos-secrets/zenos-memory-sa.json   # legacy fallback only
```

Vercel envs contain encrypted runtime secrets:

```text
ETLA_MASTER_SECRET
ZENOS_MEMORY_API_KEY
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
ZENOS_MEMORY_DRIVE_FOLDER_ID
ZENOS_MEMORY_DRIVE_STRUCTURED
MEMORY_LLM_BASE_URL
MEMORY_LLM_API_KEY
MEMORY_LLM_MODEL
MEMORY_LLM_FALLBACK_MODEL
CRON_SECRET
```

**Never commit actual secret values.**

## Deployment

Use the saved token:

```bash
cd /root/openclaw-projects/zenos-memory
npx vercel --prod --token $(cat /root/.zenos-secrets/vercel-token.txt) --yes
```

GitHub push:

```bash
git status
git add <files>
git commit -m "message"
git push origin master
```

Vercel is connected to GitHub, but CLI deploy is also available.

## Smoke Test Commands

Generate Etla signature helper in Node/Python or use Hermes provider.

Basic public test:

```bash
curl -s https://zenos-memory.vercel.app/api/memory/public-status
curl -I https://zenos-memory.vercel.app
```

Protected smoke tests require `x-etla-timestamp` and `x-etla-signature`.
Recommended protected endpoints to test:

```text
/api/memory/profile?namespace=zenos
/api/memory/bootstrap
/api/memory/benchmark
/api/memory/dashboard
/api/memory/vector
/api/memory/graph
```

## Operational Guidance

Day-to-day usage:

- Do not work in this repo unless upgrading.
- Use Hermes as consumer.
- Let auto-compact and scheduler maintain memory.
- Store new credentials through `zenos_memory_store_credential` or normal conversation if obvious token patterns are present.

When something breaks:

1. Check Vercel deployment status.
2. Check Vercel envs.
3. Check Google OAuth folder permissions.
4. Run `/api/memory/public-status`.
5. Run protected `/api/memory/benchmark`.
6. Check `/root/.hermes/profiles/zenos/zenos-memory.json` secret/base URL.

## Production Checklist

- [x] GitHub private repo clean of credentials
- [x] Vercel production deployed
- [x] Google Drive OAuth storage working
- [x] Etla HMAC auth working
- [x] Hermes provider default
- [x] Auto compact + bootstrap
- [x] Credential memory support
- [x] Vector + graph + benchmark + dashboard
- [x] Daily scheduler cron

## Final Note

Zenos Memory is now complete enough to treat as infrastructure.
From here, Hermes should primarily consume it rather than rebuilding it every session.
Future work should be small upgrades, bug fixes, or UI enhancements — not another rebuild.

Built for Zenos by Etla.
