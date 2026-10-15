# Provenance and licensing

`ccb-web-mcp` is Shrijit's own server, vendored here so the gateway image can run
it as an in-container stdio upstream (`websearch`). This directory is the
canonical copy; `~/Projects/ccb-web-mcp` on the workstation is a scratch
checkout of the same code.

Search/fetch backends, result shapes and the Bing/Exa parsers are **ported from
[claude-code-best](https://github.com/claude-code-best/claude-code) v2.8.4**
(README.md credits it the same way). That upstream repository ships **no license
file** — GitHub reports `license: null` — so it grants no rights to its code and
none is claimed here for the ported parts.

Affected files, if that upstream's position ever has to be respected
differently: `src/backends/bing.ts`, `src/backends/exa.ts`,
`src/backends/tavily.ts`, and the result-shape types in `src/types.ts`.
Everything else (MCP wiring, fetch engine, domain filter, HTML entities,
tests) is original to this project.

Because this repository is public, the vendored copy is published in source form.
If that is not wanted, the two alternatives without changing the deploy path's
shape are: (a) keep only a compiled bundle here and fetch the source from a
private location in CI, or (b) rewrite the three backend parsers clean-room
against the same fixtures in `test/`.
