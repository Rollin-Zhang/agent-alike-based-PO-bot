#!/usr/bin/env node
'use strict';

/**
 * accept_no_mcp.js (M2-C.2)
 * One-click acceptance for NO_MCP mode.
 *
 * What it does:
 * - Runs startup probes under NO_MCP=true
 * - Runs full unit test suite (includes NO_MCP HTTP integration tests)
 */

const { spawnSync } = require('child_process');

function run(cmd, args, env) {
  const res = spawnSync(cmd, args, {
    env,
    stdio: 'inherit'
  });
  if (res.error) throw res.error;
  if (typeof res.status === 'number' && res.status !== 0) {
    process.exit(res.status);
  }
}

function main() {
  const env = { ...process.env, NO_MCP: 'true' };

  console.log('[accept:no_mcp] Running probes (NO_MCP=true)...');
  run(process.execPath, ['scripts/run_probes.js'], env);

  console.log('[accept:no_mcp] Running unit tests (NO_MCP=true)...');
  run(process.execPath, ['test/unit/run.js'], env);

  console.log('[accept:no_mcp] PASS');
}

main();
