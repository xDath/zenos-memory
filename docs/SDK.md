# Zenos Memory SDK

Zenos Memory includes lightweight JavaScript and Python SDK clients for learning how an agent can call a cloud-owned memory API with HMAC authentication.

> This SDK is intentionally small and readable. It is useful for experiments, agent installers, and reference implementations.

## Environment

```bash
export ZENOS_MEMORY_URL="https://zenos-memory.vercel.app"
export ETLA_MASTER_SECRET="<ETLA_MASTER_SECRET>"
```

## JavaScript

```js
import { ZenosMemoryClient } from '../sdk/js/zenos-memory-client.mjs';

const memory = new ZenosMemoryClient();
await memory.remember('The project uses Google Drive as the memory data layer.');
const recall = await memory.recall('memory data layer');
console.log(recall.results?.[0]);
```

Available methods:

```text
remember(content, options)
recall(query, options)
compact(messages, options)
ingest(filename, content, options)
timeline(options)
mutationPlan(content, options)
benchmark(options)
```

## Python

```python
from sdk.python.zenos_memory_client import ZenosMemoryClient

memory = ZenosMemoryClient()
memory.remember('The project uses Google Drive as the memory data layer.')
recall = memory.recall('memory data layer')
print(recall['results'][0])
```

## HMAC model

Each request signs:

```text
<timestamp_ms>:<HTTP_METHOD>:<path_with_query>
```

Headers:

```text
x-etla-timestamp: <timestamp_ms>
x-etla-signature: <hmac_sha256_hex>
content-type: application/json
```

## Learning flow

1. Deploy the API on Vercel.
2. Configure Google Drive OAuth storage.
3. Install the Hermes plugin or call the SDK directly.
4. Run benchmark and timeline smoke tests.
5. Inspect public status/dashboard without exposing protected memory content.
