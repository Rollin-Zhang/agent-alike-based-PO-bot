#!/usr/bin/env node
'use strict';

/**
 * accept_real_mcp.js (M2-C.2)
 * One-click acceptance for Real MCP mode.
 *
 * What it does:
 * - Runs startup probes with RUN_REAL_MCP_TESTS=true (RealMcpProvider)
 * - Runs full unit test suite with RUN_REAL_MCP_TESTS=true (un-skips real MCP tests)
 *
 * Notes:
 * - This will fail if your MCP servers are not reachable per MCP_CONFIG_PATH.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function run(cmd, args, env, cwd) {
  const res = spawnSync(cmd, args, {
    env,
    cwd,
    stdio: 'inherit'
  });
  if (res.error) throw res.error;
  if (typeof res.status === 'number' && res.status !== 0) {
    process.exit(res.status);
  }
}

function main() {
  const repoRoot = path.resolve(__dirname, '../..');
  const defaultConfigPath = path.resolve(__dirname, '../mcp_config.json');
  const configPath = process.env.MCP_CONFIG_PATH ? path.resolve(process.env.MCP_CONFIG_PATH) : defaultConfigPath;

  if (!fs.existsSync(configPath)) {
    console.error(`[accept:real_mcp] MCP_CONFIG_PATH not found: ${configPath}`);
    console.error('[accept:real_mcp] Set MCP_CONFIG_PATH to a valid config, then re-run.');
    process.exit(2);
  }

  const env = {
    ...process.env,
    NO_MCP: 'false',
    RUN_REAL_MCP_TESTS: 'true',
    MCP_CONFIG_PATH: configPath
  };

  console.log(`[accept:real_mcp] Using MCP_CONFIG_PATH=${configPath}`);

  console.log('[accept:real_mcp] Running probes (RUN_REAL_MCP_TESTS=true)...');
  run(process.execPath, ['orchestrator/scripts/run_probes.js'], env, repoRoot);

  console.log('[accept:real_mcp] Running unit tests (RUN_REAL_MCP_TESTS=true)...');
  run(process.execPath, ['orchestrator/test/unit/run.js'], env, repoRoot);

  console.log('[accept:real_mcp] PASS');
}

main();
