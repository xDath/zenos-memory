"""Zenos Memory provider for Hermes.

Zenos Runtime owns automatic current-turn recall. This provider supplies a
small explicit tool surface, durable salience-gated writes, and one bounded
checkpoint at a real Hermes compression boundary.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Dict, List
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError

from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://zenos-memory.vercel.app"
DEFAULT_RUNTIME_URL = "http://127.0.0.1:3090"
DEFAULT_NAMESPACE = "zenos"


def _load_config() -> dict:
    from hermes_constants import get_hermes_home

    # Non-secret profile settings may live in zenos-memory.json, but service
    # credentials and deployment endpoints delivered by systemd must remain
    # authoritative. A stale local JSON file must never redirect a hardened
    # production gateway back to a dead localhost service or override a rotated
    # secret.
    cfg = {
        "base_url": DEFAULT_BASE_URL,
        "secret": "",
        "namespace": DEFAULT_NAMESPACE,
        "auto_compact_max_messages": 300,
        "runtime_coordinator_enabled": True,
        "runtime_url": DEFAULT_RUNTIME_URL,
        "runtime_checkpoint_timeout_seconds": 25,
        "runtime_checkpoint_soft_limit_tokens": 160_000,
        "salience_batch_size": 4,
        "salience_flush_seconds": 30,
        "salience_spool_path": str(get_hermes_home() / "state" / "zenos-memory-salience-spool.json"),
        "compact_spool_path": str(get_hermes_home() / "state" / "zenos-memory-compact-spool.json"),
    }
    path = get_hermes_home() / "zenos-memory.json"
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            cfg.update({key: value for key, value in data.items() if value not in (None, "")})
        except Exception:
            logger.exception("Failed to load zenos-memory.json")

    environment_overrides = {
        "base_url": os.environ.get("ZENOS_MEMORY_URL"),
        "secret": (
            os.environ.get("ZENOS_MEMORY_SIGNING_SECRET")
            or os.environ.get("ZENOS_MEMORY_SECRET")
            or os.environ.get("ETLA_MASTER_SECRET")
        ),
        "namespace": os.environ.get("ZENOS_MEMORY_NAMESPACE"),
        "auto_compact_max_messages": os.environ.get("ZENOS_MEMORY_AUTO_COMPACT_MAX_MESSAGES"),
        "runtime_url": os.environ.get("ZENOS_RUNTIME_URL"),
        "salience_batch_size": os.environ.get("ZENOS_MEMORY_SALIENCE_BATCH_SIZE"),
        "salience_flush_seconds": os.environ.get("ZENOS_MEMORY_SALIENCE_FLUSH_SECONDS"),
        "salience_spool_path": os.environ.get("ZENOS_MEMORY_SALIENCE_SPOOL_PATH"),
        "compact_spool_path": os.environ.get("ZENOS_MEMORY_COMPACT_SPOOL_PATH"),
    }
    cfg.update({key: value for key, value in environment_overrides.items() if value not in (None, "")})
    return cfg


def _runtime_api_key() -> str:
    direct = os.environ.get("ZENOS_RUNTIME_API_KEY", "").strip()
    if direct:
        return direct
    credential_directory = os.environ.get("CREDENTIALS_DIRECTORY", "").strip()
    candidates = [
        os.environ.get("ZENOS_RUNTIME_ENV_FILE", ""),
        str(Path(credential_directory) / "zenos-runtime.env") if credential_directory else "",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            for raw_line in Path(candidate).read_text(encoding="utf-8").splitlines():
                if not raw_line.startswith("ZENOS_RUNTIME_API_KEY="):
                    continue
                value = raw_line.split("=", 1)[1].strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                    value = value[1:-1]
                if value:
                    return value
        except OSError:
            continue
    return ""


def _stable_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    if isinstance(content, list):
        return "[" + ",".join(_stable_message_content(item) for item in content) + "]"
    if isinstance(content, dict):
        return "{" + ",".join(
            f"{json.dumps(str(key), ensure_ascii=False)}:{_stable_message_content(content[key])}"
            for key in sorted(content, key=lambda value: str(value))
        ) + "}"
    if isinstance(content, bool):
        return "true" if content else "false"
    return str(content)


def _continuity_fingerprint(messages: list[dict], limit: int = 400) -> str:
    bounded = _bounded_compact_messages(
        messages,
        max_messages=max(20, min(limit, 400)),
        max_chars=500_000,
        max_message_chars=32_000,
    )
    rendered = "\n---\n".join(
        f"{str(message.get('role') or '').strip().lower()}\n{_stable_message_content(message.get('content'))}"
        for message in bounded
    )
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def _bounded_compact_messages(
    messages: list[dict],
    *,
    max_messages: int = 300,
    max_chars: int = 240_000,
    max_message_chars: int = 32_000,
) -> list[dict]:
    """Compile head, milestones, tool evidence, and tail under section budgets."""
    normalized: list[tuple[int, dict, str]] = []
    for index, message in enumerate(messages[-400:]):
        role = str(message.get("role") or "unknown").strip().lower()[:80]
        content = _stable_message_content(message.get("content")).strip()[:max_message_chars]
        if not content:
            continue
        normalized.append((index, {
            "role": role,
            "content": content,
            **({"name": str(message.get("name"))[:200]} if message.get("name") else {}),
            **({"tool_call_id": str(message.get("tool_call_id"))[:500]} if message.get("tool_call_id") else {}),
            **({"message_id": str(message.get("message_id") or message.get("id"))[:500]}
               if message.get("message_id") or message.get("id") else {}),
        }, content))
    if not normalized:
        return []

    meaningful = re.compile(
        r"\b(?:goal|objective|tujuan|buat|bikin|implement|upgrade|audit|fix|perbaiki|decision|decided|keputusan|diputuskan|constraint|must|jangan|harus|wajib|acceptance criteria)\b",
        re.I,
    )
    milestone = re.compile(
        r"\b(?:decision|decided|constraint|patch|edit|changed|modified|test|typecheck|lint|build|validation|passed|failed|blocker|error|pending|next|lanjut|belum)\b",
        re.I,
    )
    head_indexes = [index for index, item, text in normalized[:40]
                    if item["role"] in {"system", "user"} and meaningful.search(text)][:8]
    if not head_indexes:
        head_indexes = [index for index, item, _ in normalized[:12] if item["role"] in {"system", "user"}][:8]
    milestone_indexes = [index for index, item, text in normalized
                         if item["role"] == "tool" or milestone.search(text)]
    tail_count = max(20, min(160, max_messages - len(head_indexes)))
    tail_indexes = [index for index, _, _ in normalized[-tail_count:]]

    head_budget = int(max_chars * 0.12)
    milestone_budget = int(max_chars * 0.33)
    tool_budget = int(max_chars * 0.20)
    tail_budget = max_chars - head_budget - milestone_budget - tool_budget
    groups = [
        (head_indexes, head_budget),
        ([index for index in milestone_indexes if normalized[index][1]["role"] != "tool"], milestone_budget),
        ([index for index in milestone_indexes if normalized[index][1]["role"] == "tool"], tool_budget),
        (tail_indexes, tail_budget),
    ]
    selected_indexes: set[int] = set()
    for indexes, budget in groups:
        used = 0
        for index in indexes:
            if index in selected_indexes or len(selected_indexes) >= max_messages:
                continue
            message = normalized[index][1]
            remaining = budget - used
            if remaining <= 64:
                break
            content = str(message["content"])
            bounded = dict(message)
            bounded["content"] = content[:max(64, min(max_message_chars, remaining - 32))]
            cost = len(json.dumps(bounded, ensure_ascii=False, sort_keys=True))
            if cost > remaining and used:
                continue
            normalized[index] = (normalized[index][0], bounded, bounded["content"])
            selected_indexes.add(index)
            used += min(cost, remaining)
    return [normalized[index][1] for index in sorted(selected_indexes)][:max_messages]


def _deterministic_continuity_checkpoint(messages: list[dict], max_chars: int = 8_000) -> str:
    """Build a bounded continuity handoff without any model dependency."""
    bounded = _bounded_compact_messages(messages, max_messages=300, max_chars=120_000)
    entries: list[tuple[str, str]] = []
    for message in bounded:
        role = str(message.get("role") or "").strip().lower()
        if role not in {"user", "assistant", "tool"}:
            continue
        text = re.sub(r"\s+", " ", _stable_message_content(message.get("content"))).strip()
        if not text:
            continue
        entries.append((role, text[:2_400]))

    user_entries = [text for role, text in entries if role == "user"]
    current_goal = (user_entries[0] if user_entries else "Continue the active task from the preserved evidence.")[:1_200]
    latest_request = (user_entries[-1] if user_entries else current_goal)[:1_000]

    category_patterns = {
        "Decisions": re.compile(r"\b(?:decid(?:e|ed)|decision|putuskan|diputuskan|pakai|gunakan|chosen|keep|tetap)\b", re.I),
        "Pending work": re.compile(r"\b(?:todo|pending|next|lanjut|belum|harus|need|needs|remaining|blocker|fix|perbaiki)\b", re.I),
        "Failures": re.compile(r"\b(?:error|failed|failure|gagal|exception|timeout|403|401|429|502|crash|rusak)\b", re.I),
        "Completed evidence": re.compile(r"\b(?:passed|success|successful|done|completed|selesai|lulus|fixed|resolved)\b", re.I),
    }
    sections: dict[str, list[str]] = {name: [] for name in category_patterns}
    artifacts: list[str] = []
    seen: set[str] = set()
    path_pattern = re.compile(r"(?:^|\s)(/(?:srv|var|opt|etc|root|home)/[^\s,;]+|[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+)")

    for role, text in entries:
        normalized = text.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        line = f"[{role}] {text[:600]}"
        for name, pattern in category_patterns.items():
            if pattern.search(text) and len(sections[name]) < 2:
                sections[name].append(line)
        for match in path_pattern.findall(text):
            clean = match.rstrip(".)]}'\"")
            if clean and clean not in artifacts and len(artifacts) < 12:
                artifacts.append(clean)

    blocks = [
        "[Deterministic continuity checkpoint — generated without an LLM]",
        f"Current goal: {current_goal}",
        f"Latest user request: {latest_request}",
    ]
    for name in ("Decisions", "Pending work", "Failures", "Completed evidence"):
        values = sections[name]
        if values:
            blocks.append(f"{name}:\n" + "\n".join(f"- {value}" for value in values))
    if artifacts:
        blocks.append("Artifacts and paths:\n" + "\n".join(f"- {value}" for value in artifacts))
    blocks.append("Recovery instruction: continue the same task autonomously; do not ask the user to repeat ordinary steps already represented above.")
    return "\n\n".join(blocks)[:max(1_000, min(max_chars, 12_000))]


def _token_exchange_headers(secret: str, scopes: list[str], client_id: str = "hermes-zenos-memory") -> dict:
    timestamp = int(time.time() * 1000)
    nonce = secrets.token_urlsafe(18)
    body_hash = hashlib.sha256(b"").hexdigest()
    kid = os.environ.get("ZENOS_MEMORY_SIGNING_KID", "").strip()
    canonical = "\n".join(([
        "zenos-memory-signature-v3",
        kid,
        str(timestamp),
        nonce,
        "POST",
        "/api/auth",
        body_hash,
    ] if kid else [
        "zenos-memory-signature-v2",
        str(timestamp),
        nonce,
        "POST",
        "/api/auth",
        body_hash,
    ]))
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {
        "x-etla-timestamp": str(timestamp),
        "x-etla-nonce": nonce,
        "x-etla-content-sha256": body_hash,
        "x-etla-signature": signature,
        **({"x-etla-kid": kid, "x-etla-signature-version": "3"} if kid else {}),
        "x-etla-client-id": client_id,
        "x-etla-requested-scopes": " ".join(scopes),
        "Content-Type": "application/json",
    }


class ZenosMemoryProvider(MemoryProvider):
    @property
    def name(self) -> str:
        return "zenos-memory"

    def __init__(self) -> None:
        self._cfg: dict = {}
        self._base_url = DEFAULT_BASE_URL
        self._secret = ""
        self._namespace = DEFAULT_NAMESPACE
        self._session_id = ""
        self._auto_compact_max_messages = 300
        self._runtime_coordinator_enabled = True
        self._runtime_url = DEFAULT_RUNTIME_URL
        self._runtime_checkpoint_timeout_seconds = 25
        self._runtime_checkpoint_soft_limit_tokens = 160_000
        self._last_compact_fingerprint = ""
        self._compact_generation = 0
        self._salience_batch_size = 4
        self._salience_flush_seconds = 30
        self._salience_buffer: list[dict] = []
        self._salience_lock = threading.Lock()
        self._last_salience_flush = time.monotonic()
        self._salience_spool_path = Path("zenos-memory-salience-spool.json")
        self._salience_stop = threading.Event()
        self._salience_thread: threading.Thread | None = None
        self._token_cache: dict[str, tuple[str, float]] = {}
        self._token_lock = threading.Lock()
        self._compact_inflight: set[str] = set()
        self._compact_jobs: dict[str, dict] = {}
        self._compact_spool_path = Path("zenos-memory-compact-spool.json")
        self._compact_lock = threading.Lock()
        self._background_lock = threading.Lock()
        self._background_threads: set[threading.Thread] = set()
        self._shutdown = threading.Event()

    def is_available(self) -> bool:
        cfg = _load_config()
        return bool(cfg.get("base_url") and cfg.get("secret"))

    def save_config(self, values, hermes_home):
        from pathlib import Path
        from utils import atomic_json_write

        path = Path(hermes_home) / "zenos-memory.json"
        existing = {}
        if path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                existing = {}
        existing.update(values)
        atomic_json_write(path, existing, mode=0o600)

    def get_config_schema(self):
        return [
            {"key": "base_url", "description": "Zenos Memory base URL", "default": DEFAULT_BASE_URL},
            {
                "key": "secret",
                "description": "Etla master secret for HMAC signing",
                "secret": True,
                "required": True,
                "env_var": "ZENOS_MEMORY_SIGNING_SECRET",
            },
            {"key": "namespace", "description": "Default namespace", "default": DEFAULT_NAMESPACE},
            {
                "key": "runtime_coordinator_enabled",
                "description": "Let Zenos Runtime own compression checkpoints",
                "default": True,
            },
            {"key": "runtime_url", "description": "Zenos Runtime URL", "default": DEFAULT_RUNTIME_URL},
            {
                "key": "runtime_checkpoint_timeout_seconds",
                "description": "Runtime checkpoint deadline",
                "default": 25,
            },
        ]

    def initialize(self, session_id: str, **kwargs) -> None:
        self._stop_salience_timer()
        self._shutdown.clear()
        self._cfg = _load_config()
        self._base_url = str(self._cfg.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
        self._secret = str(self._cfg.get("secret") or "")
        self._namespace = str(self._cfg.get("namespace") or DEFAULT_NAMESPACE)
        self._session_id = str(session_id or "")
        self._auto_compact_max_messages = max(
            20,
            min(int(self._cfg.get("auto_compact_max_messages") or 300), 400),
        )
        self._runtime_coordinator_enabled = bool(self._cfg.get("runtime_coordinator_enabled", True))
        self._runtime_url = str(self._cfg.get("runtime_url") or DEFAULT_RUNTIME_URL).rstrip("/")
        self._runtime_checkpoint_timeout_seconds = max(
            3,
            min(int(self._cfg.get("runtime_checkpoint_timeout_seconds") or 25), 90),
        )
        self._runtime_checkpoint_soft_limit_tokens = max(
            24_000,
            min(int(self._cfg.get("runtime_checkpoint_soft_limit_tokens") or 160_000), 1_000_000),
        )
        self._salience_batch_size = max(2, min(int(self._cfg.get("salience_batch_size") or 4), 8))
        self._salience_flush_seconds = max(5, min(int(self._cfg.get("salience_flush_seconds") or 30), 300))
        self._salience_spool_path = Path(str(self._cfg.get("salience_spool_path") or "zenos-memory-salience-spool.json"))
        self._compact_spool_path = Path(str(self._cfg.get("compact_spool_path") or "zenos-memory-compact-spool.json"))
        with self._salience_lock:
            self._salience_buffer = self._load_salience_spool()
        self._last_salience_flush = time.monotonic()
        self._last_compact_fingerprint = ""
        self._compact_generation = 0
        with self._compact_lock:
            self._compact_inflight.clear()
            self._compact_jobs = self._load_compact_spool()
        self._start_salience_timer()
        if not self._runtime_coordinator_enabled:
            self._retry_compact_spool()

    def _load_salience_spool(self) -> list[dict]:
        try:
            if not self._salience_spool_path.exists():
                return []
            raw = json.loads(self._salience_spool_path.read_text(encoding="utf-8"))
            if not isinstance(raw, list):
                raise ValueError("salience spool must contain a JSON array")
            return [item for item in raw if isinstance(item, dict)][:64]
        except Exception:
            logger.exception("Failed to load durable Zenos Memory salience spool")
            return []

    def _persist_salience_spool_locked(self) -> None:
        path = self._salience_spool_path
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(self._salience_buffer, ensure_ascii=False), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)

    def _load_compact_spool(self) -> dict[str, dict]:
        try:
            if not self._compact_spool_path.exists():
                return {}
            raw = json.loads(self._compact_spool_path.read_text(encoding="utf-8"))
            if not isinstance(raw, list):
                raise ValueError("compact spool must contain a JSON array")
            jobs: dict[str, dict] = {}
            for item in raw[-64:]:
                if not isinstance(item, dict):
                    continue
                fingerprint = str(item.get("fingerprint") or "").strip()
                messages = item.get("messages")
                if not fingerprint or not isinstance(messages, list):
                    continue
                jobs[fingerprint] = item
            return jobs
        except Exception:
            logger.exception("Failed to load durable Zenos Memory compact spool")
            return {}

    def _persist_compact_spool_locked(self) -> None:
        try:
            path = self._compact_spool_path
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
            jobs = sorted(
                self._compact_jobs.values(),
                key=lambda item: str(item.get("created_at") or ""),
            )[-64:]
            temporary.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        except FileNotFoundError:
            # Normal during profile/test teardown after the async request was
            # already launched. The in-memory job remains pending.
            logger.debug("Compact spool path disappeared during shutdown")
        except Exception:
            # The in-memory job remains pending. Never let a spool filesystem
            # failure crash a Hermes compression callback/background thread.
            logger.exception("Failed to persist durable Zenos Memory compact spool")

    def _retry_compact_spool(self) -> None:
        current_time = time.time()
        with self._compact_lock:
            jobs = []
            for item in self._compact_jobs.values():
                fingerprint = str(item.get("fingerprint") or "")
                if not fingerprint or fingerprint in self._compact_inflight:
                    continue
                attempts = max(0, int(item.get("attempts") or 0))
                last_attempt = float(item.get("last_attempt_at") or 0)
                retry_after = min(3600, 30 * (2 ** min(attempts, 7)))
                if last_attempt and current_time - last_attempt < retry_after:
                    continue
                jobs.append(dict(item))
        for job in jobs[:8]:
            self._start_cloud_compact_job(job)

    def _salience_timer_loop(self) -> None:
        while not self._salience_stop.wait(self._salience_flush_seconds):
            self._flush_salience_buffer(force=True)
            if not self._runtime_coordinator_enabled:
                self._retry_compact_spool()

    def _start_salience_timer(self) -> None:
        self._salience_stop = threading.Event()
        self._salience_thread = threading.Thread(
            target=self._salience_timer_loop,
            name="zenos-memory-salience-flush",
            daemon=True,
        )
        self._salience_thread.start()

    def _stop_salience_timer(self) -> None:
        self._salience_stop.set()
        thread = self._salience_thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2)
        self._salience_thread = None

    def system_prompt_block(self) -> str:
        return (
            "# Zenos Memory\n"
            "Runtime supplies bounded automatic recall. Use zenos_memory_search only for extra evidence and "
            "zenos_memory_remember only for durable non-secret facts, preferences, decisions, or tasks."
        )

    def _token(self, scopes: tuple[str, ...] = ("memory:read", "memory:write")) -> str:
        if not self._secret:
            raise RuntimeError("Zenos Memory secret is not configured")
        cache_key = " ".join(sorted(scopes))
        with self._token_lock:
            cached = self._token_cache.get(cache_key)
            if cached and time.time() < cached[1] - 30:
                return cached[0]
            headers = _token_exchange_headers(self._secret, list(scopes))
            req = urllib_request.Request(self._base_url + "/api/auth", headers=headers, method="POST")
            try:
                with urllib_request.urlopen(req, timeout=20) as response:
                    payload = json.loads(response.read().decode("utf-8") or "{}")
            except HTTPError as exc:
                raise RuntimeError(f"Zenos token exchange failed with HTTP {exc.code}") from exc
            except URLError as exc:
                raise RuntimeError("Zenos token exchange is unreachable") from exc
            token = payload.get("token")
            if not isinstance(token, str):
                raise RuntimeError("Zenos token exchange returned no token")
            expires_in = int(payload.get("expires_in") or 900)
            self._token_cache[cache_key] = (token, time.time() + expires_in)
            return token

    def _request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
        scopes: tuple[str, ...] | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        method = method.upper()
        required = scopes or (("memory:read",) if method in ("GET", "HEAD") else ("memory:read", "memory:write"))
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "Authorization": f"Bearer {self._token(required)}",
            "Accept": "application/json",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key[:200]
        req = urllib_request.Request(self._base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib_request.urlopen(req, timeout=30) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except HTTPError as exc:
            if exc.code == 401:
                with self._token_lock:
                    self._token_cache.clear()
            raise RuntimeError(f"Zenos request failed with HTTP {exc.code}") from exc
        except URLError as exc:
            raise RuntimeError("Zenos Memory is unreachable") from exc

    def _runtime_checkpoint(
        self,
        messages: list[dict],
        *,
        fingerprint: str,
        approx_tokens: int,
        generation: int,
    ) -> dict:
        api_key = _runtime_api_key()
        if not api_key:
            raise RuntimeError("ZENOS_RUNTIME_API_KEY is not configured for the checkpoint coordinator")
        body = {
            "sessionId": self._session_id or "hermes-memory-session",
            "turnId": f"compression-{generation}-{fingerprint[:16]}",
            "namespace": self._namespace,
            "estimatedTokens": max(0, int(approx_tokens)),
            "checkpointSoftLimitTokens": self._runtime_checkpoint_soft_limit_tokens,
            "messages": messages,
            "maxChars": 8_000,
            "inputMaxChars": 240_000,
            "forceCheckpoint": True,
            "reason": f"hermes-pre-compress-generation:{generation}",
        }
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib_request.Request(
            self._runtime_url + "/api/runtime/continuity/checkpoint",
            data=data,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib_request.urlopen(req, timeout=self._runtime_checkpoint_timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8") or "{}")
        except HTTPError as exc:
            raise RuntimeError(f"Zenos Runtime checkpoint failed with HTTP {exc.code}") from exc
        except (URLError, TimeoutError) as exc:
            raise RuntimeError("Zenos Runtime checkpoint coordinator is unreachable") from exc
        checkpoint = payload.get("checkpoint") if isinstance(payload, dict) else None
        if not isinstance(checkpoint, dict):
            raise RuntimeError("Zenos Runtime returned no checkpoint contract")
        return checkpoint

    def _remember(
        self,
        content: str,
        *,
        namespace: str | None = None,
        memory_type: str = "fact",
        metadata: dict | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        return self._request(
            "POST",
            "/api/memory/remember",
            {
                "content": content,
                "type": memory_type,
                "namespace": namespace or self._namespace,
                "metadata": metadata or {},
            },
            idempotency_key=idempotency_key,
        )

    def _search(self, query: str, *, namespace: str | None = None, limit: int = 10) -> dict:
        return self._request(
            "POST",
            "/api/memory/recall",
            {
                "query": query,
                "namespace": namespace or self._namespace,
                "limit": max(1, min(limit, 20)),
            },
            scopes=("memory:read",),
        )

    def _format_results(self, response: dict) -> str:
        results = response.get("results") or response.get("memories") or []
        if not results:
            return "No Zenos Memory results."
        lines = []
        for index, memory in enumerate(results, 1):
            content = memory.get("content") or str(memory)
            memory_type = memory.get("type", "memory")
            confidence = (memory.get("metadata") or {}).get("confidence", "")
            suffix = (
                f" (type={memory_type}, confidence={confidence})"
                if confidence != ""
                else f" (type={memory_type})"
            )
            lines.append(f"{index}. {content}{suffix}")
        return "\n".join(lines)

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Runtime owns automatic current-turn recall; never inject stale next-turn data."""
        return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        return

    def _flush_salience_buffer(self, *, force: bool = False) -> None:
        if not self._secret:
            return
        now = time.monotonic()
        with self._salience_lock:
            if not self._salience_buffer:
                return
            if (
                not force
                and len(self._salience_buffer) < self._salience_batch_size
                and now - self._last_salience_flush < self._salience_flush_seconds
            ):
                return
            batch = self._salience_buffer[:32]
            del self._salience_buffer[:len(batch)]
            self._persist_salience_spool_locked()

        digest = hashlib.sha256("\n".join(
            str(item.get("idempotency_key") or "") for item in batch
        ).encode("utf-8")).hexdigest()
        try:
            self._request(
                "POST",
                "/api/memory/remember-batch",
                {"memories": batch},
                idempotency_key=f"hermes-salience-batch:{digest}",
            )
            self._last_salience_flush = time.monotonic()
        except Exception:
            with self._salience_lock:
                self._salience_buffer = (batch + self._salience_buffer)[:64]
                self._persist_salience_spool_locked()
            logger.debug("Zenos Memory salient batch flush failed", exc_info=True)

    def _queue_salient_memory(self, item: dict) -> None:
        with self._salience_lock:
            if not any(existing.get("idempotency_key") == item.get("idempotency_key") for existing in self._salience_buffer):
                self._salience_buffer.append(item)
                self._persist_salience_spool_locked()
        self._flush_salience_buffer()

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "", messages=None) -> None:
        """Buffer only explicit durable state; MemoryEngine persists it as one bounded batch."""
        if not self._secret or not user_content:
            return
        candidate = self._salient_memory(user_content)
        if candidate is None:
            self._flush_salience_buffer()
            return
        content, memory_type, importance = candidate
        if self._looks_like_credential(content):
            logger.info("Zenos Memory skipped a credential-like turn; store secrets in an external vault")
            return
        active_session = session_id or self._session_id
        digest = hashlib.sha256(
            f"{active_session}\n{memory_type}\n{content}".encode("utf-8")
        ).hexdigest()[:32]
        self._queue_salient_memory({
            "content": content,
            "type": memory_type,
            "namespace": self._namespace,
            "metadata": {
                "source": "hermes-salience-gate-v3-batch",
                "session_id": active_session,
                "confidence": 0.94 if memory_type in {"preference", "decision"} else 0.86,
                "importance": importance,
            },
            "idempotency_key": f"hermes-salience:{digest}",
        })

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "zenos_memory_remember",
                "description": "Store one durable non-secret fact, preference, decision, or task in Zenos Memory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string"},
                        "namespace": {"type": "string"},
                        "type": {
                            "type": "string",
                            "enum": ["fact", "preference", "decision", "event", "relationship", "insight", "file", "task", "project", "user_profile", "conversation", "procedure", "secret_reference", "custom"],
                        },
                        "metadata": {"type": "object"},
                    },
                    "required": ["content"],
                },
            },
            {
                "name": "zenos_memory_search",
                "description": "Search Zenos Memory only when Runtime's bounded automatic recall lacks needed evidence.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "namespace": {"type": "string"},
                        "limit": {"type": "integer"},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "zenos_memory_compact",
                "description": "Create a manual bounded structured continuity checkpoint.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "messages": {"type": "array"},
                        "namespace": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                    "required": ["messages"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        try:
            if tool_name == "zenos_memory_remember":
                content = str(args["content"]).strip()
                if self._looks_like_credential(content):
                    return tool_error("Refusing to store credential-like content; store only a vault reference")
                return json.dumps(
                    self._remember(
                        content,
                        namespace=args.get("namespace"),
                        memory_type=args.get("type", "fact"),
                        metadata=args.get("metadata") or {},
                    ),
                    ensure_ascii=False,
                )
            if tool_name == "zenos_memory_search":
                result = self._search(
                    str(args["query"]),
                    namespace=args.get("namespace"),
                    limit=int(args.get("limit", 8)),
                )
                return json.dumps(
                    {"success": True, "formatted": self._format_results(result), "raw": result},
                    ensure_ascii=False,
                )
            if tool_name == "zenos_memory_compact":
                messages = list(args.get("messages", []))[-80:]
                namespace = args.get("namespace") or self._namespace
                fingerprint = _continuity_fingerprint(messages)
                idempotency_digest = hashlib.sha256(
                    f"{namespace}\n{fingerprint}".encode("utf-8")
                ).hexdigest()
                return json.dumps(
                    self._request(
                        "POST",
                        "/api/memory/compact",
                        {
                            "messages": messages,
                            "namespace": namespace,
                            "reason": args.get("reason", "manual"),
                            "max_chars": 8000,
                            "input_max_chars": 120000,
                            "mode": "dag",
                        },
                        idempotency_key=f"continuity-compact:{idempotency_digest}",
                    ),
                    ensure_ascii=False,
                )
            return tool_error(f"Unknown Zenos Memory tool: {tool_name}")
        except Exception as exc:
            return tool_error(str(exc))

    def _start_background_job(self, target, *, name: str) -> threading.Thread | None:
        if self._shutdown.is_set():
            return None

        def _guarded() -> None:
            try:
                if not self._shutdown.is_set():
                    target()
            finally:
                current = threading.current_thread()
                with self._background_lock:
                    self._background_threads.discard(current)

        thread = threading.Thread(target=_guarded, name=name, daemon=True)
        with self._background_lock:
            if self._shutdown.is_set():
                return None
            self._background_threads.add(thread)
        thread.start()
        return thread

    def _join_background_jobs(self, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            with self._background_lock:
                threads = [
                    thread
                    for thread in self._background_threads
                    if thread.is_alive() and thread is not threading.current_thread()
                ]
            if not threads:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            for thread in threads:
                thread.join(timeout=min(0.25, remaining))

    def shutdown(self) -> None:
        self._shutdown.set()
        self._stop_salience_timer()
        self._flush_salience_buffer(force=True)
        self._join_background_jobs()

    def _salient_memory(self, user_content: str) -> tuple[str, str, int] | None:
        text = re.sub(r"\s+", " ", str(user_content or "")).strip()
        if len(text) < 12 or len(text) > 2_000 or self._looks_like_credential(text):
            return None
        lowered = text.lower()

        explicit_preference = re.search(
            r"\b(aku|gue|saya)\s+(lebih\s+)?(suka|nggak suka|ga suka|gak suka|prefer|maunya)\b"
            r"|\b(panggil aku|panggil gue|jangan pernah|selalu gunakan|always use|i prefer|i like|i dislike)\b",
            lowered,
        )
        explicit_decision = re.search(
            r"\b(kita putuskan|sudah diputuskan|finalnya|tetap pakai|lock keputusan|deal pakai|jadi kita pakai)\b"
            r"|\b(final decision|we decided|keep using)\b",
            lowered,
        )
        durable_task = (
            re.search(r"\b(project|repo|service|deploy|bug|blocker|deadline|todo|milestone)\b", lowered)
            and re.search(r"\b(lanjut|perbaiki|implementasi|selesaikan|target|harus|pending|blocked)\b", lowered)
        )
        stable_correction = (
            re.search(r"\b(maksud gue|maksud aku|koreksi|yang benar|seharusnya)\b", lowered)
            and re.search(r"\b(prefer|project|repo|service|pakai|gunakan|jangan|selalu)\b", lowered)
        )

        if explicit_preference:
            return text, "preference", 9
        if explicit_decision or stable_correction:
            return text, "decision", 9
        if durable_task:
            return text, "task", 8
        return None

    def _looks_like_credential(self, text: str) -> bool:
        if not text or len(text) < 10:
            return False
        patterns = [
            r"sk-[A-Za-z0-9]{20,}",
            r"vcp_[A-Za-z0-9_-]{20,}",
            r"ghp_[A-Za-z0-9]{30,}",
            r"AIza[0-9A-Za-z_-]{35}",
            r"AKIA[0-9A-Z]{16}",
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
            r"\b(?:mnemonic|private[_ -]?key|api[_ -]?key|password|secret|token)\s*[:=]\s*\S+",
            r"\b[A-Fa-f0-9]{64}\b",
        ]
        return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)

    def _start_cloud_compact_job(self, raw_job: dict) -> None:
        fingerprint = str(raw_job.get("fingerprint") or "").strip()
        if not self._secret or not fingerprint:
            return
        with self._compact_lock:
            if fingerprint in self._compact_inflight:
                return
            job = dict(self._compact_jobs.get(fingerprint) or raw_job)
            self._compact_inflight.add(fingerprint)

        def _run() -> None:
            succeeded = False
            try:
                namespace = str(job.get("namespace") or self._namespace)
                generation = int(job.get("generation") or 1)
                idempotency_digest = hashlib.sha256(
                    f"{namespace}\n{fingerprint}".encode("utf-8")
                ).hexdigest()
                result = self._request(
                    "POST",
                    "/api/memory/compact",
                    {
                        "messages": list(job.get("messages") or []),
                        "namespace": namespace,
                        "reason": f"hermes-pre-compress-generation:{generation}",
                        "session_id": str(job.get("session_id") or ""),
                        "approx_tokens": max(1, int(job.get("approx_tokens") or 1)),
                        "max_chars": 8000,
                        "input_max_chars": 120000,
                        "mode": "dag",
                    },
                    idempotency_key=f"continuity-compact:{idempotency_digest}",
                )
                compact_value = result.get("compact")
                compact = (
                    str(compact_value.get("content") or "")
                    if isinstance(compact_value, dict)
                    else str(compact_value or "")
                ).strip()
                coverage = result.get("coverage") or {}
                if not compact or coverage.get("goal") is not True:
                    raise RuntimeError("cloud checkpoint was not goal-complete")
                succeeded = True
                logger.debug(
                    "Async Zenos cloud compact persisted generation=%d fingerprint=%s chars=%d",
                    generation,
                    fingerprint[:12],
                    len(compact),
                )
            except Exception as error:
                logger.warning(
                    "Async Zenos cloud compact failed; durable local spool will retry: %s",
                    error,
                )
                with self._compact_lock:
                    current = dict(self._compact_jobs.get(fingerprint) or job)
                    current["attempts"] = int(current.get("attempts") or 0) + 1
                    current["last_error"] = str(error)[:500]
                    current["last_attempt_at"] = time.time()
                    self._compact_jobs[fingerprint] = current
                    self._persist_compact_spool_locked()
            finally:
                with self._compact_lock:
                    if succeeded:
                        self._compact_jobs.pop(fingerprint, None)
                        self._persist_compact_spool_locked()
                    self._compact_inflight.discard(fingerprint)

        self._start_background_job(
            _run,
            name=f"zenos-memory-compact-{fingerprint[:8]}",
        )

    def _queue_cloud_compact(
        self,
        bounded: list[dict],
        *,
        fingerprint: str,
        approx_tokens: int,
        generation: int,
    ) -> None:
        """Durably spool rich cloud compaction outside Hermes' hot path."""
        if not self._secret:
            return
        job = {
            "fingerprint": fingerprint,
            "messages": [dict(message) for message in bounded],
            "namespace": self._namespace,
            "session_id": self._session_id,
            "approx_tokens": approx_tokens,
            "generation": generation,
            "attempts": 0,
            "created_at": time.time(),
        }
        with self._compact_lock:
            if fingerprint not in self._compact_jobs:
                self._compact_jobs[fingerprint] = job
                self._persist_compact_spool_locked()
            job = dict(self._compact_jobs[fingerprint])
        self._start_cloud_compact_job(job)

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Ask Runtime for the one authoritative checkpoint at compression.

        Runtime owns cursor cooldown, Memory persistence, evidence validation,
        and checkpoint chaining. The provider never writes a second cloud
        compact while that coordinator is enabled. If Runtime is unavailable,
        Hermes still receives a deterministic evidence-ranked recovery brief so
        compression cannot become a terminal failure.
        """
        if not messages:
            return ""
        bounded = _bounded_compact_messages(
            messages,
            max_messages=self._auto_compact_max_messages,
            max_chars=240_000,
        )
        if not bounded:
            return ""
        fingerprint = _continuity_fingerprint(bounded, limit=self._auto_compact_max_messages)
        if fingerprint == self._last_compact_fingerprint:
            return ""
        self._compact_generation += 1
        generation = self._compact_generation
        input_chars = sum(len(str(message.get("content", ""))) for message in bounded)
        approx_tokens = max(1, input_chars // 4)
        deterministic_checkpoint = (
            f"[Zenos pressure generation {generation}; fingerprint={fingerprint[:16]}]\n\n"
            + _deterministic_continuity_checkpoint(bounded, max_chars=7_800)
        )[:8_000]

        if self._secret:
            self._start_background_job(
                lambda: self._flush_salience_buffer(force=True),
                name="zenos-memory-precompress-salience",
            )

        if self._runtime_coordinator_enabled:
            try:
                checkpoint = self._runtime_checkpoint(
                    bounded,
                    fingerprint=fingerprint,
                    approx_tokens=approx_tokens,
                    generation=generation,
                )
                context = str(checkpoint.get("context") or "").strip()
                if not context:
                    raise RuntimeError("Runtime checkpoint returned no recovery context")
                self._last_compact_fingerprint = fingerprint
                return context[:8_000]
            except Exception as error:
                logger.warning(
                    "Runtime continuity coordinator failed; using deterministic recovery brief: %s",
                    error,
                )
                self._last_compact_fingerprint = fingerprint
                return deterministic_checkpoint

        # Explicit rollback mode only. Legacy direct Memory persistence remains
        # available for emergency rollback, but is never active alongside the
        # Runtime coordinator.
        if self._secret:
            self._queue_cloud_compact(
                bounded,
                fingerprint=fingerprint,
                approx_tokens=approx_tokens,
                generation=generation,
            )
        self._last_compact_fingerprint = fingerprint
        return deterministic_checkpoint


def register_memory_provider():
    return ZenosMemoryProvider()
