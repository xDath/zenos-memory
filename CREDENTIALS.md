# Zenos Memory Credential Configuration

Zenos Memory reads service credentials from private deployment configuration. It does not store credential values as memories.

## Cloud deployment settings

Configure these names in the Vercel project:

- `ETLA_MASTER_SECRET`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `GOOGLE_DRIVE_FOLDER_NAME` or `ZENOS_MEMORY_DRIVE_FOLDER_ID`
- `CRON_SECRET`

Cloud architecture settings:

- `ZENOS_MEMORY_STORAGE_MODE=drive-events`
- `ZENOS_MEMORY_DEFAULT_NAMESPACE=zenos`
- `ZENOS_MEMORY_IMPORT_LEGACY_ON_START=true`
- `ZENOS_MEMORY_CLOUD_REFRESH_MS=1000`
- `ZENOS_MEMORY_WRITE_LEASE_MS=25000`
- `ZENOS_MEMORY_WRITE_WAIT_MS=15000`

Optional model-provider settings are listed in `.env.example`.

## Hermes client

The private Hermes profile points to:

```text
https://zenos-memory.vercel.app
```

The provider signs a token-exchange request locally. The signing secret itself is not sent in the request.

## Secret references

Memory may contain references to a separate secret manager using these URI families:

- `vault://`
- `secret://`
- `op://`

Memory must not contain actual passwords, API keys, session cookies, authorization headers, private keys, or access tokens.

Legacy secret records are converted into archived references during migration. Their original values are not copied into the Drive event store.

## Rotation

When rotating the signing secret or Google OAuth configuration:

1. update the private Vercel environment value;
2. update the Hermes profile when relevant;
3. redeploy Vercel;
4. restart Hermes Gateway;
5. verify token exchange, readiness, and recall.

Never commit private environment files or profile configuration to Git.
