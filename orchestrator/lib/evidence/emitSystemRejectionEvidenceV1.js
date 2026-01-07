'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const Ajv = require('ajv');

const { createRunReportV1 } = require('../run_report/createRunReportV1');
const { createStepReportV1 } = require('../run_report/createStepReportV1');
const { writeRunReportV1 } = require('../run_report/writeRunReportV1');
const { writeEvidenceManifestV1 } = require('./writeEvidenceManifestV1');
const { RUN_STATUS } = require('../tool_runner/ssot');
const { isEvidenceReason } = require('./ssot');

function ensureMinRunId(runId) {
  const v = String(runId || '');
  if (v.length < 8) throw new Error('emitSystemRejectionEvidenceV1: run_id minLength 8');
  return v;
}

function buildEvidenceRunId({ ticket_id }) {
  // Spec lock:
  // - evidence_run_id = "gr_" + ticket_id.slice(0,8) + "_" + Date.now().toString(36)
  // - run_dir = ${LOGS_DIR}/${evidence_run_id}
  const tid = String(ticket_id || '');
  const ts = Date.now().toString(36);
  return ensureMinRunId(`gr_${tid.slice(0, 8) || 'ticket'}_${ts}`);
}

function minimalModeSnapshotFromEnv() {
  const nowIso = new Date().toISOString();
  const parseBool = (v) => String(v || '').toLowerCase() === 'true' || String(v || '') === '1';

  return {
    as_of: nowIso,
    env: {
      NO_MCP: parseBool(process.env.NO_MCP),
      enableToolDerivation: parseBool(process.env.ENABLE_TOOL_DERIVATION),
      toolOnlyMode: parseBool(process.env.TOOL_ONLY_MODE),
      enableTicketSchemaValidation: parseBool(process.env.ENABLE_TICKET_SCHEMA_VALIDATION)
    },
    cutover: {
      cutover_until_ms: null,
      env_source: null,
      policy_mode: 'post_cutover',
      metrics: {
        counters: [],
        counters_by_source: []
      },
      gate: {
        ok: true,
        mode: 'post_cutover',
        counts: {
          canonical_missing: 0,
          cutover_violation: 0,
          legacy_read: 0
        },
        reasons: []
      }
    },
    readiness_summary: {
      deps_ready: true,
      missing_dep_codes: [],
      total_missing: 0,
      providers_unavailable: []
    }
  };
}

function loadJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function validateLeaseDebugOrThrow(obj) {
  const schemaAbs = path.resolve(__dirname, '../../schemas/lease_debug.v1.schema.json');
  const schema = loadJson(schemaAbs);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const ok = validate(obj);
  if (!ok) {
    const errors = (validate.errors || []).map((e) => `${e.instancePath || '/'}:${e.keyword}`).join('|');
    throw new Error(`lease_debug_v1_schema_invalid:${errors}`);
  }
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function emitSystemRejectionEvidenceV1(params = {}) {
  const {
    ticket_id,
    ticket_kind,
    stable_code,
    http = {},
    details_kind,
    details_payload,
    mode_snapshot,
    check_name = 'system_rejection_evidence_ok'
  } = params;

  const ticketId = String(ticket_id || '');
  if (!ticketId) throw new Error('emitSystemRejectionEvidenceV1: ticket_id required');

  const code = String(stable_code || '');
  if (!code) throw new Error('emitSystemRejectionEvidenceV1: stable_code required');

  // Guardrail: stable codes must be in Evidence SSOT.
  if (!isEvidenceReason(code)) {
    throw new Error(`emitSystemRejectionEvidenceV1: unsupported_stable_code:${code}`);
  }

  const kind = String(details_kind || '');
  if (!kind) throw new Error('emitSystemRejectionEvidenceV1: details_kind required');
  if (!details_payload || typeof details_payload !== 'object') {
    throw new Error('emitSystemRejectionEvidenceV1: details_payload required');
  }

  const logsDir = process.env.LOGS_DIR ? String(process.env.LOGS_DIR) : null;
  if (!logsDir) throw new Error('emitSystemRejectionEvidenceV1: LOGS_DIR required');

  const evidence_run_id = buildEvidenceRunId({ ticket_id: ticketId });
  const runDir = path.resolve(logsDir, evidence_run_id);
  fs.mkdirSync(runDir, { recursive: true });

  const detailsFilename = `${kind}.json`;
  const detailsAbs = path.join(runDir, detailsFilename);

  // Lock known debug payload shapes.
  if (kind === 'lease_debug_v1') {
    validateLeaseDebugOrThrow(details_payload);
  }

  const detailsJson = JSON.stringify(details_payload, null, 2) + '\n';
  fs.writeFileSync(detailsAbs, detailsJson, 'utf8');

  const step = createStepReportV1({
    step_index: 1,
    tool_name: 'SYSTEM_REJECT',
    status: RUN_STATUS.FAILED,
    code,
    result_summary: `system_reject:${code}`,
    evidence_items: [
      {
        kind,
        path: detailsFilename
      }
    ]
  });

  const report = createRunReportV1({
    ticket_id: ticketId,
    terminal_status: RUN_STATUS.FAILED,
    primary_failure_code: code,
    step_reports: [step],
    attempt_events: []
  });

  const runReportFilename = 'run_report_v1.json';
  const runReportPath = path.join(runDir, runReportFilename);

  // Write ONLY run_report here; helper drives manifest writing below.
  writeRunReportV1({
    filePath: runReportPath,
    reportV1: report,
    mode_snapshot: mode_snapshot && typeof mode_snapshot === 'object' ? mode_snapshot : minimalModeSnapshotFromEnv(),
    run_id: evidence_run_id,
    emit_manifest: false
  });

  writeEvidenceManifestV1({
    runDir,
    run_id: evidence_run_id,
    as_of: new Date().toISOString(),
    mode_snapshot_ref: runReportFilename,
    artifacts: [
      { kind: 'run_report_v1', path: runReportFilename, sha256: '0'.repeat(64), bytes: 0 },
      { kind, path: detailsFilename, sha256: '0'.repeat(64), bytes: 0 }
    ],
    checks: [
      {
        name: String(check_name),
        ok: false,
        reason_codes: [code],
        details_ref: detailsFilename
      }
    ]
  });

  return {
    evidence_run_id,
    runDir,
    details_path: detailsFilename
  };
}

module.exports = {
  emitSystemRejectionEvidenceV1
};
