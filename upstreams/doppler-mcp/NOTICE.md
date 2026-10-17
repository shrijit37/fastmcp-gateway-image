# Provenance and licensing

`doppler-mcp` is original code written for this repository. It contains no
third-party source: the six tools are thin, closed-schema wrappers over the
public Doppler REST API v3 (`https://api.doppler.com`), called with Python's
standard-library `urllib`, and the MCP wiring uses the `mcp` Python SDK that the
image's `fastmcp-gateway` dependency already installs. No code from Doppler's
official `@dopplerhq/mcp-server` was copied, ported or vendored — that server is
*not* used, and the reason is recorded in `README.md`: its OpenAPI-generated
schemas declare `additionalProperties: true` at the root, which the gateway
registry rejects, so 12 of its 13 tools never register.

The API this server calls is a public, documented HTTP interface at
`https://api.doppler.com`; using it is subject to Doppler's terms of service, and
nothing here re-licenses Doppler's service or data. The name "Doppler" is used
descriptively.

Dependencies arrive with the base image (`nikolaik/python-nodejs`,
`fastmcp-gateway==0.33.0` → `fastmcp` → `mcp`), each under its own license, and
none is bundled into this directory. There is no vendored license text to carry
because there is no vendored third-party code.

Because this repository is public, the server is published in source form. The
only thing it must never contain is a credential: the token comes from
`DOPPLER_TOKEN` in the upstream's `env` block (`../../DEPLOY.md`), is put only in
the `Authorization` header, and is redacted from any error text.
