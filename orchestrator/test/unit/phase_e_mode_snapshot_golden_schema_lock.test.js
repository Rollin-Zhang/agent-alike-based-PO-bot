/**
 * Phase E guardrail:
 * - Golden minimal mode_snapshot sample validated by AJV against run_report.v1.schema.json.
 * - Prevents drift where code adds fields but schema isn't updated, or schema gets loosened.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

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

async function testPhaseEModeSnapshotGoldenSchemaLock() {
  console.log('[Test] testPhaseEModeSnapshotGoldenSchemaLock: START');

  const ajv = buildAjv();
  const validate = ajv.getSchema('run_report.v1.schema.json');
  assert.ok(validate, 'should load run_report.v1.schema.json');

  const fixedNow = 1767700000000; // fixed epoch ms for deterministic inputs

  const env = {
    NODE_ENV: 'test',
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    TOOL_ONLY_MODE: 'false',
    ENABLE_TICKET_SCHEMA_VALIDATION: 'true',
    CUTOVER_UNTIL_MS: String(fixedNow + 60_000),
    ORCHESTRATOR_PORT: '3000'
  };

  // Minimal server-like shapes (no HTTP needed):
  const healthBody = {
    required: {},
    optional: {}
  };

  const metricsBody = {
    cutover: {
      cutover_until_ms: fixedNow + 60_000,
      env_source: 'CUTOVER_UNTIL_MS',
      mode: 'pre_cutover',
      metrics: {
        counters: [
          { event_type: 'canonical_missing', field: 'tool_verdict', count: 0 },
          { event_type: 'cutover_violation', field: 'tool_verdict', count: 0 },
          { event_type: 'legacy_read', field: 'tool_verdict', count: 0 }
        ],
        counters_by_source: []
      }
    },
    readiness: {
      required_ready: {}
    }
  };

  const mode_snapshot = buildModeSnapshotFromHttp({ env, healthBody, metricsBody });

  // Hard lock: do not allow env dump (only these keys)
  assert.deepStrictEqual(
    Object.keys(mode_snapshot.env).sort(),
    ['NO_MCP', 'enableToolDerivation', 'toolOnlyMode', 'enableTicketSchemaValidation'].sort()
  );

  // Hard lock: readiness summary is low-cardinality
  assert.strictEqual(typeof mode_snapshot.readiness_summary.deps_ready, 'boolean');
  assert.ok(Array.isArray(mode_snapshot.readiness_summary.missing_dep_codes));
  assert.ok(mode_snapshot.readiness_summary.missing_dep_codes.length <= 10);
  assert.strictEqual(typeof mode_snapshot.readiness_summary.total_missing, 'number');

  const report = createRunReportV1({
    ticket_id: 'phase_e_golden_schema_lock',
    terminal_status: RUN_STATUS.OK,
    primary_failure_code: null,
    started_at: new Date(fixedNow).toISOString(),
    ended_at: new Date(fixedNow).toISOString(),
    duration_ms: 0,
    step_reports: [],
    attempt_events: []
  });

  // Inject via the single writer entry point
  writeRunReportV1({
    filePath: path.join(__dirname, '._tmp_phase_e_golden_run_report_v1.json'),
    reportV1: report,
    mode_snapshot
  });

  const ok = validate(report);
  if (!ok) {
    console.error('[DEBUG] AJV errors:', validate.errors);
  }
  assert.strictEqual(ok, true, 'run_report_v1 should validate with golden minimal mode_snapshot');

  console.log('[Test] testPhaseEModeSnapshotGoldenSchemaLock: PASS ✓');
  return true;
}

module.exports = {
  testPhaseEModeSnapshotGoldenSchemaLock
};
