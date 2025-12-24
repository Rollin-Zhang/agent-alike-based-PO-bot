#!/bin/bash
# Commit 6 Acceptance Test Runner
# Purpose: Wrapper script to run all Commit 6 tests in one command
# Exit code: 0 = all pass, 1 = any failure
#
# This is a convenience script for local/CI usage.
# Do NOT rely on fixed execution time or output format.

set -e  # Exit on first failure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRATOR_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Commit 6 Acceptance Test Runner"
echo "  Running: npm run test:unit"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cd "$ORCHESTRATOR_DIR"

# Check prerequisites
if [ ! -f "package.json" ]; then
    echo "ERROR: package.json not found in $ORCHESTRATOR_DIR"
    exit 1
fi

# Run tests
npm run test:unit

# npm run test:unit already exits with proper code
# No need to reinterpret - just pass through

