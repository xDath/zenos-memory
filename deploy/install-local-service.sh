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
PREVIOUS_RELEASE="$(readlink -f /opt/zenos-memory/current 2>/dev/null || true)"
RUNTIME_WAS_ACTIVE=false
if systemctl is-active --quiet zenos-runtime.service; then
  RUNTIME_WAS_ACTIVE=true
fi
SERVICE_USER="zenos-memory"
SERVICE_GROUP="zenos-memory"
HERMES_SERVICE_USER="hermes"
HERMES_PROFILE_ROOT="${ZENOS_HERMES_PROFILE_ROOT:-/var/lib/hermes/.hermes/profiles/zenos}"
LEGACY_HERMES_PROFILE_ROOT="/root/.hermes/profiles/zenos"

if [[ ! -d "${HERMES_PROFILE_ROOT}" && -d "${LEGACY_HERMES_PROFILE_ROOT}" ]]; then
  HERMES_PROFILE_ROOT="${LEGACY_HERMES_PROFILE_ROOT}"
fi

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
EXISTING_CREDENTIAL_TMP="$(mktemp)"
RUNTIME_CREDENTIAL_TMP="$(mktemp)"
PREVIOUS_UNIT_TMP="$(mktemp)"
cleanup() {
  rm -f "${CREDENTIAL_TMP}" "${EXISTING_CREDENTIAL_TMP}" "${RUNTIME_CREDENTIAL_TMP}" "${PREVIOUS_UNIT_TMP}"
}
trap cleanup EXIT
if [[ -s /etc/systemd/system/zenos-memory.service ]]; then
  cp /etc/systemd/system/zenos-memory.service "${PREVIOUS_UNIT_TMP}"
fi
if [[ -s /etc/credstore.encrypted/zenos-memory.env.cred ]]; then
  systemd-creds decrypt --name=zenos-memory.env \
    /etc/credstore.encrypted/zenos-memory.env.cred "${EXISTING_CREDENTIAL_TMP}" >/dev/null
fi
if [[ -s /etc/credstore.encrypted/zenos-runtime.env.cred ]]; then
  systemd-creds decrypt --name=zenos-runtime.env \
    /etc/credstore.encrypted/zenos-runtime.env.cred "${RUNTIME_CREDENTIAL_TMP}" >/dev/null
fi
node "${SOURCE_ROOT}/scripts/prepare-service-environment.mjs" \
  "${CREDENTIAL_TMP}" \
  "${SOURCE_ROOT}/.env.local" \
  "${HERMES_PROFILE_ROOT}/.env" \
  "${EXISTING_CREDENTIAL_TMP}" \
  --runtime "${RUNTIME_CREDENTIAL_TMP}"
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

if [[ "${HERMES_PROFILE_ROOT}" == /var/lib/hermes/* ]] && id -u "${HERMES_SERVICE_USER}" >/dev/null 2>&1; then
  runuser -u "${HERMES_SERVICE_USER}" -- env \
    HOME=/var/lib/hermes \
    HERMES_HOME="${HERMES_PROFILE_ROOT}" \
    ZENOS_MEMORY_URL=http://127.0.0.1:3091 \
    bash "${SOURCE_ROOT}/scripts/install-hermes-plugin.sh"
else
  HERMES_HOME="${HERMES_PROFILE_ROOT}" ZENOS_MEMORY_URL=http://127.0.0.1:3091 \
    bash "${SOURCE_ROOT}/scripts/install-hermes-plugin.sh"
fi
install -o root -g root -m 0644 "${SOURCE_ROOT}/deploy/zenos-memory.service" /etc/systemd/system/zenos-memory.service
systemctl daemon-reload
systemctl enable zenos-memory.service >/dev/null
rollback_memory() {
  if [[ -n "${PREVIOUS_RELEASE}" && -d "${PREVIOUS_RELEASE}" ]]; then
    ln -sfn "${PREVIOUS_RELEASE}" /opt/zenos-memory/current
    if [[ -s "${PREVIOUS_UNIT_TMP}" ]]; then
      install -o root -g root -m 0644 "${PREVIOUS_UNIT_TMP}" /etc/systemd/system/zenos-memory.service
      systemctl daemon-reload
    fi
    systemctl restart zenos-memory.service || true
    if [[ "${RUNTIME_WAS_ACTIVE}" == "true" ]]; then
      systemctl restart zenos-runtime.service || true
    fi
  fi
}
if ! systemctl restart zenos-memory.service; then
  rollback_memory
  echo "Zenos Memory deployment failed; restored the previous release." >&2
  exit 1
fi
MEMORY_READY=false
for _ in {1..30}; do
  if curl --fail --silent --show-error --max-time 2 \
    http://127.0.0.1:3091/api/memory/public-status >/dev/null; then
    MEMORY_READY=true
    break
  fi
  sleep 1
done
if [[ "${MEMORY_READY}" != "true" ]]; then
  rollback_memory
  echo "Zenos Memory failed its post-restart HTTP health gate; restored the previous release." >&2
  exit 1
fi
if [[ "${RUNTIME_WAS_ACTIVE}" == "true" ]] && ! systemctl is-active --quiet zenos-runtime.service; then
  systemctl restart zenos-runtime.service
fi
if [[ -n "${PREVIOUS_RELEASE}" && -d "${PREVIOUS_RELEASE}" && "${PREVIOUS_RELEASE}" != "${RELEASE_ROOT}" ]]; then
  ln -sfn "${PREVIOUS_RELEASE}" /opt/zenos-memory/previous
fi

# Keep only the live release and one known-good rollback. This prevents a
# successful deployment from copying dependency trees until the root disk is
# exhausted again.
CURRENT_RELEASE="$(readlink -f /opt/zenos-memory/current)"
ROLLBACK_RELEASE="$(readlink -f /opt/zenos-memory/previous 2>/dev/null || true)"
for candidate in /opt/zenos-memory/releases/*; do
  [[ -d "${candidate}" ]] || continue
  resolved="$(readlink -f "${candidate}")"
  [[ "${resolved}" == "${CURRENT_RELEASE}" || "${resolved}" == "${ROLLBACK_RELEASE}" ]] && continue
  case "${resolved}" in
    /opt/zenos-memory/releases/*) rm -rf -- "${resolved}" ;;
    *) echo "Refusing unsafe release cleanup target: ${resolved}" >&2; exit 1 ;;
  esac
done
systemctl --no-pager --full status zenos-memory.service
