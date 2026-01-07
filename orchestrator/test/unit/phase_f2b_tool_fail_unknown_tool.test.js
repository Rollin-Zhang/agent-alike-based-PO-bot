/**
 * Phase F2B-1(2): tool_fail (unknown_tool) fill-path system-level test
 *
 * Contract:
 * - Unit test: Direct evidence emission validation (bypasses full HTTP pipeline for simplicity)
 * - Validates: tool_debug_v1 schema + emitToolFailEvidenceV1 wrapper + system rejection infrastructure
 * - Evidence chain: run_report_v1 + evidence_manifest_v1 + manifest_self_hash_v1 + tool_debug_v1
 * - Manifest checks[] must contain: reason_code='unknown_tool' + details_ref→tool_debug_v1
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { emitToolFailEvidenceV1 } = require('../../lib/evidence/emitToolFailEvidenceV1');
const { EVIDENCE_REASON_RUNTIME } = require('../../lib/evidence/ssot');

async function testToolFailUnknownTool() {
  console.log('[Test] testToolFailUnknownTool: START');

  const testLogsDir = process.env.LOGS_DIR || path.join(require('os').tmpdir(), `f2b_tool_fail_${Date.now()}`);
  fs.mkdirSync(testLogsDir, { recursive: true });

  // Override LOGS_DIR for test
  const origLogsDir = process.env.LOGS_DIR;
  process.env.LOGS_DIR = testLogsDir;

  try {
    // Test parameters
    const testTicketId = `tool_test_${Date.now()}`;
    const unknownToolName = 'definitely_unknown_tool_xyz_999';

    // Step 1: Call emitToolFailEvidenceV1 directly
    const result = await emitToolFailEvidenceV1({
      ticket_id: testTicketId,
      tool_name: unknownToolName,
      error_type: 'unknown_tool',
      message: `Unknown tool: ${unknownToolName}`,
      args_shape: { query: 'string', limit: 'number' },
      gateway_phase: 'fill_validation'
    });

    assert.ok(result.evidence_run_id, 'Missing evidence_run_id');

    const evidenceRunId = result.evidence_run_id;
    const runDirPath = path.join(testLogsDir, evidenceRunId);

    // Wait a bit for async file writes to complete
    await sleep(100);

    assert.ok(fs.existsSync(runDirPath), `Evidence run dir not found: ${runDirPath}`);

    // Step 2: Validate required artifacts (guardrail baseline)
    const requiredFiles = [
      'run_report_v1.json',
      'evidence_manifest_v1.json',
      'manifest_self_hash_v1.json',
      'tool_debug_v1.json'
    ];
    for (const f of requiredFiles) {
      const p = path.join(runDirPath, f);
      assert.ok(fs.existsSync(p), `Missing required artifact: ${f}`);
    }

    // Step 3: Validate manifest checks
    const manifest = JSON.parse(fs.readFileSync(path.join(runDirPath, 'evidence_manifest_v1.json'), 'utf8'));

    const check = (manifest.checks || []).find(c => c && c.name === 'system_rejection_evidence_ok');
    assert.ok(check, 'Missing system_rejection_evidence_ok check');
    assert.ok(Array.isArray(check.reason_codes) && check.reason_codes.includes(EVIDENCE_REASON_RUNTIME.UNKNOWN_TOOL), 'Missing unknown_tool reason code');
    assert.strictEqual(check.details_ref, 'tool_debug_v1.json', 'details_ref should point to tool_debug_v1.json');

    // Step 4: Validate tool_debug payload
    const toolDebug = JSON.parse(fs.readFileSync(path.join(runDirPath, 'tool_debug_v1.json'), 'utf8'));
    assert.strictEqual(toolDebug.version, 'v1');
    assert.strictEqual(toolDebug.ticket_id, testTicketId);
    assert.strictEqual(toolDebug.tool_name, unknownToolName);
    assert.strictEqual(toolDebug.error_type, 'unknown_tool');
    assert.ok(toolDebug.message && toolDebug.message.includes(unknownToolName), 'tool_debug.message should contain unknown tool name');
    assert.strictEqual(toolDebug.gateway_phase, 'fill_validation');

    // Validate args_shape
    assert.ok(toolDebug.args_shape, 'Missing args_shape');
    assert.strictEqual(typeof toolDebug.args_shape, 'object');
    assert.strictEqual(toolDebug.args_shape.query, 'string');
    assert.strictEqual(toolDebug.args_shape.limit, 'number');

    // Step 5: Validate manifest self-integrity
    const manifestSelfHash = JSON.parse(fs.readFileSync(path.join(runDirPath, 'manifest_self_hash_v1.json'), 'utf8'));
    assert.ok(manifestSelfHash.value, 'Missing manifest_self_hash value');
    assert.ok(manifestSelfHash.value.length === 64, 'Invalid manifest_self_hash value length');

    // Step 6: Validate run_report
    const runReport = JSON.parse(fs.readFileSync(path.join(runDirPath, 'run_report_v1.json'), 'utf8'));
    assert.strictEqual(runReport.version, 'v1');
    // Note: run_report.run_id is auto-generated UUID, not the evidence_run_id
    assert.ok(runReport.run_id, 'Missing run_report run_id');
    assert.strictEqual(runReport.terminal_status, 'failed');  // System rejection = failed (lowercase)
    assert.ok(runReport.as_of);

    console.log('[Test] testToolFailUnknownTool: PASS ✓');
    return true;
  } finally {
    // Restore original LOGS_DIR
    if (origLogsDir !== undefined) {
      process.env.LOGS_DIR = origLogsDir;
    } else {
      delete process.env.LOGS_DIR;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { testToolFailUnknownTool };


