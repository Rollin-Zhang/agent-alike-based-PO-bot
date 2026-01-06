/**
 * Phase F2: Manifest failure rollback
 * - When manifest write fails, run_report_v1.json should be rolled back.
 * - No orphan files should remain.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunReportV1 } = require('../../lib/run_report/createRunReportV1');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { writeRunReportV1 } = require('../../lib/run_report/writeRunReportV1');

async function testPhaseF2ManifestFailureRollback() {
  console.log('[Test] testPhaseF2ManifestFailureRollback: START');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase_f2_rollback_'));
  const runDir = path.join(tmpDir, 'run_rollback_test');
  fs.mkdirSync(runDir, { recursive: true });

  const report = createRunReportV1({
    ticket_id: 'phase_f2_rollback',
    terminal_status: RUN_STATUS.OK,
    primary_failure_code: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 0,
    step_reports: [],
    attempt_events: []
  });

  // Test 1: Simulated manifest write failure (real-world scenario)
  const runReportPath = path.join(runDir, 'run_report_v1.json');
  let caughtError = false;

  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnv = process.env.EVIDENCE_MANIFEST_FORCE_FAIL;
  try {
    process.env.NODE_ENV = 'test';
    process.env.EVIDENCE_MANIFEST_FORCE_FAIL = '1';
    writeRunReportV1({ filePath: runReportPath, reportV1: report, run_id: 'run_fail_12345678' });
  } catch (err) {
    caughtError = true;
    assert.ok(err.message.includes('EVIDENCE_MANIFEST_FORCE_FAIL'), 'Error should be from forced failure');
  } finally {
    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;
    if (originalEnv !== undefined) process.env.EVIDENCE_MANIFEST_FORCE_FAIL = originalEnv;
    else delete process.env.EVIDENCE_MANIFEST_FORCE_FAIL;
  }

  assert.ok(caughtError, 'Should throw error for manifest write failure');
  
  // Verify no orphan files remain
  assert.ok(!fs.existsSync(runReportPath), 'run_report_v1.json should be rolled back');
  assert.ok(!fs.existsSync(path.join(runDir, 'evidence_manifest_v1.json')), 'manifest should not exist');
  assert.ok(!fs.existsSync(path.join(runDir, 'manifest_self_hash_v1.json')), 'self-hash should not exist');

  // Test 2: Valid write should succeed
  const validRunId = 'run_valid_12345678';
  writeRunReportV1({ filePath: runReportPath, reportV1: report, run_id: validRunId });

  assert.ok(fs.existsSync(runReportPath), 'run_report_v1.json should exist after valid write');
  assert.ok(fs.existsSync(path.join(runDir, 'evidence_manifest_v1.json')), 'manifest should exist after valid write');
  assert.ok(fs.existsSync(path.join(runDir, 'manifest_self_hash_v1.json')), 'self-hash should exist after valid write');

  // Test 3: Verify no *.tmp residual files remain (atomic rename verification)
  const files = fs.readdirSync(runDir);
  const tmpFiles = files.filter((f) => f.includes('.tmp'));
  assert.strictEqual(tmpFiles.length, 0, `Should not leave any .tmp files, found: ${tmpFiles.join(', ')}`);

  console.log('[Test] testPhaseF2ManifestFailureRollback: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF2ManifestFailureRollback
};
