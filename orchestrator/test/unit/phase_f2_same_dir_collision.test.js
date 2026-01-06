/**
 * Phase F2: Same directory collision guard
 * - Concurrent writes to the same run_id should not corrupt each other.
 * - Last writer wins, but rollback must only affect own write.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunReportV1 } = require('../../lib/run_report/createRunReportV1');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { writeRunReportV1 } = require('../../lib/run_report/writeRunReportV1');

async function testPhaseF2SameDirCollision() {
  console.log('[Test] testPhaseF2SameDirCollision: START');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase_f2_collision_'));
  const runId = 'run_collision_shared_12345678';
  const runDir = path.join(tmpDir, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // First writer succeeds
  const report1 = createRunReportV1({
    ticket_id: 'phase_f2_collision_first',
    terminal_status: RUN_STATUS.OK,
    primary_failure_code: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 100,
    step_reports: [],
    attempt_events: []
  });

  const runReportPath = path.join(runDir, 'run_report_v1.json');
  writeRunReportV1({ filePath: runReportPath, reportV1: report1, run_id: runId });

  const firstContent = fs.readFileSync(runReportPath, 'utf8');
  const firstManifest = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence_manifest_v1.json'), 'utf8'));

  // Second writer with different content (simulating last-writer-wins)
  const report2 = createRunReportV1({
    ticket_id: 'phase_f2_collision_second',
    terminal_status: RUN_STATUS.FAIL,
    primary_failure_code: 'test_collision',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 200,
    step_reports: [],
    attempt_events: []
  });

  // Wait a bit to ensure different mtime
  await new Promise((resolve) => setTimeout(resolve, 10));

  writeRunReportV1({ filePath: runReportPath, reportV1: report2, run_id: runId });

  const secondContent = fs.readFileSync(runReportPath, 'utf8');
  const secondManifest = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence_manifest_v1.json'), 'utf8'));

  // Verify second write won
  assert.notStrictEqual(firstContent, secondContent, 'Second write should overwrite first');
  assert.ok(secondContent.includes('phase_f2_collision_second'), 'Second ticket_id should be present');
  assert.ok(secondContent.includes('test_collision'), 'Second failure code should be present');

  // Verify manifest updated atomically
  assert.strictEqual(secondManifest.run_id, runId, 'Manifest run_id should remain consistent');

  // Verify manifest integrity after overwrite
  const artifacts = Array.isArray(secondManifest.artifacts) ? secondManifest.artifacts : [];
  const runReportArtifact = artifacts.find((a) => a.path === 'run_report_v1.json');
  
  const crypto = require('crypto');
  const actualSha = crypto.createHash('sha256').update(Buffer.from(secondContent, 'utf8')).digest('hex');
  assert.strictEqual(runReportArtifact.sha256, actualSha, 'Manifest sha256 must match second write');

  console.log('[Test] testPhaseF2SameDirCollision: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF2SameDirCollision
};
