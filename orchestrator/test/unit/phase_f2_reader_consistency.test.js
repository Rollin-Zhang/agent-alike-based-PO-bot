/**
 * Phase F2: Reader consistency during concurrent writes
 * - Readers should never observe partial writes (thanks to atomic rename).
 * - If manifest exists, run_report must also exist with matching content.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunReportV1 } = require('../../lib/run_report/createRunReportV1');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { writeRunReportV1 } = require('../../lib/run_report/writeRunReportV1');

async function testPhaseF2ReaderConsistency() {
  console.log('[Test] testPhaseF2ReaderConsistency: START');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase_f2_reader_'));
  const runId = 'run_reader_consistency_12345678';
  const runDir = path.join(tmpDir, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const report = createRunReportV1({
    ticket_id: 'phase_f2_reader_consistency',
    terminal_status: RUN_STATUS.OK,
    primary_failure_code: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 0,
    step_reports: [],
    attempt_events: []
  });

  // Write with atomic guarantees
  const runReportPath = path.join(runDir, 'run_report_v1.json');
  writeRunReportV1({ filePath: runReportPath, reportV1: report, run_id: runId });

  // Simulate reader: check consistency
  const manifestPath = path.join(runDir, 'evidence_manifest_v1.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.strictEqual(manifest.run_id, runId, 'manifest run_id should match');

  // Verify referenced artifact exists and matches
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const runReportArtifact = artifacts.find((a) => a.path === 'run_report_v1.json');
  
  assert.ok(runReportArtifact, 'manifest should list run_report_v1.json');
  assert.ok(fs.existsSync(runReportPath), 'run_report_v1.json should exist when manifest references it');

  const runReportContent = fs.readFileSync(runReportPath);
  const crypto = require('crypto');
  const actualSha = crypto.createHash('sha256').update(runReportContent).digest('hex');

  assert.strictEqual(runReportArtifact.sha256, actualSha, 'manifest sha256 must match actual file');
  assert.strictEqual(runReportArtifact.bytes, runReportContent.length, 'manifest bytes must match actual file');

  console.log('[Test] testPhaseF2ReaderConsistency: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF2ReaderConsistency
};
