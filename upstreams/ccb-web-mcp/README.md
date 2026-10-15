# ccb-web-mcp

Keyless web search and fetch for the official Claude Code CLI, ported from
[claude-code-best](https://github.com/claude-code-best/claude-code)'s web tooling.

## Why this exists

Claude Code's built-in `WebSearch` has no search engine of its own. It delegates
to the model provider's server-side `web_search_20250305` tool and reads the
results back out of the response stream. If the provider does not implement that
tool, the CLI does not error — it falls back to treating the model's own prose as
the result set. On a gateway that stubs the tool, searches return confident
answers with no citations.

`WebFetch` is unaffected: it is genuinely client-side, so the CLI does the HTTP
itself.

This server moves web search fully client-side and exposes it over MCP, where it
does not depend on which provider sits behind `ANTHROPIC_BASE_URL`.

## Tools

| tool | what it does |
|---|---|
| `web_search` | Search the web, return `{title, url, snippet}` per result |
| `web_fetch` | Fetch a URL, return readable text |
| `web_search_health` | Probe each backend and report which are reachable |

## Backends

All three are keyless — none can prompt for or fail on a missing key.

| backend | endpoint | notes |
|---|---|---|
| `bing` *(default)* | `bing.com/search` | Self-contained. The only network hop is to Bing. |
| `tavily` | `tavily.claude-code-best.win` | CCB's community relay. A third party sees every query and could disappear. |
| `exa` | `mcp.exa.ai/mcp` | Public MCP endpoint, anonymous rate limit. Set `EXA_API_KEY` for a real quota. |

## Configuration

| variable | default | purpose |
|---|---|---|
| `WEB_SEARCH_ADAPTER` | `bing` | Default backend when `web_search` is called without one |
| `TAVILY_ENDPOINT_URL` | `https://tavily.claude-code-best.win` | Point Tavily at your own relay |
| `EXA_API_KEY` | *(unset)* | Optional; raises Exa's rate limit |
| `EXA_ENDPOINT_URL` | `https://mcp.exa.ai/mcp` | Alternate Exa MCP endpoint |
| `WEB_FETCH_HTTP_TIMEOUT_MS` | `60000` | Default timeout for `web_fetch` |

## Where this runs

This directory is the canonical copy. It is vendored into the gateway image
(`fastmcp-gateway-image`, `upstreams/ccb-web-mcp/`) and runs **inside the
gateway container** as the stdio upstream `websearch` — see `../../DEPLOY.md`.
Clients do not mount it directly; they reach these three tools through the
gateway's `discover_tools` → `execute_tool`.

The image's node is 20, which cannot execute this TypeScript directly (native
type stripping needs 22.6+), so the image build bundles it with esbuild to
`dist/index.js` using `--target=node20`; the bundle inlines both runtime
dependencies and `node_modules` is dropped afterwards. Source edits therefore
ship through the gateway image, not through a local process.

## Tests

```bash
npm run test:offline   # parsers, entities, domain filter — no network
npm test               # adds the live MCP round-trip suite
```

The live suite asserts that returned URLs are real and actually fetchable — the
check the built-in `WebSearch` fails.

## Design notes

**Failures never look like empty successes.** If a backend yields nothing, the
tool returns an error naming the backend and the likely cause (`markup-drift`,
`filtered`, `network`, `empty`) rather than an empty list the model will quietly
paper over. Every result set also carries its `backend`, so the source of an
answer is always visible.

**Bing result URLs are wrapped.** Bing returns organic links as
`https://www.bing.com/ck/a?...&u=a1<base64url>`. The `u` parameter is the real
destination, base64url-encoded behind a two-character `a1` marker, and the
`href` must be entity-decoded (`&amp;u=`) before it can be read. If Bing changes
either the wrapper format or the `<li class="b_algo">` markup, `web_search_health`
will report `markup-drift` and `src/backends/bing.ts` needs updating.

## Credits

Search and fetch backends, result shapes, and the Bing/Exa parsers are ported
from `claude-code-best` v2.8.4.
