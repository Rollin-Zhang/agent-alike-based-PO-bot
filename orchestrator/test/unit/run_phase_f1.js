/**
 * Phase F1 isolated test runner
 * Usage: node test/unit/run_phase_f1.js
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
  console.log('=== Running Phase F1 Tests ===\n');

  const tests = [
    ...Object.values(require('./phase_f1_evidence_manifest_schema_lock.test')),
    ...Object.values(require('./phase_f1_evidence_manifest_hash_bytes.test')),
    ...Object.values(require('./phase_f1_guardrail_no_direct_manifest_write.test')),
    ...Object.values(require('./phase_f1_guardrail_writeRunReport_emits_manifest.test'))
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

  console.log('\n✅ All Phase F1 tests passed');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('[Runner] Fatal error:', err);
  process.exit(1);
});
