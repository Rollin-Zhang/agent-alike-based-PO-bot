/**
 * M2-A.1 SSOT Schema Tests
 * 
 * 驗證 SSOT 定義的 schemas 與 fixtures
 */

const assert = require('assert');
const {
  validateReadinessSnapshot,
  validate503Body,
  validateMetricsReadinessShape,
  parseStrictInitFailOutput,
  HTTP_CODES,
  DEP_CODES,
  depsForToolName,
  REQUIRED_DEPS,
  OPTIONAL_DEPS
} = require('../../lib/readiness/ssot');

// --- Test: ReadinessSnapshot Schema ---

function testValidReadinessSnapshot() {
  const validSnapshot = {
    degraded: true,
    required: {
      memory: { ready: false, code: DEP_CODES.UNAVAILABLE, detail: { reason: 'NO_MCP' } },
      web_search: { ready: false, code: DEP_CODES.UNAVAILABLE }
    },
    optional: {
      notebooklm: { ready: false, code: DEP_CODES.UNAVAILABLE }
    },
    as_of: '2026-01-01T12:00:00.000Z'
  };

  const result = validateReadinessSnapshot(validSnapshot);
  assert.strictEqual(result, true, 'Valid snapshot should pass validation');
}

function testInvalidSnapshotWithHTTPCode() {
  // Violation: /health.required.*.code 禁止出現 MCP_REQUIRED_UNAVAILABLE
  const invalidSnapshot = {
    degraded: true,
    required: {
      memory: { ready: false, code: HTTP_CODES.REQUIRED_UNAVAILABLE }, // INVALID
      web_search: { ready: false, code: DEP_CODES.UNAVAILABLE }
    },
    optional: {
      notebooklm: { ready: false, code: DEP_CODES.UNAVAILABLE }
    },
    as_of: '2026-01-01T12:00:00.000Z'
  };

  const result = validateReadinessSnapshot(invalidSnapshot);
  assert.strictEqual(result, false, 'Snapshot with HTTP code in dep field should fail');
}

// --- Test: 503 Body Schema ---

function testValid503Body() {
  const validBody = {
    error_code: HTTP_CODES.REQUIRED_UNAVAILABLE,
    missing_required: ['memory', 'web_search'],
    degraded: true,
    as_of: '2026-01-01T12:00:00.000Z'
  };

  const result = validate503Body(validBody);
  assert.strictEqual(result, true, '503 body should pass validation');
}

function testInvalid503BodyWrongCode() {
  const invalidBody = {
    error_code: 'WRONG_CODE', // Must be MCP_REQUIRED_UNAVAILABLE
    missing_required: ['memory'],
    degraded: true,
    as_of: '2026-01-01T12:00:00.000Z'
  };

  const result = validate503Body(invalidBody);
  assert.strictEqual(result, false, '503 body with wrong error_code should fail');
}

// --- Test: Metrics Readiness Shape ---

function testValidMetricsShape() {
  const validShape = {
    degraded: 1,
    required_ready: { memory: 0, web_search: 0 },
    optional_ready: { notebooklm: 0 },
    required_unavailable_total: {
      'memory|MCP_REQUIRED_UNAVAILABLE': 5,
      'web_search|MCP_REQUIRED_UNAVAILABLE': 3
    }
  };

  const result = validateMetricsReadinessShape(validShape);
  assert.strictEqual(result, true, 'Valid metrics shape should pass');
}

function testInvalidMetricsShapeWithDepCode() {
  // Violation: counter keys 禁止包含 DEP_* codes
  const invalidShape = {
    degraded: 1,
    required_ready: { memory: 0, web_search: 0 },
    optional_ready: { notebooklm: 0 },
    required_unavailable_total: {
      'memory|DEP_UNAVAILABLE': 5  // INVALID: DEP code in counter
    }
  };

  const result = validateMetricsReadinessShape(invalidShape);
  assert.strictEqual(result, false, 'Metrics shape with DEP code in counter should fail');
}

// --- Test: Strict Init Output Parsing ---

function testParseStrictInitOutput() {
  const snapshot = {
    degraded: true,
    required: {
      memory: { ready: false, code: DEP_CODES.UNAVAILABLE },
      web_search: { ready: false, code: DEP_CODES.UNAVAILABLE }
    },
    optional: {
      notebooklm: { ready: false, code: DEP_CODES.UNAVAILABLE }
    },
    as_of: '2026-01-01T12:00:00.000Z'
  };

  const line = '[readiness][strict_init_fail] ' + JSON.stringify(snapshot);
  const parsed = parseStrictInitFailOutput(line);

  assert.notStrictEqual(parsed, null, 'Should successfully parse strict init output');
  assert.strictEqual(parsed.degraded, true);
  assert.strictEqual(parsed.required.memory.ready, false);
}

function testParseInvalidPrefix() {
  const line = '[wrong][prefix] {"degraded":true}';
  const parsed = parseStrictInitFailOutput(line);
  assert.strictEqual(parsed, null, 'Should return null for wrong prefix');
}

// --- Test: depsForToolName unknown fallback guardrail ---

function testDepsForToolNameUnknownFallbackIsConservative() {
  const required = REQUIRED_DEPS.map(d => d.key);

  // Guardrail: unknown toolName must fallback to conservative required deps
  assert.deepStrictEqual(
    depsForToolName('__unknown__'),
    required,
    'unknown toolName should fallback to required deps (conservative gating)'
  );

  // Also cover non-string toolName (invalid) to ensure it does not bypass gating
  assert.deepStrictEqual(
    depsForToolName(null),
    required,
    'non-string toolName should still require required deps'
  );
}

// --- Run All Tests ---

function runSSOTSchemaTests() {
  const tests = [
    { name: 'Valid ReadinessSnapshot', fn: testValidReadinessSnapshot },
    { name: 'Invalid snapshot with HTTP code in dep field', fn: testInvalidSnapshotWithHTTPCode },
    { name: 'Valid 503 body', fn: testValid503Body },
    { name: 'Invalid 503 body with wrong code', fn: testInvalid503BodyWrongCode },
    { name: 'Valid metrics shape', fn: testValidMetricsShape },
    { name: 'Invalid metrics shape with DEP code', fn: testInvalidMetricsShapeWithDepCode },
    { name: 'Parse strict init output', fn: testParseStrictInitOutput },
    { name: 'Parse invalid prefix', fn: testParseInvalidPrefix },
    { name: 'depsForToolName unknown fallback is conservative', fn: testDepsForToolNameUnknownFallbackIsConservative }
  ];

  console.log('=== M2-A.1 SSOT Schema Tests ===');
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
  const success = runSSOTSchemaTests();
  process.exit(success ? 0 : 1);
}

module.exports = { runAll: runSSOTSchemaTests };
