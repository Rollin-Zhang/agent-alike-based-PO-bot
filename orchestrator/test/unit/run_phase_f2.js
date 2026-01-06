/**
 * Phase F2 isolated test runner
 * Usage: node test/unit/run_phase_f2.js
 */

'use strict';

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
  console.log('=== Running Phase F2 Tests ===\n');

  const tests = [
    ...Object.values(require('./phase_f2_concurrent_write_isolation.test')),
    ...Object.values(require('./phase_f2_manifest_failure_rollback.test')),
    ...Object.values(require('./phase_f2_reader_consistency.test')),
    ...Object.values(require('./phase_f2_same_dir_collision.test'))
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

  console.log('\n✅ All Phase F2 tests passed');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('[Runner] Fatal error:', err);
  process.exit(1);
});
