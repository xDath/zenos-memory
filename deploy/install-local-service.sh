#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SOURCE_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "${SOURCE_ROOT}"
[[ -s .next/standalone/server.js ]] || { echo "Standalone production build missing." >&2; exit 1; }

VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'uncommitted')"
BUILD_ID="$(tr -cd 'A-Za-z0-9._-' < .next/BUILD_ID | cut -c1-32)"
[[ -n "${BUILD_ID}" ]] || BUILD_ID="build-$(date +%s)"
RELEASE_ROOT="/opt/zenos-memory/releases/${VERSION}-${COMMIT}-${BUILD_ID}"
STAGING="${RELEASE_ROOT}.staging"
SERVICE_USER="zenos-memory"
SERVICE_GROUP="zenos-memory"

getent group "${SERVICE_GROUP}" >/dev/null || groupadd --system "${SERVICE_GROUP}"
id -u "${SERVICE_USER}" >/dev/null 2>&1 || useradd --system --gid "${SERVICE_GROUP}" --home-dir /var/lib/zenos-memory --shell /usr/sbin/nologin "${SERVICE_USER}"
install -d -o root -g root -m 0755 /opt/zenos-memory /opt/zenos-memory/releases
install -d -o root -g "${SERVICE_GROUP}" -m 0750 /etc/zenos-memory
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 /var/lib/zenos-memory /var/cache/zenos-memory
# Preserve existing state while migrating from the legacy root-run service to
# the dedicated non-root identity. SQLite WAL/SHM files must share ownership.
chown -R "${SERVICE_USER}:${SERVICE_GROUP}" /var/lib/zenos-memory /var/cache/zenos-memory
find /var/lib/zenos-memory /var/cache/zenos-memory -xdev -type d -exec chmod 0700 {} +
find /var/lib/zenos-memory /var/cache/zenos-memory -xdev -type f -exec chmod 0600 {} +

rm -rf "${STAGING}"
install -d -o root -g root -m 0755 "${STAGING}"
rsync -a --delete --exclude='.git/' --exclude='.env' --exclude='.env.local' --exclude='.data/' --exclude='coverage/' "${SOURCE_ROOT}/" "${STAGING}/"
find "${STAGING}" -xdev -type d -exec chmod go-w {} +
find "${STAGING}" -xdev -type f -exec chmod go-w {} +
chown -R root:root "${STAGING}"
rm -rf "${RELEASE_ROOT}"
mv "${STAGING}" "${RELEASE_ROOT}"
ln -sfn "${RELEASE_ROOT}" /opt/zenos-memory/current

install -d -o root -g root -m 0700 /etc/credstore.encrypted
CREDENTIAL_TMP="$(mktemp)"
cleanup() {
  rm -f "${CREDENTIAL_TMP}"
}
trap cleanup EXIT
python3 - "${CREDENTIAL_TMP}" "${SOURCE_ROOT}/.env.local" /root/.hermes/profiles/zenos/.env <<'PY'
import re
import sys
from pathlib import Path

output = Path(sys.argv[1])
values: dict[str, str] = {}
for filename in sys.argv[2:]:
    path = Path(filename)
    if not path.is_file():
        continue
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not match:
            continue
        key = match.group(1)
        value = match.group(2).strip()
        current = values.get(key, '').strip().strip('"\'')
        candidate = value.strip().strip('"\'')
        if key not in values or (not current and candidate):
            values[key] = value
output.write_text("".join(f"{key}={value}\n" for key, value in sorted(values.items())), encoding="utf-8")
PY
if [[ ! -s "${CREDENTIAL_TMP}" ]]; then
  echo "No Zenos Memory credential source was found." >&2
  exit 1
fi
chmod 0600 "${CREDENTIAL_TMP}"
rm -f /etc/credstore.encrypted/zenos-memory.env.cred
systemd-creds encrypt --with-key=host --name=zenos-memory.env \
  "${CREDENTIAL_TMP}" /etc/credstore.encrypted/zenos-memory.env.cred >/dev/null
chmod 0600 /etc/credstore.encrypted/zenos-memory.env.cred
rm -f /etc/zenos-memory/memory.env /etc/zenos-memory/profile.env

HERMES_PROFILE=zenos ZENOS_MEMORY_URL=http://127.0.0.1:3091 \
  bash "${SOURCE_ROOT}/scripts/install-hermes-plugin.sh"
install -o root -g root -m 0644 "${SOURCE_ROOT}/deploy/zenos-memory.service" /etc/systemd/system/zenos-memory.service
systemctl daemon-reload
systemctl enable zenos-memory.service >/dev/null
systemctl restart zenos-memory.service
systemctl --no-pager --full status zenos-memory.service
