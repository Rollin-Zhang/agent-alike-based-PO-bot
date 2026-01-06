/**
 * Phase C: RunReport v1 / StepReport v1 schema validation tests
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const { RUN_STATUS, RUN_CODES } = require('../../lib/tool_runner/ssot');
const { createRunReportV1, appendAttemptEvent, ATTEMPT_EVENT_TYPES_V1 } = require('../../lib/run_report/createRunReportV1');
const { createStepReportV1 } = require('../../lib/run_report/createStepReportV1');
const { runWithV1 } = require('../../lib/tool_runner/RunnerCore');

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

async function testCreateRunReportV1AjvOk() {
  console.log('[Test] testCreateRunReportV1AjvOk: START');

  const ajv = buildAjv();
  const validate = ajv.getSchema('run_report.v1.schema.json');
  assert.ok(validate, 'should load run_report.v1.schema.json');

  const attemptEvents = [];
  const bag = { attempt_events: attemptEvents };
  appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.RUN_START, message: 'run_start' });
  appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.STEP_START, step_index: 1, tool_name: 'web_search', message: 'step_start' });
  appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.STEP_END, step_index: 1, tool_name: 'web_search', status: RUN_STATUS.OK, code: null, message: 'step_end' });
  appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.RUN_END, status: RUN_STATUS.OK, code: null, message: 'run_end' });

  const step = createStepReportV1({
    step_index: 1,
    tool_name: 'web_search',
    status: RUN_STATUS.OK,
    code: null,
    result_summary: 'ok',
    evidence_items: []
  });

  const report = createRunReportV1({
    ticket_id: 'unit_test_ticket',
    terminal_status: RUN_STATUS.OK,
    primary_failure_code: null,
    step_reports: [step],
    attempt_events: attemptEvents
  });

  const ok = validate(report);
  if (!ok) {
    console.error('[DEBUG] AJV errors:', validate.errors);
  }
  assert.strictEqual(ok, true, 'run_report_v1 should validate');

  console.log('[Test] testCreateRunReportV1AjvOk: PASS ✓');
}

async function testRunnerCoreRunWithV1UnknownToolHasStableFailureCodeAndEvents() {
  console.log('[Test] testRunnerCoreRunWithV1UnknownToolHasStableFailureCodeAndEvents: START');

  const ajv = buildAjv();
  const validate = ajv.getSchema('run_report.v1.schema.json');
  assert.ok(validate, 'should load run_report.v1.schema.json');

  const ticket = {
    id: 'ticket_unknown_tool',
    tool_steps: [{ tool_name: 'not_a_real_tool', args: {} }]
  };

  const depsSnapshot = {
    memory: { ready: true, code: 'OK' },
    web_search: { ready: true, code: 'OK' }
  };

  const stubGateway = {
    async execute() {
      return { ok: true, result: { ok: true }, evidenceCandidates: [] };
    }
  };

  const { runReportV1 } = await runWithV1(ticket, depsSnapshot, {
    gateway: stubGateway,
    requiredDeps: []
  });

  assert.strictEqual(runReportV1.terminal_status, RUN_STATUS.BLOCKED, 'unknown tool should be blocked');
  assert.strictEqual(runReportV1.primary_failure_code, RUN_CODES.UNKNOWN_TOOL, 'primary failure should be stable UNKNOWN_TOOL');

  const types = new Set((runReportV1.attempt_events || []).map(e => e.type));
  assert.ok(types.has('RUN_START'), 'attempt_events must include RUN_START');
  assert.ok(types.has('RUN_END'), 'attempt_events must include RUN_END');
  assert.ok(types.has('STEP_START'), 'attempt_events must include STEP_START');
  assert.ok(types.has('STEP_END'), 'attempt_events must include STEP_END');

  assert.ok(Array.isArray(runReportV1.step_reports) && runReportV1.step_reports.length === 1, 'should have 1 step report');
  assert.strictEqual(runReportV1.step_reports[0].status, RUN_STATUS.BLOCKED);
  assert.strictEqual(runReportV1.step_reports[0].code, RUN_CODES.UNKNOWN_TOOL);

  const ok = validate(runReportV1);
  if (!ok) {
    console.error('[DEBUG] AJV errors:', validate.errors);
  }
  assert.strictEqual(ok, true, 'run_report_v1 should validate (unknown tool)');

  console.log('[Test] testRunnerCoreRunWithV1UnknownToolHasStableFailureCodeAndEvents: PASS ✓');
}

module.exports = {
  testCreateRunReportV1AjvOk,
  testRunnerCoreRunWithV1UnknownToolHasStableFailureCodeAndEvents
};
