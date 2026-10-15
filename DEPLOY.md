# Deployment — fastmcp-gateway-image (Dokploy)

The rule: **push to `main`**. Actions builds the image, GHCR stores it, a Dokploy
**compose** app pulls the SHA tag, and two gates refuse to go green unless that
exact SHA is the build serving `mcp.shrijit.tech` with its tool surface intact.

```
git push main
  → Actions build-deploy: buildx linux/amd64+arm64, APP_VERSION=<full sha>
      → ghcr.io/shrijit37/fastmcp-gateway-image:<sha> and :latest
  → Dokploy compose.update: pin <sha> in the compose file (env untouched)
  → Dokploy compose.deploy: pull + recreate the container
  → gate 1: GET https://mcp.shrijit.tech/healthz until version == <sha>   (300 s)
  → gate 2: MCP initialize + discover_tools(domain=dokploy) ≥ 600 tools,
            required write tools present
```

Nothing is built on the server.

## The deployed app

| what | value |
|---|---|
| Dokploy compose app | `fastmcp-gateway` — `composeId wNLMZlxdWv2svTu0V2vw6`, appName `compose-synthesize-multi-byte-sensor-r1667p`, project `mcp-gateway` |
| container | `…-gateway-1`, image = the pinned `ghcr.io/shrijit37/fastmcp-gateway-image:<sha>` |
| compose file | owned by the API; line 1 is `# deployed-build: <sha>`, then the `gateway` service with `env_file: .env` |
| domain | `mcp.shrijit.tech` → service `gateway`, port 8080, Let's Encrypt (Dokploy injects the Traefik labels) |
| image visibility | GHCR package is public, so the pull needs no credentials and the image carries no secrets |

**Why a compose app and not a Dokploy application.** The original application
(`fastmcp-gateway`, `A9F6GcGMBXzeQl2V5foFh`) is still in the project, stopped,
as rollback. On this Dokploy build (v0.30.8) it cannot run this repo's image:
`application.saveDockerProvider` returns `true` but the service keeps building a
server-side Dockerfile (`/etc/dokploy/applications/app-mcp-gateway-ztgrvo/code/`),
`application.update {sourceType:"docker"}` changes nothing observable, and a
*newly created* app with `sourceType: "docker"` also ran a build
(`Starting nixpacks build… Failed to read app source directory`). A compose app
sidesteps all of it: its compose file is API-owned and its deploys are plain
image pulls. Verified 2026-10-15 16:52Z (first deploy pulled the image and
reported `APP_VERSION=240e8e8…`).

## Health

`GET /healthz` → `200 {"status":"ok","service":"fastmcp-gateway","version":"<sha>"}`,
`GET /readyz` → `200 {"status":"ready"}`. Routes come from the gateway package;
`service`/`version` are added by this repo's `gateway_middleware.py`, loaded
through the gateway's own `GATEWAY_MIDDLEWARE_MODULE` hook (allowlisted by
`GATEWAY_ALLOWED_MIDDLEWARE_PREFIXES` — both baked into the image).

Both probes are the **only** public routes: every other path, `/mcp` included,
requires `Authorization: Bearer $GATEWAY_AUTH_TOKEN` and answers
`401 {"error":"unauthorized"}` without it. The same module enforces that, and it
fails closed — with the token unset (or shorter than 16 characters) non-probe
routes answer `503 auth_not_configured` while `/healthz` keeps working, so a
broken config is diagnosable instead of either locked out or silently open.

Verified behaviour (local run and live): anonymous `/mcp` → 401, wrong token →
401, valid token → 200, no token configured → 503. Gate 2 re-asserts the 401
case on every deploy, so an accidental auth regression fails the run instead of
quietly reopening the endpoint.

**Deviation:** the fleet contract also wants a `checks` object built from real
dependency probes. This service emits none — the gateway answers `ok` whenever
its process serves and deliberately does not publish tool counts. The real
dependency assertion is CI gate 2, and the same check by hand is:

```
POST /mcp  initialize → tools/call discover_tools {domain:"dokploy"}
```

A healthy gateway exposes **4 client-visible tools** (`discover_tools`,
`get_tool_schema`, `execute_tool`, `refresh_registry` — about 7.4 KB of schemas,
the entire context cost of mounting it) and a discovery registry behind them
holding the 604 dokploy tools plus the search, source-control, cloud and OCI
domains described below. Nothing from the
registry enters context unless the agent asks: a whole-domain listing
(`discover_tools("dokploy")`) is ~107 KB, a single tool's schema about 250 B.

Gate 2 asserts that *registry*, not the visible surface, because the failure mode
it guards is silence: a tool whose `inputSchema` exceeds the depth cap is not
"expensive to load", it does not exist — discovery never lists it and
`execute_tool` never receives it, with no error anywhere. There is no Docker
health check on the service.

## Secrets

Repo-level: secret `DOKPLOY_API_KEY` (also in Infisical `platform`/`prod`),
secret `GATEWAY_AUTH_TOKEN` (gate 2's credential), vars `DOKPLOY_URL` and
`DOKPLOY_COMPOSE_ID`. The deploy job uses them only to write the compose file,
roll the app and call the endpoint.

`GATEWAY_AUTH_TOKEN` is the gateway's own shared secret. It lives in four places
that must be rotated together: the compose env (authoritative), Infisical
`platform`/`prod` as `GATEWAY_AUTH_TOKEN`, the repo secret CI reads, and the
client header in `~/.omp/agent/mcp.json`. Rotate with `openssl rand -hex 32`,
then `compose.saveEnvironment` + `compose.deploy` and confirm 401 → 200.

Runtime configuration is the compose app's **encrypted env block**, which a
deploy never rewrites (`compose.update` without an `env` key leaves it
byte-identical — checked):

- `GATEWAY_UPSTREAMS` — JSON, one entry per domain: `context7` (HTTP),
  `deepwiki` (HTTP), `dokploy` (stdio `npx -y @dokploy/mcp`, with its own
  `DOKPLOY_URL` + `DOKPLOY_API_KEY`), `infisical` (stdio `npx -y @infisical/mcp`),
  `sequential-thinking` (stdio `npx -y @modelcontextprotocol/server-sequential-thinking`),
  and `websearch` (stdio `node /opt/ccb-web-mcp/dist/index.js` — vendored into
  this image, see below).
- `GATEWAY_UPSTREAM_HEADERS` — JSON: the context7 bearer token.
- `GATEWAY_MAX_SCHEMA_DEPTH=12`, `GATEWAY_NAME`, `GATEWAY_HOST=0.0.0.0`,
  `GATEWAY_PORT=8080`, `GATEWAY_REFRESH_INTERVAL=300`,
  `GATEWAY_TRACE_HEALTH_ROUTES=false`.

The compose file references them through `env_file: .env`, so no secret ever
lands in the compose file itself.

**Deviation:** the fleet standard wants app secrets as
`{{vault.infisical-prod.<KEY>}}` refs. These are literal values in Dokploy.
Rotating the Dokploy upstream key means editing `GATEWAY_UPSTREAMS` there and
re-running the workflow with **Run workflow** (a `compose.saveEnvironment` call
replaces the whole block).

## Why the image patches upstream

`Dockerfile` installs `fastmcp-gateway==0.33.0` and applies two monkeypatches in
`/usr/local/bin/gateway_entry.py`, both documented at the patch site:

1. **Relaxed tool-name validation** (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`). 0.33.0
   rejects every hyphenated name, which is all of `@dokploy/mcp` and context7.
2. **`GATEWAY_MAX_SCHEMA_DEPTH=12`** (package default 5). The registry silently
   skips any upstream tool whose `inputSchema` nests deeper than the cap:
   measured with the shipped `sanitize._schema_depth`, 20 dokploy tools sit at
   depth 6-10 (`application-update`, `ai-deploy`, `sso-register`,
   `admin-setupMonitoring`, the `*-update` CRUD set, …) and deepwiki's
   `ask_wiki_question` at 6. The package ceiling is 50; its physical-recursion
   guard is untouched.

## When a gate fails

| symptom | cause |
|---|---|
| gate 1 times out, `/healthz` keeps reporting the old SHA | the container never rolled: check the compose deploy log in Dokploy for an image pull failure |
| `/healthz` returns 404 or has no `version` | the image is not one built from this repo (middleware missing), or `GATEWAY_MIDDLEWARE_MODULE` / `GATEWAY_ALLOWED_MIDDLEWARE_PREFIXES` were removed from the compose env |
| gate 2 reports `dokploy_tools < 600` | the registry dropped tools again — look for `Rejected tool` lines in the container logs and for upstream schemas needing a higher `GATEWAY_MAX_SCHEMA_DEPTH` |
| deploy job 401/403 | `DOKPLOY_API_KEY` rotated; update the repo secret |
| deploy job complains `DOKPLOY_COMPOSE_ID` is not set | the repo variable was removed — it is the compose app's id, visible in Dokploy's compose URL |
| `websearch` missing from `discover_tools`, or its upstream populates 0 tools | the compose env lost the `websearch` key (a `saveEnvironment` that did not re-assert every key) or the pinned image predates the bundle — confirm `/opt/ccb-web-mcp/dist/index.js` exists in the running container, then re-apply the whole env block and redeploy |

## Vendored upstream: websearch

`upstreams/ccb-web-mcp/` is a keyless web search/fetch MCP server — three tools
(`web_search`, `web_fetch`, `web_search_health`) over three backends (bing,
tavily, exa), none of which needs an API key. It is vendored here and runs
**inside the gateway container** as a stdio child, so it needs no second
service, image or domain. Provenance and its licensing caveat:
`upstreams/ccb-web-mcp/NOTICE.md`.

Bundle, not source-run: the base image's node is 20 and native TypeScript
execution needs 22.6+, so the Dockerfile runs `npm ci` and a pinned
`esbuild@0.25.0` (`--bundle --platform=node --target=node20 --format=esm`) into
`dist/index.js`, then deletes `node_modules` and `test/`. The bundle inlines
`@modelcontextprotocol/sdk` and `zod`; `package.json` stays next to it so node
reads the output as ESM. Measured: 764124 bytes, identical in the build image.

Enabling or updating it — CI writes only the compose *file*, never the env, so
the registry entry is a deliberate step after the image carrying the code is
live:

1. edit `upstreams/ccb-web-mcp/`, push to `main`, wait for build-deploy to go
   green (both gates pass with or without this child running);
2. `compose.saveEnvironment` with the **whole** env block, adding
   `"websearch": {"mcpServers": {"websearch": {"command": "node",
   "args": ["/opt/ccb-web-mcp/dist/index.js"], "env": {"WEB_SEARCH_ADAPTER":
   "exa"}}}}` to `GATEWAY_UPSTREAMS`;
3. `compose.deploy`, then verify: container log
   `Populated 3 tools from upstream 'websearch'`, `discover_tools(domain="websearch")`
   listing all three, and `execute_tool` → `web_search` on a query whose answer
   you know (see the backend note below — a result *count* proves nothing).

**Per-upstream settings belong in that entry's `env`, never the container env.**
The gateway does not hand its own environment to stdio children: a
container-level `WEB_SEARCH_ADAPTER=exa` was deployed and confirmed present in
`/proc/1/environ`, and the child still defaulted to bing; moving the same key
into the entry's `env` block took effect immediately. `dokploy` and `infisical`
carry their credentials the same way for the same reason.

**The deployed default backend is `exa`, not the server's own `bing` default.**
Measured 2026-10-16 from both this host and the workstation: bing returned
unrelated SERPs — `"arch linux zram swap configuration"` came back as travel
destinations, then AI-funding pages, then a scholarship portal, a different set
per request, and `"ocisly barge landing"` returned porn and YouTube junk. bing
is nonetheless the backend the self-contained design prefers, so it is only
demoted in this deployment, per call overridable via the tool's `backend`
argument. `web_search_health` will *not* catch this class of failure: it counts
results and has no relevance signal, so it is a liveness probe only. tavily and
exa returned correct, source-worthy results for the same queries.

Per-call-independent knobs (`TAVILY_ENDPOINT_URL`, `EXA_API_KEY`,
`EXA_ENDPOINT_URL`, `WEB_FETCH_HTTP_TIMEOUT_MS`) go in the same `env` block and
are otherwise left at their defaults.

## Authenticated upstreams (github, oci, cloudflare)

**Why these are stdio children and not HTTP URLs.** `GATEWAY_UPSTREAM_HEADERS`
is applied on the *execution* path only (`client_manager._make_execution_client`);
registry **population** uses a separate client that takes
`GATEWAY_REGISTRY_AUTH_TOKEN` — a single bearer applied to *every* upstream — and
no per-domain headers. An HTTP upstream that needs auth to answer `tools/list`
therefore logs `Failed to populate upstream '<domain>' — skipping` with `401` and
never appears in `discover_tools`, even with a correct header entry. Measured on
2026-10-16: `github` and the Cloudflare per-product servers failed exactly this
way while the public `cloudflare-docs` server populated normally. Setting the
global registry token would "fix" it by sending one credential to all upstreams,
including third parties (context7, deepwiki) — not done here.

Each entry below therefore carries its credentials in its own `env`, which the
gateway passes to the child verbatim:

| domain | command | credential | surface |
|---|---|---|---|
| `github` | `github-mcp-server stdio --read-only` (vendored v2.0.2, MIT) | `GITHUB_PERSONAL_ACCESS_TOKEN` | 27 read-only tools (`repo:oracle/mcp` search verified live) |
| `oci` | `oracle.oci-api-mcp-server` (Oracle-official, pip 2.1.5) | `OCI_CLI_AUTH=api_key` + `OCI_CLI_USER`/`TENANCY`/`FINGERPRINT`/`REGION`/`KEY_CONTENT` | OCI CLI discovery + execution tools |
| `cloudflare` | `python /opt/cf-mcp-proxy/proxy.py` (vendored bridge) | `CLOUDFLARE_MCP_TOKEN` | 4 Code-Mode tools over ~2500 Cloudflare API endpoints |

**GitHub** is vendored as a static Go binary at image build (release tag pinned,
per-arch sha256 verified, `CGO_ENABLED=0` so it has no runtime deps). `--read-only`
is deliberate: this gateway executes tools unattended, so write tools are skipped
even if a model asks for them. To widen or narrow it, edit the entry's `args` in
the compose env (`--toolsets repos,issues`, or drop `--read-only`) — not the image.
`GITHUB_PERSONAL_ACCESS_TOKEN` currently holds the workstation `gh` OAuth token
(`gh auth token`); a fine-grained PAT works too and is the least-privilege option.
Rotate by re-running `gh auth token` and re-applying the env block.

**OCI** installs Oracle's official `oracle.oci-api-mcp-server`; its metadata says
`requires-python >=3.13` while this image is 3.12, so the install passes
`--ignore-requires-python` (verified working on 3.12, live `iam region list` and
`os ns get`). The release pins `oci-cli==3.89.3` and the server enforces that pair
at runtime. `OCI_CLI_AUTH=api_key` is load-bearing — without it the server probes
for a session-token profile first and fails on the missing config file. Credentials
come from the workstation profile `~/.oci/config`: user/tenancy/fingerprint/region
as plain values, and the private key as PEM **text** in `OCI_CLI_KEY_CONTENT`
(no file is written to disk in the container).

**Cloudflare** reaches the unified official server through a vendored 12-line
bridge (`upstreams/cloudflare-mcp-proxy/proxy.py`) rather than the usual
`mcp-remote` package, because `mcp-remote` answers a rejected credential with an
interactive OAuth flow and waits for a browser that never opens. Measured
2026-10-16: that call happens during registry population, so it blocked the whole
gateway — every client got **502** until the upstream was removed. The bridge
attaches one static header and fails fast instead: with a bad token it dies in
~6 s and population simply skips the domain. `CLOUDFLARE_MCP_TOKEN` is an
*account-owned API token* minted with `POST /accounts/<id>/tokens` (name `fastmcp-gateway-mcp`), scoped to 24 read-only
permission groups, non-expiring. The CLI's own OAuth session
(`~/.config/cloudflare/config/default.json`) **does** expire — it was ~40 minutes
from expiry when this was wired — which is why the durable token exists. Some
groups (`Workers Content Read-Only`, `Workers Metadata Read-Only`) are outside
that session's scopes and make the create call fail with HTTP 400 if requested.
Account-owned tokens have no user permissions, so the server's `/user` identity
probe fails by design and `/accounts` is the proof it works.

## Repo layout

| path | role |
|---|---|
| `Dockerfile` | the image: pinned gateway + the two patches + the vendored websearch bundle + the vendored OCI and GitHub upstreams |
| `upstreams/ccb-web-mcp/` | vendored stdio upstream `websearch` — source, tests, `NOTICE.md` |
| `gateway_middleware.py` | bearer auth on every non-probe route + `/healthz` version |
| `.github/workflows/build-deploy.yml` | build, pin, deploy, both gates |
| `DEPLOY.md` | this file |
