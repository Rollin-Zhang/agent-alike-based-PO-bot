/**
 * Phase F2B isolated test runner (System-level failure-mode + concurrency)
 * Usage: NODE_ENV=test node test/unit/run_phase_f2b.js
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// Force test environment
process.env.NODE_ENV = 'test';

// Set up test-specific logs directory (avoid polluting repo)
const testLogsDir = path.join(os.tmpdir(), `phase_f2b_logs_${Date.now()}`);
fs.mkdirSync(testLogsDir, { recursive: true });
process.env.LOGS_DIR = testLogsDir;

let hadUnhandled = false;
process.on('unhandledRejection', (err) => {
  hadUnhandled = true;
  console.error('[Runner] Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  hadUnhandled = true;
  console.error('[Runner] Uncaught Exception:', err);
});

async function runTests() {
  console.log('=== Running Phase F2B Tests ===\n');
  console.log(`Test logs: ${testLogsDir}\n`);

  const tests = [
    ...Object.values(require('./phase_f2b_lease_owner_mismatch.test')),
    ...Object.values(require('./phase_f2b_readiness_blocked.test')),
    ...Object.values(require('./phase_f2b_tool_fail_unknown_tool.test'))
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      if (typeof test !== 'function') {
        throw new Error(`Invalid test entry type: ${typeof test}`);
      }
      const result = await test();
      if (result === false) failed++;
      else passed++;
    } catch (err) {
      console.error('[Runner] Test threw exception:', err);
      failed++;
    }
    console.log('');
  }

  console.log('=== Test Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (hadUnhandled) {
    console.error('\n❌ Detected unhandled async error(s) during test run');
    process.exit(1);
  }

  if (failed > 0) {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  }

  console.log('\n✅ All Phase F2B tests passed');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('[Runner] Fatal error:', err);
  process.exit(1);
});
