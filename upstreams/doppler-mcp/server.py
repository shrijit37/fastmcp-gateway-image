#!/usr/bin/env python3
"""Vendored first-party Doppler upstream for the MCP gateway (stdio).

Read-only wrapper over Doppler's public REST API v3 (``https://api.doppler.com``).
It exists because the official ``npx @dopplerhq/mcp-server`` cannot be registered
behind this gateway: its OpenAPI-derived tool schemas declare
``additionalProperties: true`` at the root, which
``fastmcp_gateway.sanitize.validate_input_schema`` rejects — deliberately, since
an open root schema lets an upstream smuggle unvalidated keys into the
``execute_tool`` forwarded call. 12 of that server's 13 tools are dropped by the
registry for this reason, so the surface is re-implemented here with every
schema closed (explicit ``properties`` + ``required``, never an open root).

Auth is a Doppler service token (``dp.st.…``) in ``DOPPLER_TOKEN``, read from the
environment at call time and never echoed — not in tool output, not in error
text. A read-only, config-scoped token means only the config's own secrets are
readable; every tool here is a GET.

Defaults: ``project`` and ``config`` arguments fall back to ``DOPPLER_PROJECT``
and ``DOPPLER_CONFIG``. When neither the argument nor the environment variable is
available the tool fails with a message naming what is missing, rather than
guessing a config.

Transport: MCP stdio. Only JSON-RPC goes to stdout; diagnostics go to stderr.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

import anyio
import mcp.types as types
from mcp.server import Server
from mcp.server.stdio import stdio_server

API_BASE = (os.environ.get("DOPPLER_API_BASE") or "https://api.doppler.com").rstrip("/")
HTTP_TIMEOUT = float(os.environ.get("DOPPLER_HTTP_TIMEOUT") or 30)


class DopplerError(RuntimeError):
    """A failure whose text is safe to show the calling model.

    Neither construction path can carry the token: the token is only ever put in
    the ``Authorization`` header, and :func:`_scrub` redacts it defensively.
    """


def _scrub(text: str) -> str:
    token = (os.environ.get("DOPPLER_TOKEN") or "").strip()
    return text.replace(token, "[redacted]") if token else text


def _token() -> str:
    token = (os.environ.get("DOPPLER_TOKEN") or "").strip()
    if not token:
        raise DopplerError(
            "DOPPLER_TOKEN is unset: put the read-only Doppler service token in "
            "this upstream's env block in GATEWAY_UPSTREAMS. Refusing to call the "
            "API without credentials."
        )
    return token


def _doppler_messages(exc: urllib.error.HTTPError) -> str:
    """Render Doppler's ``{"messages": [...]}`` error body, if there is one."""
    try:
        payload = json.loads(exc.read())
    except Exception:  # pragma: no cover - non-JSON or unreadable body
        return ""
    if isinstance(payload, dict):
        messages = payload.get("messages")
        if isinstance(messages, list) and messages:
            return " — " + "; ".join(str(m) for m in messages)
    return ""


def _request(path: str, params: dict[str, str]) -> Any:
    """GET *path* on the Doppler API and return the decoded JSON body."""
    url = API_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {_token()}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise DopplerError(
            _scrub(f"Doppler API {exc.code} {exc.reason} for {path}{_doppler_messages(exc)}")
        ) from None
    except urllib.error.URLError as exc:
        raise DopplerError(f"Doppler API unreachable for {path}: {exc.reason}") from None

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise DopplerError(f"Doppler API returned non-JSON for {path}: {exc}") from None


def _clean(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    return value.strip()


def _project_and_config(arguments: dict[str, Any], *, config_required: bool) -> tuple[str, str]:
    project = _clean(arguments.get("project")) or _clean(os.environ.get("DOPPLER_PROJECT"))
    if not project:
        raise DopplerError(
            "no project given: pass 'project' or set DOPPLER_PROJECT in this "
            "upstream's env block"
        )
    if not config_required:
        return project, ""
    config = _clean(arguments.get("config")) or _clean(os.environ.get("DOPPLER_CONFIG"))
    if not config:
        raise DopplerError(
            "no config given: pass 'config' or set DOPPLER_CONFIG in this "
            "upstream's env block"
        )
    return project, config


# --------------------------------------------------------------------------- #
# Tools
# --------------------------------------------------------------------------- #


def _list_projects(arguments: dict[str, Any]) -> Any:
    return _request("/v3/projects", {})


def _list_configs(arguments: dict[str, Any]) -> Any:
    project, _ = _project_and_config(arguments, config_required=False)
    return _request("/v3/configs", {"project": project})


def _get_config(arguments: dict[str, Any]) -> Any:
    project, config = _project_and_config(arguments, config_required=True)
    return _request("/v3/configs/config", {"project": project, "config": config})


def _list_secrets(arguments: dict[str, Any]) -> Any:
    project, config = _project_and_config(arguments, config_required=True)
    payload = _request(
        "/v3/configs/config/secrets/names", {"project": project, "config": config}
    )
    names = payload.get("names") if isinstance(payload, dict) else None
    return {
        "project": project,
        "config": config,
        "names": names if isinstance(names, list) else [],
    }


def _get_secret(arguments: dict[str, Any]) -> Any:
    name = _clean(arguments.get("name"))
    if not name:
        raise DopplerError("'name' is required: name the secret key to read")
    project, config = _project_and_config(arguments, config_required=True)
    payload = _request(
        "/v3/configs/config/secret",
        {"project": project, "config": config, "name": name},
    )
    value = payload.get("value") if isinstance(payload, dict) else None
    computed = value.get("computed") if isinstance(value, dict) else None
    if not isinstance(computed, str):
        raise DopplerError(f"Doppler returned no computed value for secret {name!r}")
    return {"project": project, "config": config, "name": name, "value": computed}


def _download_secrets(arguments: dict[str, Any]) -> Any:
    project, config = _project_and_config(arguments, config_required=True)
    payload = _request(
        "/v3/configs/config/secrets/download",
        {"project": project, "config": config, "format": "json"},
    )
    if not isinstance(payload, dict):
        raise DopplerError("Doppler returned a non-object secrets download")
    return {"project": project, "config": config, "secrets": payload}


_PROJECT = {
    "type": "string",
    "description": "Doppler project name. Defaults to the DOPPLER_PROJECT env var.",
}
_CONFIG = {
    "type": "string",
    "description": "Doppler config (environment) name. Defaults to the DOPPLER_CONFIG env var.",
}
_NAME = {"type": "string", "description": "Secret key name, e.g. DATABASE_URL."}


def _schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    """A closed object schema: explicit properties, explicit required, no open root."""
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


TOOLS: list[types.Tool] = [
    types.Tool(
        name="list-projects",
        description=(
            "List every Doppler project this token can see. Takes no arguments; "
            "use it as the entry point when you do not know project names yet."
        ),
        inputSchema=_schema({}, []),
    ),
    types.Tool(
        name="list-configs",
        description=(
            "List the configs (environments) of one Doppler project. Only the "
            "project's configs that this token can read are returned."
        ),
        inputSchema=_schema({"project": _PROJECT}, []),
    ),
    types.Tool(
        name="get-config",
        description=(
            "Get one Doppler config's metadata: name, environment, created date, "
            "inheritance and read-lock state. Does not return secret values."
        ),
        inputSchema=_schema({"project": _PROJECT, "config": _CONFIG}, []),
    ),
    types.Tool(
        name="list-secrets",
        description=(
            "List the secret NAMES of a Doppler config. Names only, no values, so "
            "this is always safe to call; use get-secret for a single value."
        ),
        inputSchema=_schema({"project": _PROJECT, "config": _CONFIG}, []),
    ),
    types.Tool(
        name="get-secret",
        description=(
            "Read one secret's computed value from a Doppler config. The value is "
            "returned into the caller's context."
        ),
        inputSchema=_schema({"name": _NAME, "project": _PROJECT, "config": _CONFIG}, ["name"]),
    ),
    types.Tool(
        name="download-secrets",
        description=(
            "Download every key/value pair of a Doppler config at once — the escape "
            "hatch for a whole-config refactor or a rotation checklist. Every value "
            "lands in the caller's context, so prefer list-secrets plus get-secret "
            "when you need one or two keys."
        ),
        inputSchema=_schema({"project": _PROJECT, "config": _CONFIG}, []),
    ),
]

_HANDLERS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "list-projects": _list_projects,
    "list-configs": _list_configs,
    "get-config": _get_config,
    "list-secrets": _list_secrets,
    "get-secret": _get_secret,
    "download-secrets": _download_secrets,
}


def _dump(payload: Any) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False)


async def dispatch(name: str, arguments: dict[str, Any] | None) -> list[types.TextContent]:
    """Run one tool by name. The single entry point the MCP handler delegates to."""
    handler = _HANDLERS.get(name)
    if handler is None:
        raise DopplerError(f"unknown tool: {name!r}")
    # Credentials first: a missing token is the real fault, so report it as such
    # instead of as whatever argument happens to be resolved first.
    _token()
    # The HTTP call is blocking; keep the JSON-RPC read loop responsive.
    payload = await anyio.to_thread.run_sync(handler, arguments or {})
    return [types.TextContent(type="text", text=_dump(payload))]


server: Server = Server("doppler-mcp")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return TOOLS


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    return await dispatch(name, arguments)


async def main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    try:
        anyio.run(main)
    except KeyboardInterrupt:  # pragma: no cover - gateway shutdown
        sys.exit(0)
