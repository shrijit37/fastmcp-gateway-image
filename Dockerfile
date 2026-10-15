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

ENTRYPOINT ["python", "/usr/local/bin/gateway_entry.py"]
