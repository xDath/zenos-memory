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
DEFAULT_NAMESPACE = "zenos"


def _load_config() -> dict:
    from hermes_constants import get_hermes_home

    cfg = {
        "base_url": os.environ.get("ZENOS_MEMORY_URL", DEFAULT_BASE_URL),
        "secret": os.environ.get("ETLA_MASTER_SECRET", ""),
        "namespace": os.environ.get("ZENOS_MEMORY_NAMESPACE", DEFAULT_NAMESPACE),
        "auto_compact_max_messages": int(os.environ.get("ZENOS_MEMORY_AUTO_COMPACT_MAX_MESSAGES", "80")),
        "salience_batch_size": int(os.environ.get("ZENOS_MEMORY_SALIENCE_BATCH_SIZE", "4")),
        "salience_flush_seconds": int(os.environ.get("ZENOS_MEMORY_SALIENCE_FLUSH_SECONDS", "30")),
        "salience_spool_path": os.environ.get(
            "ZENOS_MEMORY_SALIENCE_SPOOL_PATH",
            str(get_hermes_home() / "state" / "zenos-memory-salience-spool.json"),
        ),
    }
    path = get_hermes_home() / "zenos-memory.json"
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            cfg.update({key: value for key, value in data.items() if value not in (None, "")})
        except Exception:
            logger.exception("Failed to load zenos-memory.json")
    return cfg


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


def _continuity_fingerprint(messages: list[dict], limit: int = 80) -> str:
    bounded = messages[-max(1, min(limit, 80)):]
    rendered = "\n---\n".join(
        f"{str(message.get('role') or '').strip().lower()}\n{_stable_message_content(message.get('content'))}"
        for message in bounded
    )
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def _token_exchange_headers(secret: str, scopes: list[str], client_id: str = "hermes-zenos-memory") -> dict:
    timestamp = int(time.time() * 1000)
    nonce = secrets.token_urlsafe(18)
    body_hash = hashlib.sha256(b"").hexdigest()
    canonical = "\n".join([
        "zenos-memory-signature-v2",
        str(timestamp),
        nonce,
        "POST",
        "/api/auth",
        body_hash,
    ])
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {
        "x-etla-timestamp": str(timestamp),
        "x-etla-nonce": nonce,
        "x-etla-content-sha256": body_hash,
        "x-etla-signature": signature,
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
        self._auto_compact_max_messages = 80
        self._last_compact_message_count = 0
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
                "env_var": "ETLA_MASTER_SECRET",
            },
            {"key": "namespace", "description": "Default namespace", "default": DEFAULT_NAMESPACE},
        ]

    def initialize(self, session_id: str, **kwargs) -> None:
        self._stop_salience_timer()
        self._cfg = _load_config()
        self._base_url = str(self._cfg.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
        self._secret = str(self._cfg.get("secret") or "")
        self._namespace = str(self._cfg.get("namespace") or DEFAULT_NAMESPACE)
        self._session_id = str(session_id or "")
        self._auto_compact_max_messages = max(
            20,
            min(int(self._cfg.get("auto_compact_max_messages") or 80), 160),
        )
        self._salience_batch_size = max(2, min(int(self._cfg.get("salience_batch_size") or 4), 8))
        self._salience_flush_seconds = max(5, min(int(self._cfg.get("salience_flush_seconds") or 30), 300))
        self._salience_spool_path = Path(str(self._cfg.get("salience_spool_path") or "zenos-memory-salience-spool.json"))
        with self._salience_lock:
            self._salience_buffer = self._load_salience_spool()
        self._last_salience_flush = time.monotonic()
        self._last_compact_message_count = 0
        self._start_salience_timer()

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

    def _salience_timer_loop(self) -> None:
        while not self._salience_stop.wait(self._salience_flush_seconds):
            self._flush_salience_buffer(force=True)

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

    def shutdown(self) -> None:
        self._stop_salience_timer()
        self._flush_salience_buffer(force=True)

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

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Create one shared idempotent, coverage-checked checkpoint per compression window."""
        self._flush_salience_buffer(force=True)
        if not self._secret or not messages:
            return ""
        message_count = len(messages)
        if self._last_compact_message_count and message_count - self._last_compact_message_count < 12:
            return ""
        bounded = messages[-min(self._auto_compact_max_messages, 80):]
        input_chars = sum(len(str(message.get("content", ""))) for message in bounded)
        approx_tokens = max(1, input_chars // 4)
        if approx_tokens < 12_000:
            return ""

        fingerprint = _continuity_fingerprint(bounded)
        idempotency_digest = hashlib.sha256(
            f"{self._namespace}\n{fingerprint}".encode("utf-8")
        ).hexdigest()
        try:
            result = self._request(
                "POST",
                "/api/memory/compact",
                {
                    "messages": bounded,
                    "namespace": self._namespace,
                    "reason": "hermes-pre-compress",
                    "session_id": self._session_id,
                    "approx_tokens": approx_tokens,
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
                logger.warning("Zenos compact rejected: missing durable goal coverage")
                return ""
            if len(compact) > min(8000, max(2000, int(input_chars * 0.35))):
                logger.warning("Zenos compact rejected: insufficient reduction ratio")
                return ""
            self._last_compact_message_count = message_count
            return "Zenos Memory checkpoint preserved before compression:\n" + compact
        except Exception:
            logger.debug("Zenos pre-compress compact failed", exc_info=True)
        return ""


def register_memory_provider():
    return ZenosMemoryProvider()
