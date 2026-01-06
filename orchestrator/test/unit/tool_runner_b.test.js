/**
 * tool_runner_b.test.js
 * M2-B.2 Unit Tests: B-script executor SSOT + loop + verdict mapping
 * M2-B.2-v2: 新增 normalizeToolSteps + precedence + 派生唯一性測試
 */

const assert = require('assert');
const {
  REPORT_VERSION,
  EXIT_CODE,
  getWorstExitCode,
  mapRunReportStatusToVerdict,
  EXECUTOR_CODES,
  createReport,
  addSample,
  SAMPLE_LIMITS,
  REQUIRED_REPORT_KEYS,
  validateReportShape
} = require('../../lib/tool_runner/b_script_executor_ssot');

const path = require('path');
const {
  normalizeToolSteps,
  bridgeToolSteps
} = require('../../lib/tool_runner/b_script_bridge');

// ===== Test: Exit code worst 規則 =====

async function testExitCodeWorst() {
  console.log('[Test] testExitCodeWorst: START');
  
  // fatal 優先
  assert.strictEqual(getWorstExitCode([EXIT_CODE.OTHERWISE, EXIT_CODE.FATAL]), EXIT_CODE.FATAL);
  
  // failed 優先於 blocked
  assert.strictEqual(getWorstExitCode([EXIT_CODE.HAS_BLOCKED, EXIT_CODE.HAS_FAILED]), EXIT_CODE.HAS_FAILED);
  
  // blocked 次之
  assert.strictEqual(getWorstExitCode([EXIT_CODE.OTHERWISE, EXIT_CODE.HAS_BLOCKED]), EXIT_CODE.HAS_BLOCKED);
  
  // 空陣列 → otherwise
  assert.strictEqual(getWorstExitCode([]), EXIT_CODE.OTHERWISE);
  
  console.log('[Test] testExitCodeWorst: PASS ✓');
  return true;
}

// ===== Test: Verdict mapping =====

async function testVerdictMapping() {
  console.log('[Test] testVerdictMapping: START');
  
  assert.strictEqual(mapRunReportStatusToVerdict('ok'), 'PROCEED');
  assert.strictEqual(mapRunReportStatusToVerdict('failed'), 'DEFER');
  assert.strictEqual(mapRunReportStatusToVerdict('blocked'), 'DEFER');
  assert.strictEqual(mapRunReportStatusToVerdict('unknown'), 'DEFER'); // fallback
  
  console.log('[Test] testVerdictMapping: PASS ✓');
  return true;
}

// ===== Test: createReport 結構 =====

async function testCreateReport() {
  console.log('[Test] testCreateReport: START');
  
  const report = createReport({
    version: REPORT_VERSION,
    started_at: '2026-01-03T00:00:00.000Z',
    ended_at: '2026-01-03T00:01:00.000Z',
    duration_ms: 60000,
    executor_config: { no_mcp: true },
    worker: 'test_worker',
    counters: { total: 1, ok: 1 },
    by_code: { TOOL_TIMEOUT: 1 },
    samples: { ok: [{ ticket_id: 't1' }] },
    stable_codes: ['TOOL_TIMEOUT']
  });
  
  assert.strictEqual(report.version, REPORT_VERSION);
  assert.strictEqual(report.worker, 'test_worker');
  assert.strictEqual(report.counters.total, 1);
  assert.strictEqual(report.stable_codes[0], 'TOOL_TIMEOUT');
  
  console.log('[Test] testCreateReport: PASS ✓');
  return true;
}

// ===== Test: addSample 限制 =====

async function testAddSampleLimit() {
  console.log('[Test] testAddSampleLimit: START');
  
  const samples = { ok: [] };
  
  // 新增到上限
  for (let i = 0; i < SAMPLE_LIMITS.ok + 5; i++) {
    addSample(samples, 'ok', { ticket_id: `t${i}` }, SAMPLE_LIMITS.ok);
  }
  
  assert.strictEqual(samples.ok.length, SAMPLE_LIMITS.ok);
  
  console.log('[Test] testAddSampleLimit: PASS ✓');
  return true;
}

// ===== Test: EXECUTOR_CODES 穩定性 =====

async function testExecutorCodesStable() {
  console.log('[Test] testExecutorCodesStable: START');
  
  assert.strictEqual(EXECUTOR_CODES.EXECUTOR_FATAL, 'EXECUTOR_FATAL');
  assert.strictEqual(EXECUTOR_CODES.LEASE_OWNER_MISMATCH, 'lease_owner_mismatch');
  assert.strictEqual(EXECUTOR_CODES.DIRECT_FILL_NOT_ALLOWED, 'direct_fill_not_allowed');
  assert.strictEqual(EXECUTOR_CODES.DERIVE_FAILED, 'DERIVE_FAILED');
  assert.strictEqual(EXECUTOR_CODES.RELEASE_FAILED, 'RELEASE_FAILED');
  
  console.log('[Test] testExecutorCodesStable: PASS ✓');
  return true;
}

// ===== M2-B.2-v2 Tests =====

// Test: normalizeToolSteps 支援 {server, tool, args}
async function testNormalizeServerTool() {
  console.log('[Test] testNormalizeServerTool: START');
  
  const input = [
    { server: 'memory', tool: 'search_entities', args: { query: 'test' } }
  ];
  
  const output = normalizeToolSteps(input);
  
  assert.strictEqual(output.length, 1);
  // canonical = server (align with TOOL_ARGS_ALLOWLIST keys)
  assert.strictEqual(output[0].tool_name, 'memory');
  assert.ok(!output[0].tool_name.includes('.'), 'tool_name must not be server.tool');
  assert.deepStrictEqual(output[0].args, { query: 'test' });
  assert.strictEqual(output[0]._original_shape, 'server_tool');
  // Preserve tool detail for future gateway dispatch (NOT in args to avoid allowlist violation)
  assert.strictEqual(output[0]._original_tool, 'search_entities');
  
  console.log('[Test] testNormalizeServerTool: PASS ✓');
  return true;
}

// Test: normalizeToolSteps 支援 {tool_name, args}
async function testNormalizeToolName() {
  console.log('[Test] testNormalizeToolName: START');
  
  const input = [
    { tool_name: 'web_search', args: { query: 'test' } }
  ];
  
  const output = normalizeToolSteps(input);
  
  assert.strictEqual(output.length, 1);
  assert.strictEqual(output[0].tool_name, 'web_search');
  assert.deepStrictEqual(output[0].args, { query: 'test' });
  assert.strictEqual(output[0]._original_shape, 'tool_name');
  
  console.log('[Test] testNormalizeToolName: PASS ✓');
  return true;
}

// Test: precedence 鎖死 (metadata.tool_input.tool_steps 優先)
async function testToolStepsPrecedence() {
  console.log('[Test] testToolStepsPrecedence: START');
  
  const ticket = {
    id: 't1',
    metadata: {
      tool_input: {
        tool_steps: [{ tool_name: 'priority_tool', args: {} }]
      }
    },
    tool_steps: [{ tool_name: 'fallback_tool', args: {} }]
  };
  
  const bridged = bridgeToolSteps(ticket);
  
  assert.strictEqual(bridged.tool_steps.length, 1);
  assert.strictEqual(bridged.tool_steps[0].tool_name, 'priority_tool');
  
  console.log('[Test] testToolStepsPrecedence: PASS ✓');
  return true;
}

// D: Guardrail - B-script must not import/call deriveReplyTicketFromTool directly
async function testNoDirectDeriveReplyImportInBScript() {
  console.log('[Test] testNoDirectDeriveReplyImportInBScript: START');

  const scriptPath = path.join(__dirname, '../../scripts/tool_runner_b.js');
  const scriptContent = require('fs').readFileSync(scriptPath, 'utf-8');

  assert.ok(!scriptContent.includes('deriveReplyTicketFromTool'), 'B-script must not reference deriveReplyTicketFromTool');

  console.log('[Test] testNoDirectDeriveReplyImportInBScript: PASS ✓');
  return true;
}

// C: Guardrail - finalize success must prevent release in finally
async function testNoReleaseAfterFinalizeInBScript() {
  console.log('[Test] testNoReleaseAfterFinalizeInBScript: START');

  const scriptPath = path.join(__dirname, '../../scripts/tool_runner_b.js');
  const scriptContent = require('fs').readFileSync(scriptPath, 'utf-8');

  assert.ok(scriptContent.includes('let didFinalizeTicket = false'), 'B-script must track finalize flag');
  assert.ok(scriptContent.includes('finally'), 'B-script must have finally for release fallback');
  assert.ok(
    scriptContent.includes('if (!didFinalizeTicket)') || scriptContent.includes('if(!didFinalizeTicket)'),
    'B-script finally must gate release behind !didFinalizeTicket'
  );

  console.log('[Test] testNoReleaseAfterFinalizeInBScript: PASS ✓');
  return true;
}

// E: Guardrail - report schema must contain required keys + correct version
async function testReportSchemaValidator() {
  console.log('[Test] testReportSchemaValidator: START');

  const report = createReport({
    version: REPORT_VERSION,
    started_at: '2026-01-03T00:00:00.000Z',
    ended_at: '2026-01-03T00:01:00.000Z',
    duration_ms: 60000,
    executor_config: { no_mcp: true },
    worker: 'test_worker',
    counters: { total: 0 },
    by_code: {},
    samples: { ok: [], blocked: [], failed: [] },
    stable_codes: []
  });

  for (const k of REQUIRED_REPORT_KEYS) {
    assert.ok(k in report, `report must include key: ${k}`);
  }

  const v = validateReportShape(report);
  assert.strictEqual(v.ok, true, `validateReportShape should pass: ${v.errors?.join('; ')}`);

  console.log('[Test] testReportSchemaValidator: PASS ✓');
  return true;
}

module.exports = {
  testExitCodeWorst,
  testVerdictMapping,
  testCreateReport,
  testAddSampleLimit,
  testExecutorCodesStable,
  // M2-B.2-v2 新增測試
  testNormalizeServerTool,
  testNormalizeToolName,
  testToolStepsPrecedence,
  // Guardrails
  testNoDirectDeriveReplyImportInBScript,
  testNoReleaseAfterFinalizeInBScript,
  testReportSchemaValidator
};
