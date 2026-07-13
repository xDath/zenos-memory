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
RELEASE_ROOT="/opt/zenos-memory/releases/${VERSION}-${COMMIT}"
STAGING="${RELEASE_ROOT}.staging"
SERVICE_USER="zenos-memory"
SERVICE_GROUP="zenos-memory"

getent group "${SERVICE_GROUP}" >/dev/null || groupadd --system "${SERVICE_GROUP}"
id -u "${SERVICE_USER}" >/dev/null 2>&1 || useradd --system --gid "${SERVICE_GROUP}" --home-dir /var/lib/zenos-memory --shell /usr/sbin/nologin "${SERVICE_USER}"
install -d -o root -g root -m 0755 /opt/zenos-memory /opt/zenos-memory/releases
install -d -o root -g "${SERVICE_GROUP}" -m 0750 /etc/zenos-memory
install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 /var/lib/zenos-memory /var/cache/zenos-memory

rm -rf "${STAGING}"
install -d -o root -g root -m 0755 "${STAGING}"
rsync -a --delete --exclude='.git/' --exclude='.env' --exclude='.env.local' --exclude='.data/' --exclude='coverage/' "${SOURCE_ROOT}/" "${STAGING}/"
find "${STAGING}" -xdev -type d -exec chmod go-w {} +
find "${STAGING}" -xdev -type f -exec chmod go-w {} +
chown -R root:root "${STAGING}"
rm -rf "${RELEASE_ROOT}"
mv "${STAGING}" "${RELEASE_ROOT}"
ln -sfn "${RELEASE_ROOT}" /opt/zenos-memory/current

[[ ! -f "${SOURCE_ROOT}/.env.local" ]] || install -o root -g "${SERVICE_GROUP}" -m 0640 "${SOURCE_ROOT}/.env.local" /etc/zenos-memory/memory.env
[[ ! -f /root/.hermes/profiles/zenos/.env ]] || install -o root -g "${SERVICE_GROUP}" -m 0640 /root/.hermes/profiles/zenos/.env /etc/zenos-memory/profile.env
install -o root -g root -m 0644 "${SOURCE_ROOT}/deploy/zenos-memory.service" /etc/systemd/system/zenos-memory.service
systemctl daemon-reload
systemctl enable zenos-memory.service >/dev/null
systemctl restart zenos-memory.service
systemctl --no-pager --full status zenos-memory.service
