/**
 * Simple test runner for unit tests
 * Usage: node test/unit/run.js
 */

async function runTests() {
  console.log('=== Running Unit Tests ===\n');

  const tests = [
    // Guard tests (run first to catch violations early)
    ...Object.values(require('./no_scattered_derived_access.test')),
    // Unit tests (pure logic, no HTTP)
    ...Object.values(require('./derive_triage_tool.test')),
    // Derived compat layer tests
    ...Object.values(require('./derived_compat.test')),
    // Integration tests (HTTP + NO_MCP)
    ...Object.values(require('./http_fill_derivation.test'))
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = await test();
      if (result) {
        passed++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`[Runner] Test threw exception:`, err);
      failed++;
    }
    console.log(''); // Blank line between tests
  }

  console.log('=== Test Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed > 0) {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[Runner] Fatal error:', err);
  process.exit(1);
});
