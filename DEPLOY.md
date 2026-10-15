# Deployment — fastmcp-gateway-image (Dokploy)

This repo holds the runtime image for the aggregated MCP gateway at
`mcp.shrijit.tech`: the `fastmcp-gateway` Dokploy app plus two patches the
upstream package needs. Read the **Cutover not finished** section before
believing a push deployed anything.

## What ships from here

`.github/workflows/build-deploy.yml` (job `build`) builds and publishes

```
ghcr.io/shrijit37/fastmcp-gateway-image:<full sha>   (and :latest)
```

for `linux/amd64` **and** `linux/arm64` (the Dokploy host is arm64), with
`APP_VERSION=<sha>` as a build arg. The package is public, so a puller needs no
credentials; nothing secret is baked into the image.

Run it with **Actions → build → Run workflow** to publish a build without a
commit (useful after a Dokploy-side change).

## What actually runs

The Dokploy app `fastmcp-gateway` (`A9F6GcGMBXzeQl2V5foFh`, project
`mcp-gateway`, appName `app-mcp-gateway-ztgrvo`, `mcp.shrijit.tech` → port 8080)
is still **build-sourced**: every deploy builds a Dockerfile that lives in
`/etc/dokploy/applications/app-mcp-gateway-ztgrvo/code/` on the server and then
starts `app-mcp-gateway-ztgrvo:latest` from the local image store.

**Deviation, and the reason this doc exists:** pushes to this repo do **not**
change that Dockerfile, so a push here does not ship. The build log shows the
file it used (`transferring dockerfile: 1.41kB` while this repo's Dockerfile is
2.1 kB), and the container's `/usr/local/bin/gateway_entry.py` has no `os`
import — i.e. the running image predates commit `6396d68`.

## Cutover not finished

Certified against the live server on 2026-10-15, Dokploy `v0.30.8`:

- `application.saveDockerProvider` (image + `registryUrl: ghcr.io`) and
  `application.update {sourceType: "docker"}` both return `true` and change
  nothing observable. The app config reads `sourceType: ["ocker"]`, the same
  shape every docker-sourced app in this fleet reads, so the field is not a
  usable signal.
- `application.deploy` then still ran a Dockerfile build, and
  `application.redeploy` re-created the container from
  `app-mcp-gateway-ztgrvo:latest`; the Swarm service spec image never became the
  GHCR reference.
- A throwaway app created with `sourceType: "docker"` + `saveDockerProvider` +
  `redeploy` also ran a build (`Starting nixpacks build… Failed to read app
  source directory`). Probe apps were deleted; no domains were moved.
- Upstream logic agrees it should not build: `getBuildCommand` returns an empty
  command when `sourceType === "docker"` and `getImageName` returns
  `dockerImage` in that case — so the stored value is not `"docker"` for this
  app, and the API cannot set it. Fleet apps whose spec *does* point at a GHCR
  tag (dayboard, TripTribe) hold rows written before this version.

Remaining step — pick one, both need Dokploy-side access this repo has no
credentials for:

1. **Recreate the app as image-sourced** (matches the fleet standard): create a
   new application in project `mcp-gateway` with provider **Docker**, image
   `ghcr.io/shrijit37/fastmcp-gateway-image:<sha>`, domain `mcp.shrijit.tech`
   port 8080 with Let's Encrypt, then copy the app env (below) and deploy.
   Verify `/healthz` reports the SHA and the tool surface is complete, then
   delete the old app. Needs a short domain cutover window.
2. **Make the app repo-sourced**: set the GitHub provider to this repo
   (`shrijit37/fastmcp-gateway-image`, branch `main`, build type Dockerfile)
   and assert `buildArgs=APP_VERSION=<sha>` before each deploy so the `/healthz`
   version gate stays meaningful. **Tested on a throwaway app and it does not
   work as-is:** `saveGithubProvider` returns `true` and the fields read back,
   but the deploy never clones — it fails with
   `/bin/sh: 3: cd: can't cd to /etc/dokploy/applications/<app>/code/ … does not
   exist`. Dokploy's own provider listing reports `pull: false` for this repo,
   so the GitHub App installation cannot fetch it either; grant it access (or
   use a deploy key) before retrying.

Until one lands, the app's runtime correctness comes from its env block, not
from this repo — the tool-surface fix below survived rebuilds only for that
reason.

## Health

`GET /healthz` → `200 {"status":"ok","service":"fastmcp-gateway","version":"<sha>"}`,
`GET /readyz` → `200 {"status":"ready"}`. Routes are registered by the gateway
package; `service`/`version` are added by this repo's `health_version.py`, an
ASGI middleware loaded through the gateway's own `GATEWAY_MIDDLEWARE_MODULE` hook
(allowlisted by `GATEWAY_ALLOWED_MIDDLEWARE_PREFIXES` — both baked into the
image, both overridable from the app env).

**Deviation:** the fleet contract also wants a `checks` object derived from real
dependency probes. This service emits none — the gateway answers `ok` whenever
its process serves, and deliberately does not publish tool counts. Verify a
deploy by calling the gateway, not by reading `/healthz` alone:

```
POST /mcp  initialize →  tools/call discover_tools {domain:"dokploy"}
```

A healthy gateway lists 604 dokploy tools plus deepwiki (3) and context7 (2).

## Why the image patches upstream

`Dockerfile` installs `fastmcp-gateway==0.33.0` and applies two monkeypatches in
`/usr/local/bin/gateway_entry.py`; both are documented at the patch site:

1. **Relaxed tool-name validation** (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`). 0.33.0
   rejects every hyphenated name, which is all of `@dokploy/mcp` and context7.
2. **`GATEWAY_MAX_SCHEMA_DEPTH=12`** (package default 5). The registry silently
   skips any upstream tool whose `inputSchema` nests deeper than the cap:
   measured with the shipped `sanitize._schema_depth`, 20 dokploy tools sit at
   depth 6–10 (`application-update`, `ai-deploy`, `sso-register`,
   `admin-setupMonitoring`, the `*-update` CRUD set, …) and deepwiki's
   `ask_wiki_question` at 6. Every other tool across dokploy (584), context7 and
   deepwiki is ≤ 5. The package ceiling is 50 and its physical-recursion guard is
   untouched.

## App env (Dokploy, not this repo)

`GATEWAY_NAME=fastmcp-gateway`, `GATEWAY_HOST=0.0.0.0`, `GATEWAY_PORT=8080`,
`GATEWAY_REFRESH_INTERVAL=300`, `GATEWAY_TRACE_HEALTH_ROUTES=false`,
`GATEWAY_MAX_SCHEMA_DEPTH=12`, `GATEWAY_UPSTREAMS` (JSON: `context7`, `deepwiki`,
`dokploy` via stdio `npx -y @dokploy/mcp` with its own `DOKPLOY_URL` +
`DOKPLOY_API_KEY`), `GATEWAY_UPSTREAM_HEADERS` (JSON: the context7 bearer).

Two traps: `application.saveEnvironment` **replaces** the whole block, so
re-assert every key when changing one; and a plain deploy does not touch env at
all. `DOKPLOY_API_KEY` also exists as a repo secret (in Infisical
`platform`/`prod`) for the deploy step described above.

## Repo layout

| path | role |
|---|---|
| `Dockerfile` | the image: pinned gateway + the two patches |
| `health_version.py` | `/healthz` version middleware |
| `.github/workflows/build-deploy.yml` | build + publish job (no deploy job until the cutover lands) |
| `DEPLOY.md` | this file |
