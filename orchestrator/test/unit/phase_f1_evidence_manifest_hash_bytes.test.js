/**
 * Phase F1 - Evidence Manifest hashing/bytes are real + self-hash consistent
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunReportV1 } = require('../../lib/run_report/createRunReportV1');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { writeRunReportV1 } = require('../../lib/run_report/writeRunReportV1');
const { canonicalJsonStringify } = require('../../lib/evidence/canonicalJsonStringify');

function sha256HexFromBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readFileInfo(absPath) {
  const buf = fs.readFileSync(absPath);
  return { bytes: buf.length, sha256: sha256HexFromBuffer(buf) };
}

function computeExpectedSelfHash(manifest) {
  const clone = JSON.parse(JSON.stringify(manifest));
  clone.artifacts = Array.isArray(clone.artifacts)
    ? clone.artifacts.filter((a) => a && a.kind !== 'manifest_self_hash_v1')
    : [];

  for (const a of clone.artifacts) {
    if (a && a.kind === 'evidence_manifest_v1') a.sha256 = null;
  }

  const canonical = canonicalJsonStringify(clone);
  return sha256HexFromBuffer(Buffer.from(canonical, 'utf8'));
}

async function testPhaseF1EvidenceManifestHashBytes() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase_f1_manifest_hash_'));
  const runDir = path.join(tmpDir, 'run_87654321');
  fs.mkdirSync(runDir, { recursive: true });

  const runId = 'run_87654321';

  const report = createRunReportV1({
    ticket_id: 'phase_f1_hash_bytes',
    terminal_status: RUN_STATUS.OK,
    primary_failure_code: null,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: 0,
    step_reports: [],
    attempt_events: []
  });

  const runReportPath = path.join(runDir, 'run_report_v1.json');
  writeRunReportV1({ filePath: runReportPath, reportV1: report, run_id: runId });

  const manifestPath = path.join(runDir, 'evidence_manifest_v1.json');
  const selfHashPath = path.join(runDir, 'manifest_self_hash_v1.json');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const byPath = new Map(artifacts.map((a) => [a.path, a]));

  const runInfo = readFileInfo(runReportPath);
  const runArtifact = byPath.get('run_report_v1.json');
  assert.ok(runArtifact);
  assert.strictEqual(runArtifact.sha256, runInfo.sha256);
  assert.strictEqual(runArtifact.bytes, runInfo.bytes);

  const selfHashInfo = readFileInfo(selfHashPath);
  const selfHashArtifact = byPath.get('manifest_self_hash_v1.json');
  assert.ok(selfHashArtifact);
  assert.strictEqual(selfHashArtifact.sha256, selfHashInfo.sha256);
  assert.strictEqual(selfHashArtifact.bytes, selfHashInfo.bytes);

  const selfHashObj = JSON.parse(fs.readFileSync(selfHashPath, 'utf8'));
  const expected = computeExpectedSelfHash(manifest);
  assert.strictEqual(selfHashObj.value, expected, 'manifest_self_hash_v1.value must match canonical manifest hash');

  console.log('[Test] testPhaseF1EvidenceManifestHashBytes: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF1EvidenceManifestHashBytes
};
