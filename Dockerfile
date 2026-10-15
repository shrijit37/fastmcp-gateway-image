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

# Vendored stdio upstream: GitHub's official MCP server (github/github-mcp-server,
# MIT, v2.0.2). A static Go binary (CGO_ENABLED=0), verified against the release
# checksum for the arch being built, so it adds no runtime dependency and no npm.
# `--read-only` is the default here because this gateway executes tools
# unattended: write tools are skipped even when a model asks for them. Widen the
# surface (or narrow it with --toolsets) by editing the upstream entry's args in
# the compose env, not this image.
ARG GH_MCP_VERSION=2.0.2
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) asset="github-mcp-server_Linux_x86_64.tar.gz"; sha="815e27d931c796af0c97f24fd211e14f8a4607d4528377719a5ad2352086b0b0" ;; \
      arm64) asset="github-mcp-server_Linux_arm64.tar.gz";  sha="73f5e76c6a3b5e0d731e1134a7c38575df6ec96c646192095a3be2d4d0d6c1fc" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gh-mcp.tgz \
      "https://github.com/github/github-mcp-server/releases/download/v${GH_MCP_VERSION}/${asset}"; \
    echo "${sha}  /tmp/gh-mcp.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gh-mcp.tgz -C /usr/local/bin github-mcp-server; \
    chmod 0755 /usr/local/bin/github-mcp-server; \
    rm -f /tmp/gh-mcp.tgz; \
    github-mcp-server --version

# Vendored stdio bridge to Cloudflare's hosted MCP server. See
# upstreams/cloudflare-mcp-proxy/proxy.py for why this exists instead of
# `mcp-remote`: that one answers a rejected credential with an interactive OAuth
# flow that blocks registry population and takes every client down with it.
# The import check below fails the build if the image's fastmcp stops exposing
# the proxy API this bridge is written against.
COPY upstreams/cloudflare-mcp-proxy /opt/cf-mcp-proxy
RUN python -c "from fastmcp.client.transports import StreamableHttpTransport; \
from fastmcp.server import create_proxy; \
from fastmcp.server.providers.proxy import ProxyClient; \
print('fastmcp proxy API present')"

ENTRYPOINT ["python", "/usr/local/bin/gateway_entry.py"]
