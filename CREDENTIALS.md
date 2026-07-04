# Zenos Memory - Credentials & Secrets Management

**PENTING: Jangan commit secret apapun ke Git.**

## Jenis Kredensial

### 1. Vercel Deploy Token (hanya untuk deploy)
- **Nama**: `vcp_...`
- **Kegunaan**: Deploy dari local ke Vercel (bukan runtime)
- **Lokasi**:
  - Local: `/root/.zenos-secrets/vercel-token.txt` (chmod 600)
- **Cara set**:
  ```bash
  cat /root/.zenos-secrets/vercel-token.txt | npx vercel env add VERCEL_TOKEN production --token ...
  ```
- **Tidak** perlu di runtime app.

### 2. Google Drive OAuth (utama untuk storage)
- **ENV**:
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
  - `GOOGLE_OAUTH_REFRESH_TOKEN`
- **Lokasi**:
  - Refresh token: `/root/.zenos-secrets/google-oauth-refresh-token.txt` (600)
  - Semua di-set ke Vercel Environment Variables (encrypted)
- **Cara generate refresh token**:
  ```bash
  GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node scripts/get-google-oauth-token.mjs
  ```
- **Catatan**: Hanya refresh token yang disimpan. Client secret hanya untuk generate.

### 3. LLM Enhancer (via router.etla.me)
- **ENV**:
  - `MEMORY_LLM_BASE_URL=https://router.etla.me/v1`
  - `MEMORY_LLM_API_KEY=sk-c05...`
  - `MEMORY_LLM_MODEL=dsw/deepseek-v4-pro`
  - `MEMORY_LLM_FALLBACK_MODEL=ag/gemini-pro-agent`
- **Lokasi**: Hanya di Vercel envs (production) + local .env jika perlu.
- **Jangan** expose ke public.

### 4. Etla Signing Secret (paling kritis)
- **ENV**: `ETLA_MASTER_SECRET`
- **Kegunaan**: Sign request dari Hermes ke Zenos Memory API
- **Lokasi**:
  - Vercel: Environment Variable
  - Local Hermes: `~/.hermes/profiles/zenos/zenos-memory.json` (field `secret`)
- **Contoh**:
  ```json
  {
    "secret": "shirinka",
    "namespace": "zenos"
  }
  ```
- **Penting**: Ini yang dipakai di `_sign()` di plugin.

### 5. Zenos Memory API Key (legacy / internal)
- **ENV**: `ZENOS_MEMORY_API_KEY`
- **Kegunaan**: Auth untuk debug/test endpoint
- **Lokasi**: Vercel envs

### 6. Legacy Service Account (jangan dipakai lagi)
- File: `/root/.zenos-secrets/zenos-memory-sa.json`
- Hanya untuk fallback lama. Sudah diganti OAuth.

## Cara Set ke Vercel (Production)

```bash
# OAuth
npx vercel env add GOOGLE_OAUTH_CLIENT_ID production
npx vercel env add GOOGLE_OAUTH_CLIENT_SECRET production
cat /root/.zenos-secrets/google-oauth-refresh-token.txt | npx vercel env add GOOGLE_OAUTH_REFRESH_TOKEN production

# LLM
npx vercel env add MEMORY_LLM_BASE_URL production
npx vercel env add MEMORY_LLM_API_KEY production
npx vercel env add MEMORY_LLM_MODEL production
npx vercel env add MEMORY_LLM_FALLBACK_MODEL production

# Signing
npx vercel env add ETLA_MASTER_SECRET production

# Folder
npx vercel env add ZENOS_MEMORY_DRIVE_FOLDER_ID production   # "root" atau folder ID

# Opsional
npx vercel env add ZENOS_MEMORY_DRIVE_STRUCTURED production  # true
```

## Local Development

- Gunakan `.env` atau `.env.local` (jangan commit)
- Untuk Hermes: edit `~/.hermes/profiles/zenos/zenos-memory.json`

## Best Practices

- Semua file secret di `/root/.zenos-secrets/` chmod 600
- Jangan pernah print secret di log atau response
- Refresh token OAuth lebih aman daripada service account untuk My Drive
- Kalau perlu rotate: regenerate refresh token, update Vercel env

## Troubleshooting

- 401 dari LLM → cek `MEMORY_LLM_API_KEY`
- Drive 404/403 → cek OAuth refresh token + folder permission
- Signature invalid → cek `ETLA_MASTER_SECRET` sama di kedua sisi

Jaga secret tetap aman, tuan. Kalau perlu script rotate, bilang.