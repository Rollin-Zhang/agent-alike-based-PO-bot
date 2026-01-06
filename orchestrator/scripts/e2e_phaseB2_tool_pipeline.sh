#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"

node "$repo_root/orchestrator/scripts/e2e_phaseB2_tool_pipeline.js" "$@"
