/**
 * M2-A.1 Readiness Evaluator Tests
 * 
 * 驗證 evaluator 行為：NO_MCP 等價、degraded 判定
 */

const assert = require('assert');
const { evaluateReadiness } = require('../../lib/readiness/evaluateReadiness');
const { DEP_CODES } = require('../../lib/readiness/ssot');

// --- Test: NO_MCP Equivalent (all deps unavailable) ---

function testNOMCPEquivalent() {
  const depStates = {
    memory: { ready: false, code: DEP_CODES.UNAVAILABLE, detail: { reason: 'NO_MCP' } },
    web_search: { ready: false, code: DEP_CODES.UNAVAILABLE, detail: { reason: 'NO_MCP' } },
    notebooklm: { ready: false, code: DEP_CODES.UNAVAILABLE, detail: { reason: 'NO_MCP' } }
  };

  const snapshot = evaluateReadiness(depStates, new Date());

  assert.strictEqual(snapshot.degraded, true, 'Should be degraded when all deps unavailable');
  assert.strictEqual(snapshot.required.memory.ready, false);
  assert.strictEqual(snapshot.required.memory.code, DEP_CODES.UNAVAILABLE);
  assert.strictEqual(snapshot.required.web_search.ready, false);
  assert.strictEqual(snapshot.required.web_search.code, DEP_CODES.UNAVAILABLE);
  assert.strictEqual(snapshot.optional.notebooklm.ready, false);
  assert.strictEqual(snapshot.optional.notebooklm.code, DEP_CODES.UNAVAILABLE);
}

// --- Test: Optional false + Required true => degraded but required ready ---

function testOptionalFalseRequiredTrue() {
  const depStates = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null },
    notebooklm: { ready: false, code: DEP_CODES.UNAVAILABLE }
  };

  const snapshot = evaluateReadiness(depStates, new Date());

  // Optional 不 ready => degraded=true
  assert.strictEqual(snapshot.degraded, true, 'Should be degraded when optional unavailable');
  
  // Required 仍 ready
  assert.strictEqual(snapshot.required.memory.ready, true);
  assert.strictEqual(snapshot.required.memory.code, null);
  assert.strictEqual(snapshot.required.web_search.ready, true);
  assert.strictEqual(snapshot.required.web_search.code, null);
  
  // Optional 不 ready
  assert.strictEqual(snapshot.optional.notebooklm.ready, false);
  assert.strictEqual(snapshot.optional.notebooklm.code, DEP_CODES.UNAVAILABLE);
}

// --- Test: All ready => not degraded ---

function testAllReady() {
  const depStates = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null },
    notebooklm: { ready: true, code: null }
  };

  const snapshot = evaluateReadiness(depStates, new Date());

  assert.strictEqual(snapshot.degraded, false, 'Should not be degraded when all deps ready');
  assert.strictEqual(snapshot.required.memory.ready, true);
  assert.strictEqual(snapshot.required.web_search.ready, true);
  assert.strictEqual(snapshot.optional.notebooklm.ready, true);
}

// --- Test: Missing provider in depStates => treated as unavailable ---

function testMissingProvider() {
  const depStates = {
    // memory missing
    web_search: { ready: true, code: null },
    notebooklm: { ready: true, code: null }
  };

  const snapshot = evaluateReadiness(depStates, new Date());

  // Missing provider treated as unavailable
  assert.strictEqual(snapshot.degraded, true, 'Should be degraded when required provider missing');
  assert.strictEqual(snapshot.required.memory.ready, false);
  assert.strictEqual(snapshot.required.memory.code, DEP_CODES.UNAVAILABLE);
}

// --- Run All Tests ---

function runEvaluatorTests() {
  const tests = [
    { name: 'NO_MCP equivalent (all unavailable)', fn: testNOMCPEquivalent },
    { name: 'Optional false + Required true => degraded', fn: testOptionalFalseRequiredTrue },
    { name: 'All ready => not degraded', fn: testAllReady },
    { name: 'Missing provider => unavailable', fn: testMissingProvider }
  ];

  console.log('=== M2-A.1 Readiness Evaluator Tests ===');
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      test.fn();
      console.log(`✓ ${test.name}`);
      passed++;
    } catch (e) {
      console.error(`✗ ${test.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nPassed: ${passed}, Failed: ${failed}, Total: ${tests.length}`);
  return failed === 0;
}

if (require.main === module) {
  const success = runEvaluatorTests();
  process.exit(success ? 0 : 1);
}

module.exports = { runAll: runEvaluatorTests };
