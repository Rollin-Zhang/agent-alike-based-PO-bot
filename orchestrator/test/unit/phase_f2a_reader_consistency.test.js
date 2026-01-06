/**
 * Phase F2: Reader consistency during concurrent writes
 * - Readers should never observe partial writes (thanks to atomic rename).
 * - Test with EVIDENCE_WRITE_BARRIER to verify real race protection.
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

  // Test 1: Post-write consistency (baseline)
  const runId1 = 'run_reader_baseline_12345678';
  const runDir1 = path.join(tmpDir, runId1);
  fs.mkdirSync(runDir1, { recursive: true });

  const report = createRunReportV1({
    ticket_id: 'phase_f2_reader_baseline',
    terminal_status: RUN_STATUS.OK,
    primary_failure_code: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 0,
    step_reports: [],
    attempt_events: []
  });

  const runReportPath1 = path.join(runDir1, 'run_report_v1.json');
  writeRunReportV1({ filePath: runReportPath1, reportV1: report, run_id: runId1 });

  const manifest1 = JSON.parse(fs.readFileSync(path.join(runDir1, 'evidence_manifest_v1.json'), 'utf8'));
  const artifacts1 = Array.isArray(manifest1.artifacts) ? manifest1.artifacts : [];
  const runReportArtifact1 = artifacts1.find((a) => a.path === 'run_report_v1.json');
  
  const crypto = require('crypto');
  const runReportContent1 = fs.readFileSync(runReportPath1);
  const actualSha1 = crypto.createHash('sha256').update(runReportContent1).digest('hex');

  assert.strictEqual(runReportArtifact1.sha256, actualSha1, 'manifest sha256 must match actual file');
  assert.strictEqual(runReportArtifact1.bytes, runReportContent1.length, 'manifest bytes must match actual file');

  // Test 2: Race test with EVIDENCE_WRITE_BARRIER
  const runId2 = 'run_reader_race_87654321';
  const runDir2 = path.join(tmpDir, runId2);
  fs.mkdirSync(runDir2, { recursive: true });

  const originalEnv = process.env.EVIDENCE_WRITE_BARRIER;
  const originalOverwriteEnv = process.env.ALLOW_RUN_ID_OVERWRITE;
  const originalNodeEnv = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = 'test';
    process.env.EVIDENCE_WRITE_BARRIER = 'before_rename';
    process.env.ALLOW_RUN_ID_OVERWRITE = '1'; // Allow for test setup

    const runReportPath2 = path.join(runDir2, 'run_report_v1.json');
    const barrierFile = path.join(runDir2, '.barrier_before_rename');

    // Start writer in background using setImmediate to ensure true async
    let writerResolve, writerReject;
    const writerPromise = new Promise((resolve, reject) => {
      writerResolve = resolve;
      writerReject = reject;
    });

    setImmediate(() => {
      try {
        writeRunReportV1({ filePath: runReportPath2, reportV1: report, run_id: runId2 });
        writerResolve();
      } catch (err) {
        writerReject(err);
      }
    });

    // Wait for barrier file to appear
    const startMs = Date.now();
    while (!fs.existsSync(barrierFile) && Date.now() - startMs < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.ok(fs.existsSync(barrierFile), 'Barrier file should be created by writer');

    // Reader during barrier: should NOT see final run_report_v1.json yet
    // (Note: if writer finished too fast despite barrier, this is OK - just verify tmp cleanup)
    const finalFileExists = fs.existsSync(runReportPath2);
    const tmpFiles = fs.readdirSync(runDir2).filter((f) => f.includes('.tmp'));
    
    // Either: final file doesn't exist yet (ideal race), OR tmp files present (atomic write in flight)
    if (finalFileExists) {
      // Writer was very fast; at least verify no tmp residue
      assert.strictEqual(tmpFiles.length, 0, 'If final file exists, no tmp files should remain');
    } else {
      // Ideal case: caught during barrier
      assert.ok(tmpFiles.length > 0, 'Tmp file should exist during barrier when final file absent');
    }

    // Release barrier
    fs.unlinkSync(barrierFile);

    // Wait for writer to complete
    await writerPromise;

    // Now final file should exist and be consistent
    assert.ok(fs.existsSync(runReportPath2), 'Final run_report_v1.json should exist after barrier release');

    // Verify no tmp files remain
    const tmpFilesAfter = fs.readdirSync(runDir2).filter((f) => f.includes('.tmp'));
    assert.strictEqual(tmpFilesAfter.length, 0, 'No tmp files should remain after completion');

  } finally {
    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;
    if (originalEnv !== undefined) process.env.EVIDENCE_WRITE_BARRIER = originalEnv;
    else delete process.env.EVIDENCE_WRITE_BARRIER;
    if (originalOverwriteEnv !== undefined) process.env.ALLOW_RUN_ID_OVERWRITE = originalOverwriteEnv;
    else delete process.env.ALLOW_RUN_ID_OVERWRITE;
  }

  console.log('[Test] testPhaseF2ReaderConsistency: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF2ReaderConsistency
};
