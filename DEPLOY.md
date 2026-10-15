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
`service`/`version` are added by this repo's `health_version.py`, an ASGI
middleware loaded through the gateway's own `GATEWAY_MIDDLEWARE_MODULE` hook
(allowlisted by `GATEWAY_ALLOWED_MIDDLEWARE_PREFIXES` — both baked into the
image, both overridable from the compose env).

**Deviation:** the fleet contract also wants a `checks` object built from real
dependency probes. This service emits none — the gateway answers `ok` whenever
its process serves and deliberately does not publish tool counts. The real
dependency assertion is CI gate 2, and the same check by hand is:

```
POST /mcp  initialize → tools/call discover_tools {domain:"dokploy"}
```

A healthy gateway lists 604 dokploy tools plus deepwiki (3) and context7 (2).
There is no Docker health check on the service.

Soundness caveat: Tool count is a proxy for "all three upstreams came up", not
proof that a given tool does the right thing — as with the schema fix, a
rejected tool shows up as a missing name, which is what gate 2 watches.

## Secrets

Repo-level: secret `DOKPLOY_API_KEY` (also in Infisical `platform`/`prod`), vars
`DOKPLOY_URL` and `DOKPLOY_COMPOSE_ID`. The deploy job uses them only to write
the compose file and roll the app.

Runtime configuration is the compose app's **encrypted env block**, which a
deploy never rewrites (`compose.update` without an `env` key leaves it
byte-identical — checked):

- `GATEWAY_UPSTREAMS` — JSON: `context7` (HTTP), `deepwiki` (HTTP), `dokploy`
  (stdio `npx -y @dokploy/mcp`, with its own `DOKPLOY_URL` + `DOKPLOY_API_KEY`).
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

## Repo layout

| path | role |
|---|---|
| `Dockerfile` | the image: pinned gateway + the two patches |
| `health_version.py` | `/healthz` version middleware |
| `.github/workflows/build-deploy.yml` | build, pin, deploy, both gates |
| `DEPLOY.md` | this file |
