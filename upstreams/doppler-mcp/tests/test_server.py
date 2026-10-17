"""Tests for the vendored Doppler stdio upstream.

Two layers:

1. mocked-HTTP unit tests — every tool shape, against a fake ``urlopen`` that
   records the request (path, query, auth header) so URL construction and the
   error paths are exercised without a token or a network;
2. a real stdio round trip — the server is spawned as a subprocess with
   ``sys.executable`` and its tool list, schemas and duplicate-``initialize``
   tolerance are asserted over an actual MCP session.

The registry rules these schemas must satisfy
(``fastmcp_gateway.sanitize.validate_input_schema``) are re-checked here rather
than imported: this directory's test dependencies are ``mcp`` and ``pytest``
only, and the point is to fail in this repo if a schema drifts open.

Live tests use ``DOPPLER_TOKEN`` from the environment and are skipped when it is
unset. No test prints a token.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import urllib.error
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp import types
from mcp.client.stdio import stdio_client

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server as doppler  # noqa: E402

SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"

EXPECTED_TOOLS = {
    "list-projects",
    "list-configs",
    "get-config",
    "list-secrets",
    "get-secret",
    "download-secrets",
}

ROUTES = {
    "/v3/projects": {"projects": [{"id": "proj-1", "name": "platform"}]},
    "/v3/configs": {"configs": [{"name": "prd", "environment": "prd"}]},
    "/v3/configs/config": {"name": "prd", "environment": "prd", "project": "platform"},
    "/v3/configs/config/secrets/names": {"names": ["API_KEY", "DATABASE_URL", "SMTP_URL"]},
    "/v3/configs/config/secret": {"value": {"raw": "s3cret-raw", "computed": "s3cret-computed"}},
    "/v3/configs/config/secrets/download": {"API_KEY": "a", "DATABASE_URL": "b"},
}

# One route per tool; every tool is a GET, so this also pins the read-only surface.
ROUTE_FOR_TOOL = {
    "list-projects": "/v3/projects",
    "list-configs": "/v3/configs",
    "get-config": "/v3/configs/config",
    "list-secrets": "/v3/configs/config/secrets/names",
    "get-secret": "/v3/configs/config/secret",
    "download-secrets": "/v3/configs/config/secrets/download",
}


# --------------------------------------------------------------------------- #
# Harness
# --------------------------------------------------------------------------- #


class FakeResponse:
    def __init__(self, payload):
        self._body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class Recorder:
    """Stands in for ``urllib.request.urlopen``; records and serves by path."""

    def __init__(self, routes=None):
        self.routes = dict(ROUTES if routes is None else routes)
        self.calls = []
        self.fail = None

    def __call__(self, request, timeout=None):
        parts = urlsplit(request.full_url)
        self.calls.append(
            {
                "url": request.full_url,
                "path": parts.path,
                "query": {k: v[0] for k, v in parse_qs(parts.query).items()},
                "authorization": request.get_header("Authorization"),
                "timeout": timeout,
            }
        )
        if self.fail is not None:
            raise self.fail(request.full_url)
        if parts.path not in self.routes:
            raise urllib.error.HTTPError(
                request.full_url,
                404,
                "Not Found",
                None,
                io.BytesIO(b'{"success":false,"messages":["unexpected route"]}'),
            )
        return FakeResponse(self.routes[parts.path])


@pytest.fixture
def http(monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(doppler.urllib.request, "urlopen", recorder)
    monkeypatch.setenv("DOPPLER_TOKEN", "dp.st.unit-test-token")
    monkeypatch.setenv("DOPPLER_PROJECT", "platform")
    monkeypatch.setenv("DOPPLER_CONFIG", "prd")
    return recorder


def call(name, arguments=None):
    """Call a tool through the real dispatch path and decode its JSON payload."""
    blocks = asyncio.run(doppler.dispatch(name, arguments))
    assert len(blocks) == 1
    assert blocks[0].type == "text"
    return json.loads(blocks[0].text)


def server_params(**env):
    base = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "PYTHONUNBUFFERED": "1",
    }
    base.update(env)
    return StdioServerParameters(command=sys.executable, args=[str(SERVER_PATH)], env=base)


async def _session(env, body):
    async with stdio_client(server_params(**env)) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await body(session)


# --------------------------------------------------------------------------- #
# One mocked-HTTP call per tool shape
# --------------------------------------------------------------------------- #


def test_list_projects(http):
    assert call("list-projects") == ROUTES["/v3/projects"]
    assert len(http.calls) == 1
    assert http.calls[0]["path"] == "/v3/projects"
    assert http.calls[0]["query"] == {}
    assert http.calls[0]["authorization"] == "Bearer dp.st.unit-test-token"


def test_list_configs_uses_env_default(http):
    payload = call("list-configs")
    assert payload == ROUTES["/v3/configs"]
    assert http.calls[0]["query"] == {"project": "platform"}


def test_list_configs_takes_explicit_project(http):
    call("list-configs", {"project": "other"})
    assert http.calls[0]["query"] == {"project": "other"}


def test_get_config(http):
    payload = call("get-config")
    assert payload == ROUTES["/v3/configs/config"]
    assert http.calls[0]["path"] == "/v3/configs/config"
    assert http.calls[0]["query"] == {"project": "platform", "config": "prd"}


def test_get_config_explicit_pair(http):
    call("get-config", {"project": "p2", "config": "stg"})
    assert http.calls[0]["query"] == {"project": "p2", "config": "stg"}


def test_list_secrets_returns_names_only(http):
    payload = call("list-secrets")
    assert payload == {
        "project": "platform",
        "config": "prd",
        "names": ["API_KEY", "DATABASE_URL", "SMTP_URL"],
    }
    assert "secrets" not in payload and "values" not in payload
    assert http.calls[0]["path"] == "/v3/configs/config/secrets/names"


def test_get_secret_returns_computed_value(http):
    payload = call("get-secret", {"name": "DATABASE_URL"})
    assert payload == {
        "project": "platform",
        "config": "prd",
        "name": "DATABASE_URL",
        "value": "s3cret-computed",
    }
    assert http.calls[0]["query"] == {
        "project": "platform",
        "config": "prd",
        "name": "DATABASE_URL",
    }


def test_get_secret_requires_a_name(http):
    with pytest.raises(doppler.DopplerError, match="'name' is required"):
        call("get-secret", {})
    assert http.calls == []


def test_get_secret_errors_when_no_computed_value(http):
    http.routes["/v3/configs/config/secret"] = {"value": {"raw": "x"}}
    with pytest.raises(doppler.DopplerError, match="no computed value"):
        call("get-secret", {"name": "API_KEY"})


def test_download_secrets_returns_flat_map(http):
    payload = call("download-secrets")
    assert payload == {
        "project": "platform",
        "config": "prd",
        "secrets": {"API_KEY": "a", "DATABASE_URL": "b"},
    }
    assert http.calls[0]["query"] == {
        "project": "platform",
        "config": "prd",
        "format": "json",
    }


def test_every_tool_issues_exactly_one_get(http):
    for name in sorted(EXPECTED_TOOLS):
        arguments = {"name": "API_KEY"} if name == "get-secret" else None
        call(name, arguments)
    assert [c["path"] for c in http.calls] == [
        ROUTE_FOR_TOOL[name] for name in sorted(EXPECTED_TOOLS)
    ]
    assert all(c["timeout"] == doppler.HTTP_TIMEOUT for c in http.calls)
    assert all(c["authorization"] == "Bearer dp.st.unit-test-token" for c in http.calls)


# --------------------------------------------------------------------------- #
# Defaults and error surfaces
# --------------------------------------------------------------------------- #


def test_env_defaults_supply_project_and_config(http, monkeypatch):
    monkeypatch.delenv("DOPPLER_PROJECT")
    monkeypatch.delenv("DOPPLER_CONFIG")
    with pytest.raises(doppler.DopplerError, match="no project given"):
        call("list-secrets")
    monkeypatch.setenv("DOPPLER_PROJECT", "from-env")
    with pytest.raises(doppler.DopplerError, match="no config given"):
        call("list-secrets")
    monkeypatch.setenv("DOPPLER_CONFIG", "from-env-config")
    assert call("list-secrets")["config"] == "from-env-config"


def test_explicit_arguments_beat_env(http, monkeypatch):
    monkeypatch.setenv("DOPPLER_PROJECT", "wrong")
    monkeypatch.setenv("DOPPLER_CONFIG", "wrong")
    call("list-secrets", {"project": "platform", "config": "prd"})
    assert http.calls[0]["query"] == {"project": "platform", "config": "prd"}


def test_missing_token_is_reported_not_guessed(http, monkeypatch):
    monkeypatch.delenv("DOPPLER_TOKEN")
    with pytest.raises(doppler.DopplerError, match="DOPPLER_TOKEN is unset"):
        call("list-projects")
    assert http.calls == []


def test_http_error_surfaces_status_and_doppler_messages(http, monkeypatch):
    def fail(url):
        return urllib.error.HTTPError(
            url,
            403,
            "Forbidden",
            None,
            io.BytesIO(
                b'{"success":false,"messages":["Invalid token dp.st.unit-test-token"]}'
            ),
        )

    http.fail = fail
    with pytest.raises(doppler.DopplerError) as excinfo:
        call("list-secrets")
    message = str(excinfo.value)
    assert "403" in message and "Forbidden" in message
    assert "Invalid token" in message
    assert "dp.st.unit-test-token" not in message
    assert "[redacted]" in message


def test_http_error_without_doppler_messages(http):
    def fail(url):
        return urllib.error.HTTPError(url, 500, "Server Error", None, io.BytesIO(b"<html>oops"))

    http.fail = fail
    with pytest.raises(doppler.DopplerError, match=r"500 Server Error for /v3/projects"):
        call("list-projects")


def test_unreachable_api_is_reported(http):
    def fail(_url):
        raise urllib.error.URLError("connection refused")

    http.fail = fail
    with pytest.raises(doppler.DopplerError, match="unreachable for /v3/projects"):
        call("list-projects")


def test_unknown_tool(http):
    with pytest.raises(doppler.DopplerError, match="unknown tool"):
        call("delete-project")
    assert http.calls == []


# --------------------------------------------------------------------------- #
# Schema shape: the registry's rules, re-checked without the gateway package
# --------------------------------------------------------------------------- #


def walk_schema(schema, path="$", depth=1):
    yield path, schema, depth
    for key, value in schema.items():
        if key == "properties" and isinstance(value, dict):
            for name, sub in value.items():
                yield from walk_schema(sub, f"{path}.{name}", depth + 1)
        elif isinstance(value, dict):
            yield from walk_schema(value, f"{path}.{key}", depth + 1)
        elif isinstance(value, list):
            for index, sub in enumerate(value):
                if isinstance(sub, dict):
                    yield from walk_schema(sub, f"{path}.{key}[{index}]", depth + 1)


def test_schemas_are_closed_at_every_depth():
    for tool in doppler.TOOLS:
        nodes = list(walk_schema(tool.inputSchema))
        for path, node, _depth in nodes:
            assert node.get("additionalProperties") is not True, f"{tool.name}: open schema at {path}"
            assert "$ref" not in node, f"{tool.name}: $ref at {path}"
        assert tool.inputSchema.get("type") == "object", tool.name
        assert isinstance(tool.inputSchema.get("properties"), dict), tool.name
        assert isinstance(tool.inputSchema.get("required"), list), tool.name
        assert set(tool.inputSchema["required"]) <= set(tool.inputSchema["properties"]), tool.name
        assert max(depth for _p, _n, depth in nodes) <= 12, tool.name


def test_tool_names_are_exact():
    assert {tool.name for tool in doppler.TOOLS} == EXPECTED_TOOLS
    assert len(doppler.TOOLS) == len(EXPECTED_TOOLS)
    assert set(doppler._HANDLERS) == EXPECTED_TOOLS
    for tool in doppler.TOOLS:
        assert tool.description and tool.description.strip()


# --------------------------------------------------------------------------- #
# Real stdio round trip
# --------------------------------------------------------------------------- #


def test_stdio_lists_exact_tool_set_and_closed_schemas():
    async def body(session):
        result = await session.list_tools()
        return result.tools

    tools = asyncio.run(_session({}, body))
    assert {tool.name for tool in tools} == EXPECTED_TOOLS
    for tool in tools:
        for path, node, _depth in walk_schema(tool.inputSchema):
            assert node.get("additionalProperties") is not True, f"{tool.name}: {path}"
        assert tool.inputSchema["type"] == "object"


def test_stdio_tolerates_the_gateways_repeated_initialize():
    """The gateway re-initializes a reused stdio child once per call."""

    async def body(session):
        request = types.ClientRequest(
            types.InitializeRequest(
                params=types.InitializeRequestParams(
                    protocolVersion=types.LATEST_PROTOCOL_VERSION,
                    capabilities=types.ClientCapabilities(),
                    clientInfo=types.Implementation(name="reprobe", version="0"),
                )
            )
        )
        return await session.send_request(request, types.InitializeResult)

    result = asyncio.run(_session({}, body))
    assert isinstance(result, types.InitializeResult)


def test_stdio_reports_missing_token_as_a_tool_error():
    async def body(session):
        return await session.call_tool("list-secrets", {})

    result = asyncio.run(_session({}, body))
    assert result.isError is True
    text = result.content[0].text
    assert "DOPPLER_TOKEN is unset" in text
    assert "DOPPLER_PROJECT" not in text


# --------------------------------------------------------------------------- #
# Live (token from the environment; skipped when unset)
# --------------------------------------------------------------------------- #


@pytest.mark.skipif(
    not (os.environ.get("DOPPLER_TOKEN") or "").strip(),
    reason="DOPPLER_TOKEN is not set",
)
def test_live_list_secrets_and_get_secret():
    env = {"DOPPLER_TOKEN": os.environ["DOPPLER_TOKEN"]}
    for key in ("DOPPLER_PROJECT", "DOPPLER_CONFIG"):
        if os.environ.get(key):
            env[key] = os.environ[key]

    async def body(session):
        listed = await session.call_tool("list-secrets", {})
        assert listed.isError is not True, listed.content[0].text
        payload = json.loads(listed.content[0].text)
        names = payload["names"]
        assert names, "token sees no secret names in the configured config"
        assert listed.content[0].text.count("s3cret") == 0
        single = await session.call_tool("get-secret", {"name": names[0]})
        assert single.isError is not True, single.content[0].text
        assert json.loads(single.content[0].text)["name"] == names[0]
        sys.stderr.write(f"live: {len(names)} secret names in {payload['project']}/{payload['config']}\n")
        return len(names)

    assert asyncio.run(_session(env, body)) > 0
