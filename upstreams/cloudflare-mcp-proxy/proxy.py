#!/usr/bin/env python3
"""Stdio bridge to Cloudflare's hosted MCP server (https://mcp.cloudflare.com/mcp).

Why this exists instead of `mcp-remote`: when the upstream rejects the
credential, mcp-remote falls back to an interactive OAuth flow and waits for a
browser nobody will open. Inside a gateway that call happens during registry
population, so it blocked the whole service — every client got 502 until the
upstream was removed. This bridge does exactly one thing, attach a static
Authorization header and pass stdio <-> streamable HTTP, and it fails fast
instead: a rejected token produces an error during population and the gateway
skips the domain, which is the failure mode we want.

Needs fastmcp, already present in the gateway image as a dependency of the
pinned fastmcp-gateway. Verified against the image's fastmcp 3.4.x: ProxyClient
rejects `forward_incoming_headers` at that version, so it is omitted.
"""
import os
import sys

from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.server import create_proxy
from fastmcp.server.providers.proxy import ProxyClient

URL = os.environ.get("CLOUDFLARE_MCP_URL", "https://mcp.cloudflare.com/mcp").strip()
TOKEN = os.environ.get("CLOUDFLARE_MCP_TOKEN", "").strip()
if not TOKEN:
    sys.exit("cloudflare-mcp-proxy: CLOUDFLARE_MCP_TOKEN is required")

transport = StreamableHttpTransport(URL, headers={"Authorization": f"Bearer {TOKEN}"})
create_proxy(ProxyClient(transport), name="cloudflare").run()
