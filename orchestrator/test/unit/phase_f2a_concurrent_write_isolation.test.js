/**
 * Phase F2: Concurrent write isolation
 * - Multiple workers writing to different run directories must not interfere.
 * - Each run directory gets its own atomic manifest.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { createRunReportV1 } = require('../../lib/run_report/createRunReportV1');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { writeRunReportV1 } = require('../../lib/run_report/writeRunReportV1');

async function writeRunReportWorker(runDir, runId, ticketSuffix) {
  return new Promise((resolve, reject) => {
    const report = createRunReportV1({
      ticket_id: `phase_f2_concurrent_${ticketSuffix}`,
      terminal_status: RUN_STATUS.OK,
      primary_failure_code: null,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 0,
      step_reports: [],
      attempt_events: []
    });

    try {
      const runReportPath = path.join(runDir, 'run_report_v1.json');
      writeRunReportV1({ filePath: runReportPath, reportV1: report, run_id: runId });
      resolve({ runDir, runId });
    } catch (err) {
      reject(err);
    }
  });
}

async function testPhaseF2ConcurrentWriteIsolation() {
  console.log('[Test] testPhaseF2ConcurrentWriteIsolation: START');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'phase_f2_concurrent_'));
  const workerCount = 5;
  const workers = [];

  for (let i = 0; i < workerCount; i++) {
    const runId = `run_concurrent_${i}_${Date.now().toString(36)}`;
    const runDir = path.join(tmpBase, runId);
    fs.mkdirSync(runDir, { recursive: true });
    workers.push(writeRunReportWorker(runDir, runId, `worker_${i}`));
  }

  const results = await Promise.all(workers);

  // Verify each worker produced complete artifacts
  for (const { runDir, runId } of results) {
    const runReportPath = path.join(runDir, 'run_report_v1.json');
    const manifestPath = path.join(runDir, 'evidence_manifest_v1.json');
    const selfHashPath = path.join(runDir, 'manifest_self_hash_v1.json');

    assert.ok(fs.existsSync(runReportPath), `run_report_v1.json must exist for ${runId}`);
    assert.ok(fs.existsSync(manifestPath), `evidence_manifest_v1.json must exist for ${runId}`);
    assert.ok(fs.existsSync(selfHashPath), `manifest_self_hash_v1.json must exist for ${runId}`);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.run_id, runId, `manifest run_id must match for ${runId}`);

    const runReport = JSON.parse(fs.readFileSync(runReportPath, 'utf8'));
    assert.ok(runReport.ticket_id.includes('concurrent'), `ticket_id must be concurrent for ${runId}`);
  }

  console.log('[Test] testPhaseF2ConcurrentWriteIsolation: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF2ConcurrentWriteIsolation
};
