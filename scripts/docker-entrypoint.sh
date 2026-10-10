#!/bin/sh
set -eu
# Explicit commands remain available for diagnostics and one-off jobs.
if [ "$#" -gt 0 ]; then exec "$@"; fi
case "${NAVI_MODE:-host}" in
  host)
    : "${NAVI_TENANTS:?Set NAVI_TENANTS to production key:tenantId pairs}"
    exec node server/index.js --host "${NAVI_HOST:-0.0.0.0}" --port "${NAVI_PORT:-3000}" --store "${NAVI_STORE:-/data/telemetry.db}"
    ;;
  mcp)
    # Docker needs a container-wide listener for port forwarding, so require a
    # token even when a caller overrides NAVI_HOST to loopback.
    : "${NAVI_MCP_TOKEN:?Set a strong NAVI_MCP_TOKEN before starting MCP}"
    exec node bin/navi-mcp.js --transport sse --host "${NAVI_HOST:-0.0.0.0}" --port "${NAVI_PORT:-3001}" --max-sessions "${NAVI_MCP_MAX_SESSIONS:-2}" --idle-timeout "${NAVI_MCP_IDLE_TIMEOUT:-300}"
    ;;
  *) echo 'NAVI_MODE must be host or mcp' >&2; exit 2 ;;
esac
