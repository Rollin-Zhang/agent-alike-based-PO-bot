/**
 * Phase F2: Same directory collision guard
 * - Default policy: run_id must be unique (no overwrite)
 * - With ALLOW_RUN_ID_OVERWRITE=1: last writer wins
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

  // Test 1: Default policy - second write to same run_id should fail
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

  // Second write should throw (default policy)
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

  let caughtOverwriteError = false;
  try {
    writeRunReportV1({ filePath: runReportPath, reportV1: report2, run_id: runId });
  } catch (err) {
    caughtOverwriteError = true;
    assert.ok(err.message.includes('already exists'), 'Error should mention run_id already exists');
  }

  assert.ok(caughtOverwriteError, 'Should throw when attempting to overwrite without permission');
  
  // Verify first write remains untouched
  const stillFirstContent = fs.readFileSync(runReportPath, 'utf8');
  assert.strictEqual(stillFirstContent, firstContent, 'First write should remain unchanged after failed overwrite');

  // Test 2: With ALLOW_RUN_ID_OVERWRITE=1, last-writer-wins
  const runId2 = 'run_collision_override_87654321';
  const runDir2 = path.join(tmpDir, runId2);
  fs.mkdirSync(runDir2, { recursive: true });

  const originalEnv = process.env.ALLOW_RUN_ID_OVERWRITE;
  try {
    process.env.ALLOW_RUN_ID_OVERWRITE = '1';

    const runReportPath2 = path.join(runDir2, 'run_report_v1.json');
    writeRunReportV1({ filePath: runReportPath2, reportV1: report1, run_id: runId2 });

    await new Promise((resolve) => setTimeout(resolve, 10));

    writeRunReportV1({ filePath: runReportPath2, reportV1: report2, run_id: runId2 });

    const secondContent = fs.readFileSync(runReportPath2, 'utf8');
    assert.ok(secondContent.includes('phase_f2_collision_second'), 'Second write should succeed with override flag');

    const secondManifest = JSON.parse(fs.readFileSync(path.join(runDir2, 'evidence_manifest_v1.json'), 'utf8'));
    const artifacts = Array.isArray(secondManifest.artifacts) ? secondManifest.artifacts : [];
    const runReportArtifact = artifacts.find((a) => a.path === 'run_report_v1.json');
    
    const crypto = require('crypto');
    const actualSha = crypto.createHash('sha256').update(Buffer.from(secondContent, 'utf8')).digest('hex');
    assert.strictEqual(runReportArtifact.sha256, actualSha, 'Manifest sha256 must match second write');
  } finally {
    if (originalEnv !== undefined) process.env.ALLOW_RUN_ID_OVERWRITE = originalEnv;
    else delete process.env.ALLOW_RUN_ID_OVERWRITE;
  }

  console.log('[Test] testPhaseF2SameDirCollision: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF2SameDirCollision
};
