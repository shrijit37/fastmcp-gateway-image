"""Health-version ASGI middleware for the fastmcp-gateway image.

The gateway's own ``/healthz`` returns a hardcoded ``{"status": "ok"}`` — no
build identity, so a deploy cannot prove which SHA is running. This middleware
rewrites just that route to add ``service`` and ``version`` (from the
``APP_VERSION`` build arg) and leaves every other request untouched.

Loaded by the gateway via ``GATEWAY_MIDDLEWARE_MODULE=health_version:middleware``
plus the matching ``GATEWAY_ALLOWED_MIDDLEWARE_PREFIXES=health_version``
allowlist entry (both baked into the image, both overridable from the Dokploy
app env).
"""

from __future__ import annotations

import json
import os

from starlette.middleware import Middleware

# Resolved once at import: the gateway loads this module during startup, so a
# container's reported version is fixed for its lifetime — exactly what a
# deploy gate needs.
_VERSION = os.environ.get("APP_VERSION", "dev")
_SERVICE = os.environ.get("GATEWAY_NAME", "fastmcp-gateway")

# Only this exact path is rewritten. ``/readyz`` and every MCP route keep
# their existing bytes and streaming behaviour.
_REWRITE_PATH = "/healthz"


class HealthVersionMiddleware:
    """Inject ``service`` and ``version`` into the ``/healthz`` JSON body."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") != _REWRITE_PATH:
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
                payload = _rewrite(bytes(body))
                headers.append((b"content-length", str(len(payload)).encode()))
                await send({"type": "http.response.start", "status": status, "headers": headers})
                await send({"type": "http.response.body", "body": payload})
                return
            await send(message)

        await self.app(scope, receive, send_with_version)


def _rewrite(raw: bytes) -> bytes:
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
    """Entry point referenced by ``GATEWAY_MIDDLEWARE_MODULE``."""
    return [Middleware(HealthVersionMiddleware)]
