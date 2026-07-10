# Zenos Memory SDK

Both SDKs default to the production cloud endpoint:

```text
https://zenos-memory.vercel.app
```

Set `ETLA_MASTER_SECRET` or pass a private signing secret to the client. The secret is used locally for HMAC v2 token exchange and is never sent directly.

## JavaScript

```js
import { ZenosMemoryClient } from './sdk/js/zenos-memory-client.mjs';

const memory = new ZenosMemoryClient({ namespace: 'zenos' });

const stored = await memory.remember(
  'Vercel performs compute and Google Drive owns the canonical event history.',
  {
    type: 'project',
    idempotencyKey: 'architecture-decision-2026-07-10',
    metadata: { tags: ['architecture'], importance: 10 },
  },
);

const recalled = await memory.recall('current cloud memory architecture', { limit: 5 });
console.log(recalled.results);
```

## Python

```python
from sdk.python.zenos_memory_client import ZenosMemoryClient

memory = ZenosMemoryClient(namespace='zenos')

memory.remember(
    'Google Drive append-only events are canonical.',
    type='project',
    idempotency_key='drive-event-decision',
)

print(memory.recall('canonical storage', limit=5))
```

## Authentication

The clients automatically:

1. generate a timestamp and nonce;
2. hash the token-exchange request body;
3. sign the canonical HMAC v2 message;
4. request a short-lived scoped token;
5. cache the token until shortly before expiry.

Tokens are refreshed automatically after an authorization failure.

## Secret policy

Do not send passwords or tokens as memory content. Store them in a dedicated secret manager and remember only a reference such as:

```text
vault://production/vercel
```

## Useful operations

The clients support:

- remember;
- recall and hybrid recall;
- edit and archive;
- stats and readiness;
- compact and bootstrap;
- backup and restore;
- timeline and graph operations.

See the client source for the current method signatures.
