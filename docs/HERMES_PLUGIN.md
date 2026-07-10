# Hermes Provider Integration

The Zenos Memory provider keeps Hermes lightweight. Hermes sends authenticated HTTP requests to the Vercel deployment; memory compute and canonical data do not live on the VPS.

## Install

```bash
HERMES_PROFILE=zenos \
ZENOS_MEMORY_URL=https://zenos-memory.vercel.app \
bash scripts/install-hermes-plugin.sh
```

Then enable the provider in the Hermes profile:

```yaml
memory:
  provider: zenos-memory
```

Private provider configuration:

```json
{
  "base_url": "https://zenos-memory.vercel.app",
  "secret": "configured privately",
  "namespace": "zenos",
  "prefetch_limit": 5,
  "auto_compact_every": 10,
  "auto_compact_min_chars": 6000,
  "auto_compact_max_messages": 80
}
```

The installer writes safe defaults only. Configure the secret through `hermes memory setup zenos-memory` or edit the private profile file with restrictive permissions.

## Runtime behavior

At session initialization, the provider requests a bounded bootstrap packet from the cloud service.

For each user query it can prefetch relevant memories and inject them into the agent context. Completed turns are synchronized asynchronously. Before Hermes compresses a long context, the provider requests a structured compact handoff.

The provider exposes tools for:

- durable remember;
- semantic/hybrid search;
- compact;
- bootstrap;
- graph query;
- Mermaid graph output;
- dashboard summary;
- intelligence report.

## Authentication

The provider performs HMAC v2 token exchange:

- timestamp;
- random nonce;
- method and canonical path;
- SHA-256 body hash;
- requested scopes.

It caches short-lived tokens and clears the cache on authorization failure.

## Secret safety

Credential-like turns are skipped during automatic synchronization. Zenos Memory never auto-captures tokens or passwords. Store credentials in a separate vault and remember only vault references.

## VPS footprint

Normal production requires only Hermes Gateway and the provider plugin. The following are not required on the VPS:

- a Zenos Memory Node server;
- a Zenos Memory SQLite database;
- a Zenos Memory maintenance timer;
- graph or compaction jobs.

Those run in Vercel Functions and Vercel Cron.

## Validation

```bash
zenos memory status
systemctl restart hermes-gateway.service
```

The status should show `zenos-memory` as installed and available. A direct search should complete through `https://zenos-memory.vercel.app`.
