/**
 * M2-A.1 /health Readiness Test
 * 
 * 驗證 /health 永遠 200 並回傳 ReadinessSnapshot
 */

const assert = require('assert');
const axios = require('axios');
const { startServerWithEnv } = require('./helpers/server');
const { validateReadinessSnapshot, DEP_CODES } = require('../../lib/readiness/ssot');

async function testHealthWithNOMCP() {
  const { baseUrl, stop } = await startServerWithEnv({ NO_MCP: 'true' });

  try {
    const response = await axios.get(`${baseUrl}/health`);

    // Assert: status 200
    assert.strictEqual(response.status, 200, 'Should return 200');

    // Assert: body is valid ReadinessSnapshot
    const snapshot = response.data;
    const isValid = validateReadinessSnapshot(snapshot);
    assert.strictEqual(isValid, true, 'Should return valid ReadinessSnapshot');

    // Assert: degraded=true in NO_MCP mode
    assert.strictEqual(snapshot.degraded, true, 'Should be degraded in NO_MCP mode');

    // Assert: required deps have DEP_* codes (not HTTP codes)
    assert.strictEqual(snapshot.required.memory.ready, false);
    assert.ok(
      Object.values(DEP_CODES).includes(snapshot.required.memory.code),
      'memory code should be a DEP_* code'
    );
    assert.strictEqual(snapshot.required.web_search.ready, false);
    assert.ok(
      Object.values(DEP_CODES).includes(snapshot.required.web_search.code),
      'web_search code should be a DEP_* code'
    );

  } finally {
    await stop();
  }
}

// --- Run Tests ---

async function runHealthReadinessTests() {
  console.log('=== M2-A.1 /health Readiness Tests ===');
  
  try {
    await testHealthWithNOMCP();
    console.log('✓ GET /health with NO_MCP=true returns valid snapshot');
    console.log('\nPassed: 1, Failed: 0, Total: 1');
    return true;
  } catch (e) {
    console.error(`✗ Test failed: ${e.message}`);
    console.log('\nPassed: 0, Failed: 1, Total: 1');
    return false;
  }
}

if (require.main === module) {
  runHealthReadinessTests().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = { runAll: runHealthReadinessTests };
