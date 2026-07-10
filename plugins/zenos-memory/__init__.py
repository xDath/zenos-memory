"""Zenos Memory provider for Hermes.

This provider makes the deployed Zenos Memory service the default external
memory backend. It uses Etla HMAC signatures, so the raw secret is never sent.
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
from typing import Any, Dict, List
from urllib import request as urllib_request
from urllib.parse import quote as _urlquote
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
        "prefetch_limit": int(os.environ.get("ZENOS_MEMORY_PREFETCH_LIMIT", "5")),
        "auto_compact_every": int(os.environ.get("ZENOS_MEMORY_AUTO_COMPACT_EVERY", "10")),
        "auto_compact_min_chars": int(os.environ.get("ZENOS_MEMORY_AUTO_COMPACT_MIN_CHARS", "6000")),
        "auto_compact_max_messages": int(os.environ.get("ZENOS_MEMORY_AUTO_COMPACT_MAX_MESSAGES", "80")),
    }
    path = get_hermes_home() / "zenos-memory.json"
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            cfg.update({k: v for k, v in data.items() if v not in (None, "")})
        except Exception:
            logger.exception("Failed to load zenos-memory.json")
    return cfg


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
        self._prefetch_limit = 5
        self._auto_compact_every = 10
        self._auto_compact_min_chars = 6000
        self._auto_compact_max_messages = 80
        self._prefetch_result = ""
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: threading.Thread | None = None
        self._sync_thread: threading.Thread | None = None
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
            {"key": "secret", "description": "Etla master secret for HMAC signing", "secret": True, "required": True, "env_var": "ETLA_MASTER_SECRET"},
            {"key": "namespace", "description": "Default namespace", "default": DEFAULT_NAMESPACE},
        ]

    def initialize(self, session_id: str, **kwargs) -> None:
        self._cfg = _load_config()
        self._base_url = str(self._cfg.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
        self._secret = str(self._cfg.get("secret") or "")
        self._namespace = str(self._cfg.get("namespace") or DEFAULT_NAMESPACE)
        self._prefetch_limit = int(self._cfg.get("prefetch_limit") or 5)
        self._auto_compact_every = int(self._cfg.get("auto_compact_every") or 10)
        self._auto_compact_min_chars = int(self._cfg.get("auto_compact_min_chars") or 6000)
        self._auto_compact_max_messages = int(self._cfg.get("auto_compact_max_messages") or 80)
        self._turn_count = 0
        self._auto_bootstrap()

    def system_prompt_block(self) -> str:
        return (
            "# Zenos Memory\n"
            "Active as the durable context continuity backend. "
            "Use zenos_memory_search for relevant recall and zenos_memory_remember for durable, non-secret facts. "
            "Raw credentials are never stored; use an external vault and remember only vault references."
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
                with urllib_request.urlopen(req, timeout=20) as resp:
                    payload = json.loads(resp.read().decode("utf-8") or "{}")
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

    def _request(self, method: str, path: str, body: dict | None = None, scopes: tuple[str, ...] | None = None) -> dict:
        method = method.upper()
        required = scopes or (("memory:read",) if method in ("GET", "HEAD") else ("memory:read", "memory:write"))
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "Authorization": f"Bearer {self._token(required)}",
            "Accept": "application/json",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib_request.Request(self._base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib_request.urlopen(req, timeout=20) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except HTTPError as exc:
            if exc.code == 401:
                with self._token_lock:
                    self._token_cache.clear()
            raise RuntimeError(f"Zenos request failed with HTTP {exc.code}") from exc
        except URLError as exc:
            raise RuntimeError("Zenos Memory is unreachable") from exc

    def _request_text(self, method: str, path: str, body: dict | None = None) -> str:
        method = method.upper()
        required = ("memory:read",) if method in ("GET", "HEAD") else ("memory:read", "memory:write")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": f"Bearer {self._token(required)}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib_request.Request(self._base_url + path, data=data, headers=headers, method=method)
        with urllib_request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8")

    def _remember(self, content: str, *, namespace: str | None = None, memory_type: str = "fact", metadata: dict | None = None) -> dict:
        return self._request("POST", "/api/memory/remember", {
            "content": content,
            "type": memory_type,
            "namespace": namespace or self._namespace,
            "metadata": metadata or {},
        })

    def _search(self, query: str, *, namespace: str | None = None, limit: int = 10) -> dict:
        return self._request("POST", "/api/memory/recall", {
            "query": query,
            "namespace": namespace or self._namespace,
            "limit": max(1, min(limit, 50)),
        })

    def _format_results(self, response: dict) -> str:
        results = response.get("results") or response.get("memories") or []
        if not results:
            return "No Zenos Memory results."
        lines = []
        for i, m in enumerate(results, 1):
            content = m.get("content") or str(m)
            mtype = m.get("type", "memory")
            conf = (m.get("metadata") or {}).get("confidence", "")
            suffix = f" (type={mtype}, confidence={conf})" if conf != "" else f" (type={mtype})"
            lines.append(f"{i}. {content}{suffix}")
        return "\n".join(lines)

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=2.0)
        with self._prefetch_lock:
            result = self._prefetch_result
            self._prefetch_result = ""
        return result

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if not query or not self._secret:
            return
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            return

        def worker():
            try:
                res = self._search(query, limit=self._prefetch_limit)
                formatted = self._format_results(res)
                if formatted and not formatted.startswith("No Zenos"):
                    formatted = "# Zenos Memory Recall\n" + formatted
                else:
                    formatted = ""
                with self._prefetch_lock:
                    self._prefetch_result = formatted
            except Exception:
                logger.debug("Zenos Memory prefetch failed", exc_info=True)

        self._prefetch_thread = threading.Thread(target=worker, daemon=True)
        self._prefetch_thread.start()

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "", messages=None) -> None:
        if not self._secret or not user_content:
            return
        if self._sync_thread and self._sync_thread.is_alive():
            return

        def worker():
            try:
                text = f"User: {user_content}\nAssistant: {assistant_content[:1500]}"
                if self._looks_like_credential(text):
                    logger.info("Zenos Memory skipped a credential-like turn; store secrets in an external vault")
                    return
                self._remember(text, memory_type="conversation", metadata={"source": "turn", "session_id": session_id})
            except Exception:
                logger.debug("Zenos Memory sync failed", exc_info=True)

        self._turn_count += 1
        if self._should_auto_compact(user_content, assistant_content, messages):
            self._auto_compact(user_content, assistant_content, session_id, messages=messages)
        self._sync_thread = threading.Thread(target=worker, daemon=True)
        self._sync_thread.start()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "zenos_memory_remember",
                "description": "Store a durable memory in Zenos Memory (default replacement for Mem0/Memanto).",
                "parameters": {"type": "object", "properties": {"content": {"type": "string"}, "namespace": {"type": "string"}, "type": {"type": "string"}, "metadata": {"type": "object"}}, "required": ["content"]},
            },
            {
                "name": "zenos_memory_search",
                "description": "Search Zenos Memory semantically/keyword by query.",
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "namespace": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]},
            },
            {
                "name": "zenos_memory_compact",
                "description": "Trigger advanced LLM-powered compact for structured handoff.",
                "parameters": {"type": "object", "properties": {"messages": {"type": "array"}, "namespace": {"type": "string"}, "reason": {"type": "string"}}, "required": ["messages"]},
            },
            {
                "name": "zenos_memory_bootstrap",
                "description": "Bootstrap from latest compact for context recovery.",
                "parameters": {"type": "object", "properties": {"namespace": {"type": "string"}}, "required": []},
            },
            {
                "name": "zenos_memory_graph_query",
                "description": "Query the temporal graph with vector + graph traversal.",
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "namespace": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]},
            },
            {
                "name": "zenos_memory_mermaid",
                "description": "Get Mermaid graph visualization text for the memory graph.",
                "parameters": {"type": "object", "properties": {"namespace": {"type": "string"}}, "required": []},
            },
            {
                "name": "zenos_memory_dashboard",
                "description": "Get a dashboard summary of memory health, graph stats, eval readiness and recommendations.",
                "parameters": {"type": "object", "properties": {"namespace": {"type": "string"}}, "required": []},
            },
            {
                "name": "zenos_memory_report",
                "description": "Get a Zenos Memory daily intelligence report for a namespace.",
                "parameters": {"type": "object", "properties": {"namespace": {"type": "string"}}, "required": []},
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        try:
            if tool_name == "zenos_memory_remember":
                return json.dumps(self._remember(args["content"], namespace=args.get("namespace"), memory_type=args.get("type", "fact"), metadata=args.get("metadata") or {}), ensure_ascii=False)
            if tool_name == "zenos_memory_search":
                res = self._search(args["query"], namespace=args.get("namespace"), limit=int(args.get("limit", 10)))
                return json.dumps({"success": True, "formatted": self._format_results(res), "raw": res}, ensure_ascii=False)
            if tool_name == "zenos_memory_compact":
                return json.dumps(self._request("POST", "/api/memory/compact", {
                    "messages": args.get("messages", []),
                    "namespace": args.get("namespace"),
                    "reason": args.get("reason", "manual")
                }), ensure_ascii=False)
            if tool_name == "zenos_memory_bootstrap":
                ns = args.get("namespace") or self._namespace
                return json.dumps(self._request("POST", "/api/memory/bootstrap", {"namespace": ns}), ensure_ascii=False)
            if tool_name == "zenos_memory_report":
                ns = args.get("namespace") or self._namespace
                return json.dumps(self._request("GET", "/api/memory/daily-report?namespace=" + _urlquote(ns)), ensure_ascii=False)
            if tool_name == "zenos_memory_graph_query":
                ns = args.get("namespace") or self._namespace
                return json.dumps(self._request("POST", "/api/memory/graph-query", {"namespace": ns, "query": args.get("query", ""), "limit": int(args.get("limit", 10))}), ensure_ascii=False)
            if tool_name == "zenos_memory_dashboard":
                ns = args.get("namespace") or self._namespace
                return json.dumps(self._request("GET", "/api/memory/dashboard?namespace=" + _urlquote(ns)), ensure_ascii=False)
            if tool_name == "zenos_memory_mermaid":
                ns = args.get("namespace") or self._namespace
                return json.dumps({"success": True, "mermaid": self._request_text("GET", "/api/memory/graph-mermaid?namespace=" + _urlquote(ns))}, ensure_ascii=False)
            return tool_error(f"Unknown Zenos Memory tool: {tool_name}")
        except Exception as e:
            return tool_error(str(e))

    def shutdown(self) -> None:
        for t in (self._prefetch_thread, self._sync_thread):
            if t and t.is_alive():
                t.join(timeout=2.0)




    def _looks_like_credential(self, text: str) -> bool:
        if not text or len(text) < 10:
            return False
        patterns = [
            r"sk-[A-Za-z0-9]{20,}",
            r"vcp_[A-Za-z0-9_-]{20,}",
            r"ghp_[A-Za-z0-9]{30,}",
            r"AIza[0-9A-Za-z_-]{35}",
            r"AKIA[0-9A-Z]{16}",
            r"[A-Za-z0-9]{32,}",
        ]
        for p in patterns:
            if re.search(p, text):
                return True
        return False

    def _auto_bootstrap(self):
        try:
            res = self._request("POST", "/api/memory/bootstrap", {
                "namespace": self._namespace,
                "limit": self._prefetch_limit
            })
            bootstrap = res.get("bootstrap", "")
            if bootstrap:
                with self._prefetch_lock:
                    self._prefetch_result = "# Zenos Memory Bootstrap (auto)\n" + bootstrap
        except Exception:
            logger.debug("Zenos auto bootstrap failed", exc_info=True)

    def _should_auto_compact(self, user_content: str, assistant_content: str, messages=None) -> bool:
        total_chars = len(user_content or "") + len(assistant_content or "")
        if messages:
            total_chars = sum(len(str(m.get("content", ""))) for m in messages[-self._auto_compact_max_messages:])
        periodic = self._auto_compact_every > 0 and self._turn_count % self._auto_compact_every == 0
        return periodic or total_chars >= self._auto_compact_min_chars

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        if not self._secret or not messages:
            return ""
        try:
            res = self._request("POST", "/api/memory/compact", {
                "messages": messages[-self._auto_compact_max_messages:],
                "namespace": self._namespace,
                "reason": "hermes-pre-compress",
                "approx_tokens": sum(len(str(m.get("content", ""))) for m in messages),
            })
            compact = res.get("compact") or res.get("summary") or res.get("handoff") or res.get("bootstrap") or ""
            if compact:
                return "Zenos Memory compact preserved before compression:\n" + str(compact)
        except Exception:
            logger.debug("Zenos pre-compress compact failed", exc_info=True)
        return ""

    def _auto_compact(self, user_content: str, assistant_content: str, session_id: str = "", messages=None):
        try:
            compact_messages = messages[-self._auto_compact_max_messages:] if messages else [
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": assistant_content[:4000]}
            ]
            self._request("POST", "/api/memory/compact", {
                "messages": compact_messages,
                "namespace": self._namespace,
                "reason": "auto-compact",
                "session_id": session_id,
                "approx_tokens": sum(len(str(m.get("content", ""))) for m in compact_messages)
            })
        except Exception:
            logger.debug("Zenos auto compact failed", exc_info=True)


def register_memory_provider():
    return ZenosMemoryProvider()
