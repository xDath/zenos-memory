# Hermes Plugin Installation Guide

This guide explains how to connect Hermes to a deployed Zenos Memory instance.

## Requirements

- A running Zenos Memory deployment, for example:

```text
https://zenos-memory.vercel.app
```

- A Hermes profile directory, for example:

```text
~/.hermes/profiles/zenos
```

- The same `ETLA_MASTER_SECRET` configured in both:
  - Vercel Environment Variables
  - Hermes local plugin config

## Install Plugin

Recommended install from this repository:

```bash
./scripts/install-hermes-plugin.sh
```

The installer copies the plugin into the selected Hermes profile and writes safe non-secret defaults to `zenos-memory.json`, including auto-compact settings. It does **not** write credentials.

Optional environment overrides:

```bash
HERMES_PROFILE=zenos \
ZENOS_MEMORY_URL=https://zenos-memory.vercel.app \
ZENOS_MEMORY_NAMESPACE=zenos \
ZENOS_MEMORY_AUTO_COMPACT_EVERY=10 \
ZENOS_MEMORY_AUTO_COMPACT_MIN_CHARS=6000 \
ZENOS_MEMORY_AUTO_COMPACT_MAX_MESSAGES=80 \
./scripts/install-hermes-plugin.sh
```

Manual install is still supported:

```bash
mkdir -p ~/.hermes/profiles/zenos/plugins/zenos-memory
cp plugins/zenos-memory/__init__.py ~/.hermes/profiles/zenos/plugins/zenos-memory/__init__.py
```

## Configure Plugin

Create:

```text
~/.hermes/profiles/zenos/zenos-memory.json
```

Example:

```json
{
  "base_url": "https://zenos-memory.vercel.app",
  "secret": "<ETLA_MASTER_SECRET>",
  "namespace": "zenos",
  "prefetch_limit": 5,
  "auto_compact_every": 10,
  "auto_compact_min_chars": 6000,
  "auto_compact_max_messages": 80
}
```

Never commit this file. It contains a runtime secret.

## Enable Provider

Edit:

```text
~/.hermes/profiles/zenos/config.yaml
```

Set:

```yaml
memory:
  provider: zenos-memory
```

## Available Tools

Depending on your Hermes version, the provider can expose tools such as:

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

## Auto Behavior

The provider can:

- bootstrap memory on session initialize
- sync turns into Zenos Memory
- auto-compact every `auto_compact_every` turns
- auto-compact early when recent transcript reaches `auto_compact_min_chars`
- preserve context through Hermes compression via `on_pre_compress`
- detect obvious credentials and store them as credential memories

## Test

Restart Hermes, then ask it to search memory or run a dashboard/benchmark tool.

Expected behavior:

- normal recall should not expose credentials
- explicit credential tool can retrieve credential memories
- bootstrap should return recent compact handoffs and relevant memories

## Troubleshooting

### 401 Unauthorized

Check that `secret` in `zenos-memory.json` matches `ETLA_MASTER_SECRET` in Vercel.

### No Memory Results

Check:

- `base_url`
- namespace
- Vercel deployment status
- Google Drive OAuth access

### Plugin Not Loaded

Check:

- plugin path
- provider name in `config.yaml`
- Python import errors in Hermes logs

## Security Notes

- Keep `zenos-memory.json` private.
- Do not commit local profile files.
- Do not expose `ETLA_MASTER_SECRET`.
- Runtime APIs are protected by HMAC signatures.
