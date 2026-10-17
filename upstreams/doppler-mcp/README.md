# doppler-mcp

Read-only Doppler secrets access for the MCP gateway, as a vendored stdio
upstream. Six closed-schema tools over Doppler's public REST API v3
(`https://api.doppler.com`), authenticated with a service token from the
environment.

## Why this exists

Doppler ships an official server, `npx @dopplerhq/mcp-server`. The gateway
registry rejects **12 of its 13 tools**.

`fastmcp_gateway.sanitize.validate_input_schema` refuses any upstream tool whose
root schema declares `additionalProperties: true` — that upstream's schemas are
generated from Doppler's OpenAPI document, and the generated root objects are
open. The check is an anti-smuggling guard on the meta-tool surface: an open root
lets an upstream accept arbitrary keys that `execute_tool` then forwards. The
policy is not relaxed for this upstream, so the tool surface is re-implemented
here with **every** schema closed: explicit `properties`, explicit `required`,
`additionalProperties: false` at the root, and no `$ref` at any depth.

The other upstreams' relaxations (hyphenated tool names, deeper schema nesting)
do not apply workarounds here: this server's names are plain, and its schemas
nest one level.

## Tools

Every tool takes an optional `project` and `config`; both fall back to
`DOPPLER_PROJECT` / `DOPPLER_CONFIG`. All six are read-only GETs.

| tool | arguments | returns |
|---|---|---|
| `list-projects` | — | Every project the token can see |
| `list-configs` | `project?` | The project's configs (environments) |
| `get-config` | `project?`, `config?` | Config metadata — inheritance, read-lock, environment (no values) |
| `list-secrets` | `project?`, `config?` | Secret **names only**; the safe default |
| `get-secret` | `name`, `project?`, `config?` | One secret's computed value |
| `download-secrets` | `project?`, `config?` | Every key/value pair of the config, as a flat map |

`download-secrets` is the escape hatch for a whole-config refactor or a rotation
checklist. Every value it returns lands in the calling model's context, so the
steering rule is: name first (`list-secrets`), then read only the one or two keys
you actually need (`get-secret`).

## Configuration

| variable | default | purpose |
|---|---|---|
| `DOPPLER_TOKEN` | *(unset)* | Service token (`dp.st.…`). Required; a missing one is a loud error, never an anonymous call |
| `DOPPLER_PROJECT` | *(unset)* | Project used when a tool call omits `project` |
| `DOPPLER_CONFIG` | *(unset)* | Config used when a tool call omits `config` |
| `DOPPLER_API_BASE` | `https://api.doppler.com` | Alternate endpoint |
| `DOPPLER_HTTP_TIMEOUT` | `30` | Per-request timeout, seconds |

`DOPPLER_API_BASE` and `DOPPLER_HTTP_TIMEOUT` are read when the process starts;
the token and the two defaults are read per call.

The deployed token is a **read-only, config-scoped** service token for
`platform`/`prd`, so `list-projects` sees one project, `list-configs` sees one
config, and nothing outside the token's scope is reachable even by asking.

## Where this runs

Vendored into the gateway image (`fastmcp-gateway-image`,
`upstreams/doppler-mcp/`) and run **in-container** as the stdio upstream
`doppler`:

```json
"doppler": {"mcpServers": {"doppler": {"command": "python",
  "args": ["/opt/doppler-mcp/server.py"],
  "env": {"DOPPLER_TOKEN": "dp.st.…", "DOPPLER_PROJECT": "platform",
          "DOPPLER_CONFIG": "prd"}}}}
```

Per-upstream settings belong in that entry's `env`, not the container env — the
gateway does not hand its own environment to stdio children (see
`../../DEPLOY.md`). Clients never mount this directory; they reach the six tools
through the gateway's `discover_tools(domain="doppler")` → `execute_tool`.

There is no build step: pure-stdlib HTTP against the Doppler API plus the `mcp`
SDK that `pip install fastmcp-gateway` already brings in (verified: a venv with
only that package imports this server). The image still runs an import check at
build time so a broken vendored copy fails the build rather than silently
populating zero tools.

## Tests

```bash
# The workstation's system python has neither `mcp` nor `pytest`; the image
# provides both, so use a scratch venv for the suite.
python -m venv /tmp/doppler-mcp-venv
/tmp/doppler-mcp-venv/bin/pip install mcp pytest

/tmp/doppler-mcp-venv/bin/python -m pytest upstreams/doppler-mcp/tests -q
# 23 passed, 1 skipped

DOPPLER_TOKEN=dp.st.<token> DOPPLER_PROJECT=platform DOPPLER_CONFIG=prd \
  /tmp/doppler-mcp-venv/bin/python -m pytest upstreams/doppler-mcp/tests -q
# 24 passed — the live round trip included
```

The offline suite mocks `urlopen` per tool (asserting the request path, query and
bearer header), walks every schema for open roots and `$ref`s, and drives a real
stdio session as a subprocess for the tool list, the closed schemas, and the
gateway's per-call `initialize` behaviour. The live test reads `DOPPLER_TOKEN`
from the environment, asserts names come back and that a value round-trips, and
is skipped when the token is unset. No test prints a token.

## Design notes

**Errors name the missing thing.** No token, no project, no config, no secret
name, an HTTP failure, a non-JSON body — each produces a message saying what was
missing or what Doppler refused. Nothing degrades into a quiet empty result the
model can paper over.

**HTTP errors carry Doppler's own words.** A failing call surfaces the status,
the reason and the API's `messages` array (`403 Forbidden for
/v3/configs/config/secrets/names — Invalid token`). The token itself is never
included: it only ever travels in the `Authorization` header, and any occurrence
of it in an error body is redacted defensively.

**Names before values.** `list-secrets` is the tool the model should reach for
first; value-reading tools are separate, so a context-window accident requires
deliberately calling one.

**Blocking HTTP runs off the event loop.** Each tool call goes through
`anyio.to_thread.run_sync`, so a slow Doppler response cannot stall the JSON-RPC
read loop.

**Credentials are checked first** in `dispatch`, before any argument resolution,
so an unconfigured container reports "DOPPLER_TOKEN is unset" rather than a
misleading complaint about a missing project.
