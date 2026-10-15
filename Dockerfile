FROM nikolaik/python-nodejs:python3.12-nodejs20

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

ENTRYPOINT ["python", "/usr/local/bin/gateway_entry.py"]
