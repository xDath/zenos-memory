# Zenos Memory Operations Guide

This is the quick future-self guide for running Zenos Memory.

## Normal Usage

Do not open or edit this repo for daily memory usage. Use Hermes/Zenos normally.

Hermes consumes production API:

```text
https://zenos-memory.vercel.app
```

Profile config:

```text
/root/.hermes/profiles/zenos/config.yaml
memory.provider = zenos-memory
```

Plugin:

```text
/root/.hermes/profiles/zenos/plugins/zenos-memory/__init__.py
```

## Where Memory Lives

Memory data lives in Google Drive through OAuth, not in this repo.

Main runtime:

```text
Vercel API -> Google Drive OAuth -> zenos-memory structured folder
```

## Where Secrets Live

Never commit secrets.

Local helper secrets:

```text
/root/.zenos-secrets/vercel-token.txt
/root/.zenos-secrets/google-oauth-refresh-token.txt
```

Hermes client secret:

```text
/root/.hermes/profiles/zenos/zenos-memory.json
```

Production secrets:

```text
Vercel Project Settings -> Environment Variables
```

## Deploy

```bash
cd /root/openclaw-projects/zenos-memory
npm run build
npx vercel --prod --token $(cat /root/.zenos-secrets/vercel-token.txt) --yes
```

## Push to GitHub

```bash
cd /root/openclaw-projects/zenos-memory
git status
git add <safe-files-only>
git commit -m "message"
git push origin master
```

Before pushing:

```bash
git grep -nE 'sk-|vcp_|ghp_|GOCSPX-|private_key|BEGIN PRIVATE KEY' || true
```

## Smoke Test

Public:

```bash
curl -s https://zenos-memory.vercel.app/api/memory/public-status
curl -I https://zenos-memory.vercel.app/dashboard
```

Protected tests require Etla HMAC signature. Use Hermes tools when possible:

```text
zenos_memory_dashboard
zenos_memory_benchmark
zenos_memory_bootstrap
zenos_memory_search
```

## Key Endpoints

```text
/dashboard                         public product dashboard
/api/memory/public-status          public safe status
/api/memory/compact                LLM structured handoff
/api/memory/bootstrap              recovery context
/api/memory/vector                 vector retrieval
/api/memory/graph                  temporal graph
/api/memory/graph-query            graph + vector retrieval
/api/memory/graph-mermaid          Mermaid graph text
/api/memory/maintain               background maintainer
/api/memory/scheduler              cron maintenance
/api/memory/benchmark              regression benchmark
/api/memory/lock                   persistent lock audit
/api/memory/merge                  dedup/merge planner
```

## If Something Breaks

1. Check Vercel deployment: `npx vercel ls zenos-memory --token $(cat /root/.zenos-secrets/vercel-token.txt)`
2. Check public status endpoint.
3. Check Vercel envs.
4. Check Google OAuth access / folder permissions.
5. Run `npm run build` locally.
6. Check Hermes plugin config.

## Should We Delete This Repo?

No.

Keep it as infrastructure source code. Daily work should consume the deployed service, not rebuild it.

If disk cleanup is needed, remove generated folders only:

```text
.next/
.vercel/output/
node_modules/   # only if you are okay reinstalling
```

Do not remove:

```text
app/
scripts/
README.md
CREDENTIALS.md
OPERATIONS.md
/root/.zenos-secrets/
```

## Final State

This project is done-final as production infrastructure. Future changes should be:

- bug fix
- small endpoint upgrade
- UI polish
- model/embedding provider change
- operational secret rotation

Not a full rebuild.
