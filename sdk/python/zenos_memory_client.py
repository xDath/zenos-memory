"""Dependency-free Python client for Zenos Memory 1.x."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable


class ZenosMemoryError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, code: str | None = None, request_id: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id


class ZenosMemoryClient:
    def __init__(
        self,
        base_url: str | None = None,
        secret: str | None = None,
        namespace: str | None = None,
        client_id: str = "zenos-python-sdk",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = (base_url or os.environ.get("ZENOS_MEMORY_URL") or "https://zenos-memory.vercel.app").rstrip("/")
        self.secret = secret or os.environ.get("ETLA_MASTER_SECRET") or os.environ.get("ZENOS_MEMORY_SECRET")
        if not self.secret:
            raise ValueError("ZenosMemoryClient requires ETLA_MASTER_SECRET or ZENOS_MEMORY_SECRET")
        self.namespace = namespace or os.environ.get("ZENOS_MEMORY_NAMESPACE") or "zenos"
        self.client_id = client_id
        self.timeout = timeout
        self._tokens: dict[str, tuple[str, float]] = {}

    @staticmethod
    def _body_hash(body: bytes = b"") -> str:
        return hashlib.sha256(body).hexdigest()

    def _exchange_headers(self, scopes: Iterable[str]) -> dict[str, str]:
        timestamp = int(time.time() * 1000)
        nonce = secrets.token_urlsafe(18)
        body_hash = self._body_hash()
        canonical = "\n".join([
            "zenos-memory-signature-v2",
            str(timestamp),
            nonce,
            "POST",
            "/api/auth",
            body_hash,
        ])
        signature = hmac.new(self.secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
        return {
            "x-etla-timestamp": str(timestamp),
            "x-etla-nonce": nonce,
            "x-etla-content-sha256": body_hash,
            "x-etla-signature": signature,
            "x-etla-client-id": self.client_id,
            "x-etla-requested-scopes": " ".join(scopes),
            "content-type": "application/json",
        }

    def _decode(self, response: Any) -> dict[str, Any]:
        raw = response.read().decode("utf-8")
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ZenosMemoryError("Zenos returned a non-JSON response", status=getattr(response, "status", None)) from exc
        if not isinstance(data, dict):
            raise ZenosMemoryError("Zenos returned an invalid response envelope", status=getattr(response, "status", None))
        return data

    def _open(self, request: urllib.request.Request) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return self._decode(response)
        except urllib.error.HTTPError as exc:
            try:
                data = self._decode(exc)
            except Exception:
                data = {}
            error = data.get("error") if isinstance(data, dict) else None
            if isinstance(error, dict):
                message = str(error.get("message") or f"HTTP {exc.code}")
                code = str(error.get("code")) if error.get("code") else None
            else:
                message = str(error or f"HTTP {exc.code}")
                code = None
            raise ZenosMemoryError(
                message,
                status=exc.code,
                code=code,
                request_id=data.get("request_id") if isinstance(data, dict) else None,
            ) from exc
        except urllib.error.URLError as exc:
            raise ZenosMemoryError("Unable to reach Zenos Memory") from exc

    def token(self, scopes: tuple[str, ...] = ("memory:read", "memory:write")) -> str:
        key = " ".join(sorted(scopes))
        cached = self._tokens.get(key)
        if cached and time.time() < cached[1] - 30:
            return cached[0]
        request = urllib.request.Request(
            self.base_url + "/api/auth",
            headers=self._exchange_headers(scopes),
            method="POST",
        )
        data = self._open(request)
        token = data.get("token")
        if not isinstance(token, str):
            raise ZenosMemoryError("Zenos token exchange returned no token")
        expires_in = int(data.get("expires_in") or 900)
        self._tokens[key] = (token, time.time() + expires_in)
        return token

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        scopes: tuple[str, ...] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        method = method.upper()
        required = scopes or (("memory:read",) if method in {"GET", "HEAD"} else ("memory:read", "memory:write"))
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "authorization": f"Bearer {self.token(required)}",
            "accept": "application/json",
        }
        if payload is not None:
            headers["content-type"] = "application/json"
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        request = urllib.request.Request(self.base_url + path, data=payload, headers=headers, method=method)
        try:
            return self._open(request)
        except ZenosMemoryError as exc:
            if exc.status == 401:
                self._tokens.clear()
            raise

    def remember(self, content: str, *, memory_type: str | None = None, namespace: str | None = None, metadata: dict[str, Any] | None = None, idempotency_key: str | None = None) -> dict[str, Any]:
        return self.request("POST", "/api/memory/remember", {
            "content": content,
            "type": memory_type,
            "namespace": namespace or self.namespace,
            "metadata": metadata or {},
        }, idempotency_key=idempotency_key)

    def recall(self, query: str, *, namespace: str | None = None, limit: int = 10, memory_type: str | None = None, tags: list[str] | None = None) -> dict[str, Any]:
        return self.request("POST", "/api/memory/hybrid-recall", {
            "query": query,
            "namespace": namespace or self.namespace,
            "limit": limit,
            "type": memory_type,
            "tags": tags,
        }, scopes=("memory:read",))

    def edit(self, memory_id: str, updates: dict[str, Any], *, namespace: str | None = None, expected_version: int | None = None) -> dict[str, Any]:
        return self.request("PATCH", "/api/memory/edit", {
            "id": memory_id,
            **updates,
            "namespace": namespace or self.namespace,
            "expected_version": expected_version,
        })

    def forget(self, memory_id: str, *, namespace: str | None = None, expected_version: int | None = None, hard_delete: bool = False) -> dict[str, Any]:
        return self.request("DELETE", "/api/memory/forget", {
            "id": memory_id,
            "namespace": namespace or self.namespace,
            "expected_version": expected_version,
            "hard_delete": hard_delete,
        })

    def compact(self, messages: list[dict[str, Any]], *, namespace: str | None = None, reason: str = "sdk", idempotency_key: str | None = None) -> dict[str, Any]:
        return self.request("POST", "/api/memory/compact", {
            "messages": messages,
            "namespace": namespace or self.namespace,
            "reason": reason,
        }, idempotency_key=idempotency_key)

    def bootstrap(self, *, namespace: str | None = None, queries: list[str] | None = None, limit: int | None = None) -> dict[str, Any]:
        return self.request("POST", "/api/memory/bootstrap", {
            "namespace": namespace or self.namespace,
            "queries": queries,
            "limit": limit,
        }, scopes=("memory:read",))

    def stats(self, *, namespace: str | None = None) -> dict[str, Any]:
        query = urllib.parse.urlencode({"namespace": namespace or self.namespace})
        return self.request("GET", f"/api/memory/stats?{query}", scopes=("memory:read",))

    def backup(self, *, namespace: str | None = None) -> dict[str, Any]:
        return self.request("POST", "/api/memory/backup", {"namespace": namespace}, scopes=("memory:admin",))

    def restore(self, snapshot: dict[str, Any], *, mode: str = "merge", namespace: str | None = None) -> dict[str, Any]:
        return self.request("POST", "/api/memory/restore", {
            "snapshot": snapshot,
            "mode": mode,
            "namespace": namespace,
        }, scopes=("memory:admin",))

    def acquire_lease(self, resource: str, owner: str, *, namespace: str | None = None, ttl_ms: int = 30_000) -> dict[str, Any]:
        return self.request("POST", "/api/memory/lock", {
            "action": "acquire",
            "resource": resource,
            "owner": owner,
            "namespace": namespace or self.namespace,
            "ttl_ms": ttl_ms,
        }, scopes=("memory:admin",))

    def release_lease(self, token: str, owner: str) -> dict[str, Any]:
        return self.request("POST", "/api/memory/lock", {
            "action": "release",
            "token": token,
            "owner": owner,
        }, scopes=("memory:admin",))
