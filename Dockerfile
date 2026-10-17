FROM nikolaik/python-nodejs:python3.12-nodejs20

# Build identity. CI passes the full commit SHA; the health middleware reports
# it from /healthz so a deploy can prove which build is actually serving.
ARG APP_VERSION=dev

RUN pip install --no-cache-dir fastmcp-gateway==0.33.0

# fastmcp-gateway 0.33.0 rejects any upstream tool whose name does not match
# ^[a-z][a-zA-Z0-9_]{0,63}$ . That guard exists so an upstream name cannot
# shadow a Python builtin inside the optional execute_code sandbox
# (code_mode). context7 and @dokploy/mcp both advertise hyphenated tool names
# (resolve-library-id, query-docs, application-one, docker-getContainers, ...),
# so the strict rule silently drops every tool from those upstreams.
#
# This wrapper relaxes the character class to allow '-' after the first
# character and then runs the normal gateway entrypoint. code_mode is left
# disabled, so no sandbox binding is ever built from these names.
# The registry's ingest-time schema-depth cap defaults to 5 and silently
# rejects any upstream tool whose inputSchema nests deeper. Measured with the
# shipped fastmcp_gateway.sanitize._schema_depth algorithm, 20 @dokploy/mcp
# tools sit at depth 6-10 (application-update, ai-deploy, sso-register,
# admin-setupMonitoring, the libsql/mariadb/mongo/mysql/postgres/redis-update
# set, ...) and never register; deepwiki's ask_wiki_question is depth 6. Every
# other tool across dokploy (584), context7 and deepwiki is <= 5. Raise the cap
# to 12 (measured max 10 plus headroom) -- the 50 ceiling and the physical
# recursion guard are untouched, and code_mode is still disabled.
RUN cat > /usr/local/bin/gateway_entry.py <<'PY'
import os
import re
import fastmcp_gateway.registry as _registry

os.environ.setdefault("GATEWAY_MAX_SCHEMA_DEPTH", "12")

_ALLOWED = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


def _relaxed_validate_tool_name(name: str):
    if not name:
        return "empty tool name"
    if not _ALLOWED.fullmatch(name):
        return "name does not match relaxed shape ^[A-Za-z][A-Za-z0-9_-]{0,63}$"
    return None


_registry.validate_tool_name = _relaxed_validate_tool_name

from fastmcp_gateway.__main__ import main  # noqa: E402

if __name__ == "__main__":
    main()
PY

# gateway_middleware.py carries two things the raw gateway lacks:
#   1. bearer auth on every route except /healthz + /readyz — this endpoint
#      executes all 604 Dokploy tools, including destructive ones, and fails
#      closed (503) when GATEWAY_AUTH_TOKEN is unset;
#   2. service+version on /healthz, the identity a deploy gate asserts.
# Loaded through the gateway's own env-driven hook, gated by the allowlist
# entry below. The module path is baked here; the token comes from the compose
# env so it never lives in the image.
COPY gateway_middleware.py /opt/gateway/gateway_middleware.py
ENV PYTHONPATH=/opt/gateway \
    GATEWAY_MIDDLEWARE_MODULE=gateway_middleware:middleware \
    GATEWAY_ALLOWED_MIDDLEWARE_PREFIXES=gateway_middleware \
    APP_VERSION=${APP_VERSION}

# Vendored stdio upstream: ccb-web-mcp (keyless web search + fetch), an original
# server that ports three backends from claude-code-best — see
# upstreams/ccb-web-mcp/NOTICE.md for provenance and licensing.
#
# The base image runs node 20, which cannot execute this TypeScript directly
# (native type stripping landed in 22.6), so the build bundles it with a pinned
# esbuild into one ESM file. --target=node20 keeps the output honest for this
# interpreter, the bundle inlines both runtime deps
# (@modelcontextprotocol/sdk, zod), and package.json is kept beside dist/ so
# node still reads dist/index.js as ESM. node_modules and the network-dependent
# test suite do not belong in the runtime image.
#
# Registered through the compose env as the `websearch` domain:
#   "websearch": {"mcpServers": {"websearch": {"command": "node",
#                 "args": ["/opt/ccb-web-mcp/dist/index.js"]}}}
# The server is keyless by design (backends: bing (default), tavily, exa) and
# writes only JSON-RPC to stdout, which stdio transport requires.
COPY upstreams/ccb-web-mcp /opt/ccb-web-mcp
RUN cd /opt/ccb-web-mcp \
    && npm ci --omit=dev --no-audit --no-fund \
    && npx --yes esbuild@0.25.0 src/index.ts --bundle --platform=node \
         --target=node20 --format=esm --outfile=dist/index.js --log-level=warning \
    && rm -rf node_modules test

# Vendored stdio upstream: Oracle's official OCI MCP server
# (github.com/oracle/mcp → src/oci-api-mcp-server, UPL-1.0). Its tools discover
# and run OCI CLI commands, backed by the official CLI that installs alongside it.
#
# Chosen over the sibling oci-cloud-mcp-server (SDK-backed, 5 generic tools)
# because that one resolves auth through oci.config.from_file and demands a real
# ~/.oci/config plus a PEM on disk, which a stdio child cannot be handed through
# the environment. This server authenticates entirely from OCI_CLI_* variables —
# verified end to end on this image's Python 3.12 with no ~/.oci present: live
# `iam region list` (44 regions) and `os ns get` results over stdio.
# `OCI_CLI_AUTH=api_key` is load-bearing: without it the server probes for a
# session-token profile first and fails on the missing config file.
#
# The metadata declares requires-python >=3.13 but the code runs on 3.12, so
# --ignore-requires-python is deliberate. The release pins oci-cli==3.89.3 and
# the server enforces that pair at runtime — do not install a different one.
RUN pip install --no-cache-dir --ignore-requires-python oracle.oci-api-mcp-server==2.1.5 \
    && test -x /usr/local/bin/oracle.oci-api-mcp-server \
    && test -x /usr/local/bin/oci

# Vendored stdio bridge for upstreams the gateway cannot talk to directly — see
# upstreams/mcp-bridge/bridge.py. Two cases it exists for:
#   1. a remote HTTP upstream needing a static bearer token (the gateway applies
#      GATEWAY_UPSTREAM_HEADERS only on the execution path, so such an upstream
#      cannot populate);
#   2. a local stdio upstream that does not answer a repeated `initialize` — the
#      gateway reuses a stdio child and re-initializes it per call, and
#      github-mcp-server refuses the second one, so every call after the first
#      fails until a bridge answers the handshake in front of it.
# The import check below fails the build if the image's fastmcp stops exposing the
# proxy API this bridge is written against.
COPY upstreams/mcp-bridge /opt/mcp-bridge
RUN python -c "from fastmcp.client.transports import StdioTransport, StreamableHttpTransport; \
from fastmcp.server import create_proxy; \
from fastmcp.server.providers.proxy import ProxyClient; \
print('fastmcp proxy API present')"

# Vendored stdio upstream: doppler (read-only Doppler secrets), original code —
# see upstreams/doppler-mcp/NOTICE.md. Doppler's official npm server cannot be
# registered here: `npx @dopplerhq/mcp-server` generates its tool schemas from
# Doppler's OpenAPI document, and 12 of its 13 root schemas declare
# `additionalProperties: true`, which the registry rejects. That check is right —
# an open root lets an upstream smuggle unvalidated keys through execute_tool —
# so it stays, and this first-party server closes every schema instead (explicit
# properties + required, additionalProperties: false, no $ref at any depth).
# Same pattern as ccb-web-mcp and mcp-bridge above.
#
# No build step: stdlib HTTP plus the `mcp` SDK that fastmcp-gateway already
# installs. The import check below fails the build if the vendored copy or that
# SDK drifts, instead of the `doppler` domain silently populating zero tools.
# Registered through the compose env as the `doppler` domain:
#   "doppler": {"mcpServers": {"doppler": {"command": "python",
#               "args": ["/opt/doppler-mcp/server.py"],
#               "env": {"DOPPLER_TOKEN": "dp.st.<service-token>",
#                       "DOPPLER_PROJECT": "platform",
#                       "DOPPLER_CONFIG": "prd"}}}}
# The tests need pytest and a live token, so they stay out of the image.
COPY upstreams/doppler-mcp /opt/doppler-mcp
RUN cd /opt/doppler-mcp && rm -rf tests && python -c "import server; \
assert [t.name for t in server.TOOLS] == ['list-projects', 'list-configs', 'get-config', 'list-secrets', 'get-secret', 'download-secrets']; \
print('doppler-mcp import ok')"

ENTRYPOINT ["python", "/usr/local/bin/gateway_entry.py"]
