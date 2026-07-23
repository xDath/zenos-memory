#!/usr/bin/env python3
"""Rotate the dedicated Zenos Memory signing key without exposing secrets.

The transaction deploys a Vercel keyring containing the new and previous keys,
verifies v3 token exchange with the new key, then atomically updates encrypted
Runtime/Hermes systemd credentials. Client credentials are rolled back if a
service restart fails. Run as root from the linked zenos-memory project.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import subprocess
import tempfile
import time
import urllib.request

RUNTIME_CREDENTIAL = Path("/etc/credstore.encrypted/zenos-runtime.env.cred")
HERMES_CREDENTIAL = Path("/etc/credstore.encrypted/hermes-zenos.env.cred")
TOKEN_FILE = Path("/root/.zenos-secrets/vercel-token.txt")
MEMORY_URL = "https://zenos-memory.vercel.app"


def run(
    command: list[str],
    *,
    cwd: Path | None = None,
    input_text: str | None = None,
    check: bool = True,
    env_overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
        env={**os.environ, "NO_COLOR": "1", **(env_overrides or {})},
    )


def decode_value(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return ""
    try:
        parsed = shlex.split(raw)
        return parsed[0] if len(parsed) == 1 else raw.strip("'\"")
    except ValueError:
        return raw.strip("'\"")


def parse_environment(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = decode_value(value)
    return values


def render_environment(values: dict[str, str]) -> str:
    return "".join(f"{key}={shlex.quote(value)}\n" for key, value in sorted(values.items()))


def decrypt_credential(path: Path, name: str) -> dict[str, str]:
    result = run(["systemd-creds", "decrypt", f"--name={name}", str(path), "-"])
    return parse_environment(result.stdout)


def encrypt_credential(values: dict[str, str], destination: Path, name: str) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="zenos-memory-key-rotation-") as directory:
        plain = Path(directory) / "credential.env"
        encrypted = Path(directory) / "credential.cred"
        plain.write_text(render_environment(values), encoding="utf-8")
        plain.chmod(0o600)
        run(["systemd-creds", "encrypt", f"--name={name}", str(plain), str(encrypted)])
        prepared = destination.with_suffix(destination.suffix + ".next")
        shutil.copy2(encrypted, prepared)
        prepared.chmod(0o600)
        return prepared


def vercel_set(project: Path, token: str, name: str, value: str) -> None:
    token_env = {"VERCEL_TOKEN": token}
    run(
        ["npx", "vercel", "env", "rm", name, "production", "--yes"],
        cwd=project,
        check=False,
        env_overrides=token_env,
    )
    result = run(
        ["npx", "vercel", "env", "add", name, "production"],
        cwd=project,
        input_text=value + "\n",
        check=False,
        env_overrides=token_env,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to configure Vercel variable {name}: {result.stderr[-500:]}")


def token_exchange(secret: str, kid: str) -> dict[str, object]:
    timestamp = int(time.time() * 1000)
    nonce = secrets.token_urlsafe(18)
    empty_hash = hashlib.sha256(b"").hexdigest()
    canonical = "\n".join([
        "zenos-memory-signature-v3",
        kid,
        str(timestamp),
        nonce,
        "POST",
        "/api/auth",
        empty_hash,
    ])
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        MEMORY_URL + "/api/auth",
        method="POST",
        headers={
            "x-etla-kid": kid,
            "x-etla-timestamp": str(timestamp),
            "x-etla-nonce": nonce,
            "x-etla-content-sha256": empty_hash,
            "x-etla-signature": signature,
            "x-etla-client-id": "memory-signing-rotation",
            "x-etla-requested-scopes": "memory:read memory:write",
            "content-type": "application/json",
        },
        data=b"",
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("kid") != kid or not str(payload.get("token") or "").startswith(f"zm2.{kid}."):
        raise RuntimeError("Production Memory did not issue the expected kid-bound token")
    return payload


def service_active(name: str) -> bool:
    return run(["systemctl", "is-active", "--quiet", name], check=False).returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--token-file", default=str(TOKEN_FILE))
    parser.add_argument("--kid", default="")
    parser.add_argument("--skip-deploy", action="store_true")
    parser.add_argument("--deploy-only", action="store_true")
    args = parser.parse_args()

    if os.geteuid() != 0:
        raise SystemExit("Run as root so encrypted systemd credentials can be rotated")
    project = Path(args.project).resolve()
    token = Path(args.token_file).read_text(encoding="utf-8").strip()
    if not token:
        raise SystemExit("Vercel token file is empty")
    if args.deploy_only:
        result = run(
            ["npx", "vercel", "--prod", "--yes"],
            cwd=project,
            check=False,
            env_overrides={"VERCEL_TOKEN": token},
        )
        if result.returncode != 0:
            raise RuntimeError(f"Vercel deployment failed: {result.stderr[-1200:]}")
        print(json.dumps({
            "ok": True,
            "mode": "deploy-only",
            "secret_values_printed": False,
        }))
        return 0

    runtime_values = decrypt_credential(RUNTIME_CREDENTIAL, "zenos-runtime.env")
    hermes_values = decrypt_credential(HERMES_CREDENTIAL, "hermes-zenos.env")
    previous_secret = (
        runtime_values.get("ZENOS_MEMORY_SIGNING_SECRET")
        or hermes_values.get("ZENOS_MEMORY_SIGNING_SECRET")
        or runtime_values.get("ZENOS_MEMORY_SECRET")
        or runtime_values.get("ETLA_MASTER_SECRET")
        or hermes_values.get("ETLA_MASTER_SECRET")
    )
    if not previous_secret:
        raise SystemExit("No existing Memory-compatible signing secret was found")
    previous_kid = runtime_values.get("ZENOS_MEMORY_SIGNING_KID") or "legacy"
    kid = args.kid or f"memory-{time.strftime('%Y-%m')}-{secrets.token_hex(3)}"
    current_secret = secrets.token_urlsafe(64)
    keyring = {kid: current_secret}
    if previous_secret != current_secret:
        keyring[previous_kid] = previous_secret

    production_variables = {
        "ZENOS_MEMORY_SIGNING_KEYS": json.dumps(keyring, separators=(",", ":")),
        "ZENOS_MEMORY_ACTIVE_KID": kid,
        "ZENOS_MEMORY_EVENT_PACK_MODE": "shadow",
        "ZENOS_MEMORY_OPERATION_MODE": "opportunistic_free",
        "ZENOS_MEMORY_MAX_DAILY_DRIVE_WRITES": "10000",
        "ZENOS_MEMORY_MAX_DAILY_LLM_TOKENS": "250000",
        "ZENOS_MEMORY_MAX_STORAGE_BYTES": "10737418240",
        "ZENOS_MEMORY_MIN_FREE_STORAGE_BYTES": "536870912",
        "ZENOS_MEMORY_DEGRADATION_MODE": "deterministic",
    }
    for name, value in production_variables.items():
        vercel_set(project, token, name, value)

    if not args.skip_deploy:
        result = run(
            ["npx", "vercel", "--prod", "--yes"],
            cwd=project,
            check=False,
            env_overrides={"VERCEL_TOKEN": token},
        )
        if result.returncode != 0:
            raise RuntimeError(f"Vercel deployment failed: {result.stderr[-1200:]}")

    token_exchange(current_secret, kid)

    client_policy = {
        "ZENOS_MEMORY_SIGNING_KID": kid,
        "ZENOS_MEMORY_SIGNING_SECRET": current_secret,
        "ZENOS_LOW_TIER_FIRST_MODE": "shadow",
        "ZENOS_LOW_TIER_FIRST_APPROVED_TASKS": "repo_question,coding_change,debugging",
        "ZENOS_LOW_TIER_MIN_OUTCOMES": "30",
        "ZENOS_LOW_TIER_CANARY_PERCENT": "10",
        "ZENOS_RUNTIME_CONTINUITY_COORDINATOR_ENABLED": "true",
        "ZENOS_RUNTIME_COMMAND_JOBS_ENABLED": "true",
        "ZENOS_RUNTIME_EVIDENCE_FAITHFULNESS_ENABLED": "true",
    }
    runtime_values.update(client_policy)
    hermes_values.update(client_policy)

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backups = {
        RUNTIME_CREDENTIAL: RUNTIME_CREDENTIAL.with_suffix(RUNTIME_CREDENTIAL.suffix + f".bak-{stamp}"),
        HERMES_CREDENTIAL: HERMES_CREDENTIAL.with_suffix(HERMES_CREDENTIAL.suffix + f".bak-{stamp}"),
    }
    for source, backup in backups.items():
        shutil.copy2(source, backup)
        backup.chmod(0o600)
    runtime_next = encrypt_credential(runtime_values, RUNTIME_CREDENTIAL, "zenos-runtime.env")
    hermes_next = encrypt_credential(hermes_values, HERMES_CREDENTIAL, "hermes-zenos.env")

    try:
        os.replace(runtime_next, RUNTIME_CREDENTIAL)
        os.replace(hermes_next, HERMES_CREDENTIAL)
        run(["systemctl", "restart", "zenos-runtime.service"])
        run(["systemctl", "restart", "hermes-gateway.service"])
        time.sleep(4)
        if not service_active("zenos-runtime.service") or not service_active("hermes-gateway.service"):
            raise RuntimeError("A service did not remain active after signing-key rotation")
    except Exception:
        for destination, backup in backups.items():
            shutil.copy2(backup, destination)
            destination.chmod(0o600)
        run(["systemctl", "restart", "zenos-runtime.service"], check=False)
        run(["systemctl", "restart", "hermes-gateway.service"], check=False)
        raise

    print(json.dumps({
        "ok": True,
        "active_kid": kid,
        "previous_kid_retained": previous_kid,
        "runtime_active": True,
        "hermes_active": True,
        "vercel_deployed": not args.skip_deploy,
        "secret_values_printed": False,
        "next_action": "Remove the previous kid after the maximum token lifetime plus clock skew and a successful client audit.",
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
