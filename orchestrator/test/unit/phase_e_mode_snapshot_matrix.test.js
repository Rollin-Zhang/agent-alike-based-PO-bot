/**
 * Phase E: mode_snapshot regression matrix (HTTP-sourced)
 *
 * Goals:
 * - mode_snapshot is present on run_report_v1 and validates against schema.
 * - cutover snapshot reflects CutoverPolicy (/metrics.cutover) and strictCutoverGate decision.
 * - strict gate determinism via STRICT_GATE_FORCE (test-only) is observable.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { startServerWithEnv } = require('./helpers/server');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { createRunReportV1 } = require('../../lib/run_report/createRunReportV1');
const { writeRunReportV1 } = require('../../lib/run_report/writeRunReportV1');
const { buildModeSnapshotFromHttp } = require('../../lib/run_report/modeSnapshot');

function buildAjv() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  const schemasDir = path.join(__dirname, '..', '..', 'schemas');
  const stepSchema = JSON.parse(fs.readFileSync(path.join(schemasDir, 'step_report.v1.schema.json'), 'utf8'));
  const runSchema = JSON.parse(fs.readFileSync(path.join(schemasDir, 'run_report.v1.schema.json'), 'utf8'));

  ajv.addSchema(stepSchema, stepSchema.$id);
  ajv.addSchema(runSchema, runSchema.$id);

  return ajv;
}

function httpGetJson(baseUrl, pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          reject(new Error(`invalid_json:${pathname}`));
        }
      });
    });
    req.on('error', reject);
  });
}

async function testPhaseEModeSnapshotMatrix() {
  console.log('[Test] testPhaseEModeSnapshotMatrix: START');

  const ajv = buildAjv();
  const validate = ajv.getSchema('run_report.v1.schema.json');
  assert.ok(validate, 'should load run_report.v1.schema.json');

  const now = Date.now();
  const cases = [
    { name: 'pre_cutover + strict_forced_on', cutoverUntilMs: now + 60_000, strict: 'on', expectedMode: 'pre_cutover', expectedOk: true },
    { name: 'pre_cutover + strict_forced_off', cutoverUntilMs: now + 60_000, strict: 'off', expectedMode: 'pre_cutover', expectedOk: false },
    { name: 'post_cutover + strict_forced_on', cutoverUntilMs: now - 60_000, strict: 'on', expectedMode: 'post_cutover', expectedOk: true },
    { name: 'post_cutover + strict_forced_off', cutoverUntilMs: now - 60_000, strict: 'off', expectedMode: 'post_cutover', expectedOk: false }
  ];

  for (const c of cases) {
    console.log(`[Test] case: ${c.name}`);

    const serverEnvOverrides = {
      NODE_ENV: 'test',
      NO_MCP: 'true',
      ENABLE_TOOL_DERIVATION: 'true',
      TOOL_ONLY_MODE: 'false',
      ENABLE_TICKET_SCHEMA_VALIDATION: 'true',
      CUTOVER_UNTIL_MS: String(c.cutoverUntilMs),
      STRICT_GATE_FORCE: c.strict
    };

    const { baseUrl, stop, port } = await startServerWithEnv(serverEnvOverrides);

    try {
      const health = await httpGetJson(baseUrl, '/health');
      assert.strictEqual(health.status, 200);

      const metrics = await httpGetJson(baseUrl, '/metrics');
      assert.strictEqual(metrics.status, 200);

      const mode_snapshot = buildModeSnapshotFromHttp({
        env: { ...serverEnvOverrides, ORCHESTRATOR_PORT: String(port) },
        healthBody: health.body,
        metricsBody: metrics.body
      });

      // Build + write a run_report_v1.json with injected mode_snapshot
      const report = createRunReportV1({
        ticket_id: `phase_e_matrix:${c.name}`,
        terminal_status: RUN_STATUS.OK,
        primary_failure_code: null,
        started_at: new Date(now).toISOString(),
        ended_at: new Date(now).toISOString(),
        duration_ms: 0,
        step_reports: [],
        attempt_events: []
      });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase_e_matrix_'));
      const outPath = path.join(tmpDir, 'run_report_v1.json');

      writeRunReportV1({
        filePath: outPath,
        reportV1: report,
        mode_snapshot
      });

      const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.ok(written.mode_snapshot, 'run_report_v1 must include mode_snapshot');

      const ok = validate(written);
      if (!ok) {
        console.error('[DEBUG] AJV errors:', validate.errors);
      }
      assert.strictEqual(ok, true, 'run_report_v1 should validate with mode_snapshot');

      assert.strictEqual(written.mode_snapshot.cutover.policy_mode, c.expectedMode);
      assert.strictEqual(written.mode_snapshot.cutover.gate.mode, c.expectedMode);
      assert.strictEqual(written.mode_snapshot.cutover.gate.ok, c.expectedOk);

      // Readiness summary: low-cardinality + bounded list
      const rs = written.mode_snapshot.readiness_summary;
      assert.strictEqual(typeof rs.deps_ready, 'boolean');
      assert.ok(Array.isArray(rs.missing_dep_codes));
      assert.ok(rs.missing_dep_codes.length <= 10);
      assert.strictEqual(typeof rs.total_missing, 'number');

      // Env snapshot: boolean-only planned keys (no paths)
      const env = written.mode_snapshot.env;
      assert.deepStrictEqual(Object.keys(env).sort(), [
        'NO_MCP',
        'enableTicketSchemaValidation',
        'enableToolDerivation',
        'toolOnlyMode'
      ].sort());
    } finally {
      await stop();
    }
  }

  console.log('[Test] testPhaseEModeSnapshotMatrix: PASS ✓');
  return true;
}

module.exports = {
  testPhaseEModeSnapshotMatrix
};
