/**
 * Phase F1 guardrail:
 * - writeRunReportV1 must not leave an orphan run_report_v1.json without manifest.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunReportV1 } = require('../../lib/run_report/createRunReportV1');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { writeRunReportV1 } = require('../../lib/run_report/writeRunReportV1');

async function testPhaseF1GuardrailWriteRunReportEmitsManifest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase_f1_orphan_guard_'));
  const runDir = path.join(tmpDir, 'run_guard_12345678');
  fs.mkdirSync(runDir, { recursive: true });

  const report = createRunReportV1({
    ticket_id: 'phase_f1_orphan_guard',
    terminal_status: RUN_STATUS.OK,
    primary_failure_code: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 0,
    step_reports: [],
    attempt_events: []
  });

  const runReportPath = path.join(runDir, 'run_report_v1.json');
  writeRunReportV1({ filePath: runReportPath, reportV1: report, run_id: 'run_guard_12345678' });

  assert.ok(fs.existsSync(runReportPath), 'run_report_v1.json must exist');
  assert.ok(fs.existsSync(path.join(runDir, 'evidence_manifest_v1.json')), 'evidence_manifest_v1.json must exist');
  assert.ok(fs.existsSync(path.join(runDir, 'manifest_self_hash_v1.json')), 'manifest_self_hash_v1.json must exist');

  console.log('[Test] testPhaseF1GuardrailWriteRunReportEmitsManifest: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF1GuardrailWriteRunReportEmitsManifest
};
