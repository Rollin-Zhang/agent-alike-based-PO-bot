/**
 * Phase F1 - Evidence Manifest schema lock + cross-field invariants
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { createRunReportV1 } = require('../../lib/run_report/createRunReportV1');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { writeRunReportV1 } = require('../../lib/run_report/writeRunReportV1');
const { validateEvidenceManifestV1 } = require('../../lib/evidence/validateEvidenceManifestV1');

function loadJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function getAjv() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv;
}

async function testPhaseF1EvidenceManifestSchemaLock() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase_f1_manifest_'));
  const runDir = path.join(tmpDir, 'run_12345678');
  fs.mkdirSync(runDir, { recursive: true });

  const runId = 'run_12345678';

  const report = createRunReportV1({
    ticket_id: 'phase_f1_schema_lock',
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

  assert.ok(fs.existsSync(manifestPath), 'must write evidence_manifest_v1.json');
  assert.ok(fs.existsSync(selfHashPath), 'must write manifest_self_hash_v1.json');

  const manifest = loadJson(manifestPath);

  // AJV schema validation
  const schema = loadJson(path.resolve(__dirname, '../../schemas/evidence_manifest.v1.schema.json'));
  const ajv = getAjv();
  const validate = ajv.compile(schema);
  const ok = validate(manifest);
  if (!ok) {
    console.error('[DEBUG] AJV errors:', validate.errors);
  }
  assert.strictEqual(ok, true, 'evidence_manifest_v1 must validate against schema');

  // Cross-field validation
  const cross = validateEvidenceManifestV1(manifest);
  assert.strictEqual(cross.ok, true, `cross-field validation failed: ${(cross.errors || []).join(',')}`);

  assert.strictEqual(manifest.run_id, runId);
  assert.strictEqual(manifest.mode_snapshot_ref, 'run_report_v1.json');

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const byPath = new Map(artifacts.map((a) => [a.path, a]));

  const runReportArtifact = byPath.get('run_report_v1.json');
  assert.ok(runReportArtifact, 'manifest must list run_report_v1.json');
  assert.strictEqual(runReportArtifact.kind, 'run_report_v1');
  assert.ok(/^[a-f0-9]{64}$/.test(String(runReportArtifact.sha256)), 'run_report_v1 sha256 must be 64hex');
  assert.ok(Number.isInteger(runReportArtifact.bytes) && runReportArtifact.bytes > 0);

  const selfArtifact = byPath.get('evidence_manifest_v1.json');
  assert.ok(selfArtifact, 'manifest must list evidence_manifest_v1.json');
  assert.strictEqual(selfArtifact.kind, 'evidence_manifest_v1');
  assert.strictEqual(selfArtifact.sha256, null, 'self sha256 must be null');

  const selfHashArtifact = byPath.get('manifest_self_hash_v1.json');
  assert.ok(selfHashArtifact, 'manifest must list manifest_self_hash_v1.json');
  assert.strictEqual(selfHashArtifact.kind, 'manifest_self_hash_v1');
  assert.ok(/^[a-f0-9]{64}$/.test(String(selfHashArtifact.sha256)));

  // Self-hash artifact schema validation
  const selfHashSchema = loadJson(path.resolve(__dirname, '../../schemas/manifest_self_hash.v1.schema.json'));
  const validateSelfHash = ajv.compile(selfHashSchema);
  const selfHashObj = loadJson(selfHashPath);
  const ok2 = validateSelfHash(selfHashObj);
  if (!ok2) {
    console.error('[DEBUG] AJV self-hash errors:', validateSelfHash.errors);
  }
  assert.strictEqual(ok2, true, 'manifest_self_hash_v1.json must validate against schema');

  // Checks
  const checks = Array.isArray(manifest.checks) ? manifest.checks : [];
  const byName = new Map(checks.map((c) => [c.name, c]));

  const schemaCheck = byName.get('manifest_schema_valid');
  assert.ok(schemaCheck, 'manifest_schema_valid check must exist');
  assert.strictEqual(schemaCheck.ok, true);

  const integrityCheck = byName.get('manifest_self_integrity_ok');
  assert.ok(integrityCheck, 'manifest_self_integrity_ok check must exist');
  assert.strictEqual(integrityCheck.ok, true);
  assert.strictEqual(integrityCheck.details_ref, 'manifest_self_hash_v1.json');

  console.log('[Test] testPhaseF1EvidenceManifestSchemaLock: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF1EvidenceManifestSchemaLock
};
