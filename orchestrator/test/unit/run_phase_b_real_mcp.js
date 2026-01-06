/**
 * Phase B Real MCP Runner (versioned)
 *
 * Purpose:
 * - Provide a stable, version-controlled way to run Phase B real MCP tests
 *   without ad-hoc shell heredocs.
 *
 * Gate:
 * - RUN_REAL_MCP_TESTS=true
 */

async function main() {
  const tests = require('./phase_b_real_mcp.test');

  const order = [
    'testRealMcpProviderNotInitialized',
    'testMemoryReadOnlyPolicy',
    'testMemoryWriteBlocked',
    'testPhaseBProbesNoMcpMode',
    'testCreateProviderFromEnv',
    'testRealMcpProviderWithRealMcp',
    'testFullProbeRunWithRealMcp'
  ];

  let passed = 0;
  let failed = 0;

  for (const name of order) {
    try {
      await tests[name]();
      passed++;
    } catch (e) {
      failed++;
      console.error(`[FAIL] ${name}: ${e.message}`);
    }
  }

  console.log(`\n[PhaseB Summary] Passed: ${passed}, Failed: ${failed}, Total: ${order.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
