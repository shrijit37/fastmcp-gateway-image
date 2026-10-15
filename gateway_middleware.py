"""Runtime middleware for the fastmcp-gateway image.

Two ASGI middlewares, loaded through the gateway's own env-driven hook
(``GATEWAY_MIDDLEWARE_MODULE=gateway_middleware:middleware``, allowlisted by
``GATEWAY_ALLOWED_MIDDLEWARE_PREFIXES=gateway_middleware`` — both baked into the
image, both overridable from the compose env):

1. ``BearerAuthMiddleware`` — this endpoint executes every Dokploy tool,
   including the destructive ones, so every route except the liveness probes
   requires ``Authorization: Bearer <GATEWAY_AUTH_TOKEN>``. It fails closed: if
   no token is configured, non-probe routes answer 503 instead of serving
   tools, and the log line says why.
2. ``HealthVersionMiddleware`` — adds ``service``/``version`` to ``/healthz`` so
   a deploy can prove which build is running.
"""

from __future__ import annotations

import json
import logging
import os
import secrets

from starlette.middleware import Middleware

logger = logging.getLogger("fastmcp_gateway.middleware")

# Routes that stay reachable without a token: they are what the deploy gate and
# any external monitor poll, and they expose no tool surface.
_PUBLIC_PATHS = frozenset({"/healthz", "/readyz"})

# Refuse to treat an obviously placeholder/short value as a credential.
_MIN_TOKEN_LENGTH = 16

_AUTH_TOKEN = (os.environ.get("GATEWAY_AUTH_TOKEN") or "").strip()
_TOKEN_CONFIGURED = len(_AUTH_TOKEN) >= _MIN_TOKEN_LENGTH
_VERSION = os.environ.get("APP_VERSION", "dev")
_SERVICE = os.environ.get("GATEWAY_NAME", "fastmcp-gateway")


class BearerAuthMiddleware:
    """Require a shared bearer token on every route except the probes."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") in _PUBLIC_PATHS:
            await self.app(scope, receive, send)
            return

        if not _TOKEN_CONFIGURED:
            # Fail closed. A gateway that silently served tools when its token
            # went missing would be the worst possible failure mode.
            logger.error(
                "GATEWAY_AUTH_TOKEN is unset or shorter than %d characters — refusing to serve %s",
                _MIN_TOKEN_LENGTH,
                scope.get("path"),
            )
            await _respond(
                send,
                503,
                {"error": "auth_not_configured", "detail": "set GATEWAY_AUTH_TOKEN (>=16 chars)"},
            )
            return

        presented = _bearer(scope)
        if presented is None or not secrets.compare_digest(presented, _AUTH_TOKEN):
            logger.warning("rejected unauthenticated request: %s %s", scope.get("method"), scope.get("path"))
            await _respond(send, 401, {"error": "unauthorized"})
            return

        await self.app(scope, receive, send)


class HealthVersionMiddleware:
    """Inject ``service`` and ``version`` into the ``/healthz`` JSON body."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") != "/healthz":
            await self.app(scope, receive, send)
            return

        status = 200
        headers: list[tuple[bytes, bytes]] = []
        body = bytearray()

        async def send_with_version(message):
            nonlocal status, headers, body
            if message["type"] == "http.response.start":
                status = message["status"]
                # Drop content-length: the rewritten body changes its size.
                headers = [(k, v) for k, v in message["headers"] if k.lower() != b"content-length"]
                return
            if message["type"] == "http.response.body":
                body.extend(message.get("body", b""))
                if message.get("more_body"):
                    return
                payload = _rewrite_health(bytes(body))
                headers.append((b"content-length", str(len(payload)).encode()))
                await send({"type": "http.response.start", "status": status, "headers": headers})
                await send({"type": "http.response.body", "body": payload})
                return
            await send(message)

        await self.app(scope, receive, send_with_version)


def _bearer(scope) -> str | None:
    """Return the presented bearer token, if the request carries one."""
    for name, value in scope.get("headers") or ():
        if name.lower() == b"authorization":
            try:
                scheme, _, token = value.decode("latin-1").partition(" ")
            except Exception:
                return None
            if scheme.lower() == "bearer":
                return token.strip()
            return None
    return None


async def _respond(send, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    if status == 401:
        headers.append((b"www-authenticate", b"Bearer"))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


def _rewrite_health(raw: bytes) -> bytes:
    """Return the health body with service/version added, or *raw* unchanged."""
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        return raw
    if not isinstance(payload, dict):
        return raw
    payload["service"] = _SERVICE
    payload["version"] = _VERSION
    return json.dumps(payload).encode()


def middleware() -> list[Middleware]:
    """Entry point referenced by ``GATEWAY_MIDDLEWARE_MODULE``.

    The two middlewares touch disjoint paths (auth owns everything except the
    probes, the health rewrite owns only ``/healthz``), so their relative order
    does not affect behaviour.
    """
    return [Middleware(BearerAuthMiddleware), Middleware(HealthVersionMiddleware)]
