#!/usr/bin/env bash
set -euo pipefail

# Phase A (NO_MCP) end-to-end smoke runner
# Exit codes:
#   0  PASS
#   2  runtime/server error
#   7  contract drift (schema/shape mismatch)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/e2e_smoke_phaseA_no_mcp.js"
