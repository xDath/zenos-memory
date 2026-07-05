#!/usr/bin/env bash
set -euo pipefail

PROFILE_NAME="${HERMES_PROFILE:-zenos}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes/profiles/$PROFILE_NAME}"
PLUGIN_DIR="$HERMES_HOME/plugins/zenos-memory"
CONFIG_FILE="$HERMES_HOME/zenos-memory.json"
BASE_URL="${ZENOS_MEMORY_URL:-https://zenos-memory.vercel.app}"
NAMESPACE="${ZENOS_MEMORY_NAMESPACE:-zenos}"
PREFETCH_LIMIT="${ZENOS_MEMORY_PREFETCH_LIMIT:-5}"
AUTO_COMPACT_EVERY="${ZENOS_MEMORY_AUTO_COMPACT_EVERY:-10}"
AUTO_COMPACT_MIN_CHARS="${ZENOS_MEMORY_AUTO_COMPACT_MIN_CHARS:-6000}"
AUTO_COMPACT_MAX_MESSAGES="${ZENOS_MEMORY_AUTO_COMPACT_MAX_MESSAGES:-80}"

mkdir -p "$PLUGIN_DIR" "$HERMES_HOME"
cp "$(dirname "$0")/../plugins/zenos-memory/__init__.py" "$PLUGIN_DIR/__init__.py"

python3 - "$CONFIG_FILE" "$BASE_URL" "$NAMESPACE" "$PREFETCH_LIMIT" "$AUTO_COMPACT_EVERY" "$AUTO_COMPACT_MIN_CHARS" "$AUTO_COMPACT_MAX_MESSAGES" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1]).expanduser()
base_url, namespace = sys.argv[2], sys.argv[3]
prefetch_limit, every, min_chars, max_messages = map(int, sys.argv[4:8])

try:
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
except Exception:
    data = {}

data.update({
    "base_url": base_url,
    "namespace": namespace,
    "prefetch_limit": prefetch_limit,
    "auto_compact_every": every,
    "auto_compact_min_chars": min_chars,
    "auto_compact_max_messages": max_messages,
})

secret = data.get("secret") or ""
if not secret:
    print("No secret written. Add it later with: hermes memory setup zenos-memory")
    print("Or edit the private local file and set: secret=<ETLA_MASTER_SECRET>")

path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
path.chmod(0o600)
print(f"Installed Zenos Memory plugin to {path.parent / 'plugins' / 'zenos-memory'}")
print(f"Wrote non-secret defaults to {path}")
PY

cat <<EOF

Next step: enable this provider in $HERMES_HOME/config.yaml

memory:
  provider: zenos-memory

EOF
