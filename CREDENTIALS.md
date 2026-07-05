# Credentials and Secrets Management

Do not commit production secrets to Git.

This repository is safe to make public only when all real secrets stay in Vercel Environment Variables or local secret files outside the repo.

## Credential Types

### 1. Vercel Deploy Token

Purpose: deploy from local machine to Vercel.

Location:

```text
/root/.zenos-secrets/vercel-token.txt
```

This token is not required at runtime and must not be committed.

### 2. Google Drive OAuth

Purpose: access user-owned Google Drive storage.

Environment variables:

```text
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
ZENOS_MEMORY_DRIVE_FOLDER_ID
ZENOS_MEMORY_DRIVE_STRUCTURED=true
```

Local refresh token helper location:

```text
/root/.zenos-secrets/google-oauth-refresh-token.txt
```

Generate a refresh token:

```bash
GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node scripts/get-google-oauth-token.mjs
```

### 3. LLM Enhancer

Purpose: structured compaction, extraction, and reasoning.

Environment variables:

```text
MEMORY_LLM_BASE_URL=https://router.example.com/v1
MEMORY_LLM_API_KEY=<router-api-key>
MEMORY_LLM_MODEL=<provider/model>
MEMORY_LLM_FALLBACK_MODEL=<provider/model>
MEMORY_EMBEDDING_MODEL=<embedding-model>
```

Never hardcode the API key.

### 4. Etla Signing Secret

Purpose: sign requests from Hermes/Zenos to protected Zenos Memory APIs.

Environment variable:

```text
ETLA_MASTER_SECRET=<strong-secret>
```

Hermes provider config may also contain this value locally:

```text
~/.hermes/profiles/zenos/zenos-memory.json
```

Example shape only:

```json
{
  "base_url": "https://zenos-memory.vercel.app",
  "secret": "<ETLA_MASTER_SECRET>",
  "namespace": "zenos"
}
```

### 5. Zenos Memory API Key

Purpose: legacy/internal API key path.

Environment variable:

```text
ZENOS_MEMORY_API_KEY=<strong-secret>
```

### 6. Legacy Service Account

The old service account fallback should not be the primary production path.

If retained locally, keep it outside the repo:

```text
/root/.zenos-secrets/zenos-memory-sa.json
```

## Setting Vercel Environment Variables

```bash
npx vercel env add ETLA_MASTER_SECRET production
npx vercel env add ZENOS_MEMORY_API_KEY production

npx vercel env add GOOGLE_OAUTH_CLIENT_ID production
npx vercel env add GOOGLE_OAUTH_CLIENT_SECRET production
cat /root/.zenos-secrets/google-oauth-refresh-token.txt | npx vercel env add GOOGLE_OAUTH_REFRESH_TOKEN production
npx vercel env add ZENOS_MEMORY_DRIVE_FOLDER_ID production
npx vercel env add ZENOS_MEMORY_DRIVE_STRUCTURED production

npx vercel env add MEMORY_LLM_BASE_URL production
npx vercel env add MEMORY_LLM_API_KEY production
npx vercel env add MEMORY_LLM_MODEL production
npx vercel env add MEMORY_LLM_FALLBACK_MODEL production
npx vercel env add MEMORY_EMBEDDING_MODEL production

npx vercel env add CRON_SECRET production
```

## Pre-Public Checklist

Run this before making the repository public:

```bash
git grep -nE 'sk-|vcp_|ghp_|GOCSPX-|private_key|BEGIN PRIVATE KEY|shirinka' || true
```

Expected result: no real secrets. Placeholder examples are acceptable only if clearly redacted.

## Best Practices

- Keep all local secret files under `/root/.zenos-secrets/` with `chmod 600`.
- Never print secrets in logs or API responses.
- Prefer OAuth refresh tokens over service accounts for personal Google Drive.
- Rotate secrets if they are accidentally exposed.
- Keep `.env*` ignored.

## Troubleshooting

- LLM returns 401: check `MEMORY_LLM_API_KEY`.
- Drive returns 403/404: check OAuth token and Drive folder access.
- Signature invalid: check `ETLA_MASTER_SECRET` in both Vercel and Hermes.
- Cron unauthorized: check `CRON_SECRET`.
