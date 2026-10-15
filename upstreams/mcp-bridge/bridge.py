#!/usr/bin/env python3
"""General stdio bridge for upstreams the gateway cannot talk to directly.

Two modes, chosen by environment:

* `MCP_UPSTREAM_URL` — front a remote streamable-HTTP MCP server, attaching a
  static bearer token. Needed because the gateway applies
  `GATEWAY_UPSTREAM_HEADERS` only on the execution path, so an authenticated HTTP
  upstream cannot populate its registry entry.
* `MCP_UPSTREAM_CMD` (+ optional `MCP_UPSTREAM_ARGS`) — front a local stdio MCP
  server. Needed for servers that reject a repeated `initialize`: the gateway
  reuses a stdio child and re-initializes it per call, which the MCP spec says a
  server SHOULD refuse (github-mcp-server does, and every call after the first
  then fails with `duplicate initialize request`). A fastmcp proxy in the middle
  answers each new gateway session itself and keeps one upstream session, so the
  calls survive.

`MCP_UPSTREAM_TOKEN` carries the credential in HTTP mode. In stdio mode the child
inherits this process's environment, so pass credentials straight through.

Verifies the API it uses at construction time so version drift fails loudly.
"""
import os
import shlex
import sys

from fastmcp.client.transports import StdioTransport, StreamableHttpTransport
from fastmcp.server import create_proxy
from fastmcp.server.providers.proxy import ProxyClient

URL = os.environ.get("MCP_UPSTREAM_URL", "").strip()
CMD = os.environ.get("MCP_UPSTREAM_CMD", "").strip()

if URL:
    token = os.environ.get("MCP_UPSTREAM_TOKEN", "").strip()
    if not token:
        sys.exit("mcp-bridge: MCP_UPSTREAM_URL set but MCP_UPSTREAM_TOKEN is missing")
    transport = StreamableHttpTransport(URL, headers={"Authorization": f"Bearer {token}"})
    name = os.environ.get("MCP_UPSTREAM_NAME", "upstream")
elif CMD:
    transport = StdioTransport(
        command=CMD,
        args=shlex.split(os.environ.get("MCP_UPSTREAM_ARGS", "")),
        env=dict(os.environ),
    )
    name = os.environ.get("MCP_UPSTREAM_NAME") or CMD
else:
    sys.exit("mcp-bridge: set MCP_UPSTREAM_URL or MCP_UPSTREAM_CMD")

create_proxy(ProxyClient(transport), name=name).run()
