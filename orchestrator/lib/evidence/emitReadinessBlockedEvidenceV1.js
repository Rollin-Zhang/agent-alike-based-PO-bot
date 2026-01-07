'use strict';

const { emitSystemRejectionEvidenceV1 } = require('./emitSystemRejectionEvidenceV1');
const { createDepSnapshot } = require('../../probes/writeProbeArtifacts');
const { evaluateReadiness } = require('../readiness/evaluateReadiness');
const { EVIDENCE_REASON_RUNTIME } = require('./ssot');

/**
 * emitReadinessBlockedEvidenceV1
 *
 * System-level rejection evidence for readiness gating.
 * - details_ref: readiness_debug_v1.json
 * - extra artifact: dep_snapshot_v1.json
 */
function emitReadinessBlockedEvidenceV1(params = {}) {
  const {
    ticket_id,
    ticket_kind,
    http = {},
    depStates,
    mode_snapshot
  } = params;

  const ticketId = String(ticket_id || '');
  if (!ticketId) throw new Error('emitReadinessBlockedEvidenceV1: ticket_id required');
  if (!depStates || typeof depStates !== 'object') throw new Error('emitReadinessBlockedEvidenceV1: depStates required');

  const snapshot = evaluateReadiness(depStates, new Date());
  const missing_required_dep_keys = Object.entries(snapshot.required || {})
    .filter(([_, v]) => !v || v.ready !== true)
    .map(([k]) => String(k));

  const missing_dep_codes = Object.entries(snapshot.required || {})
    .filter(([_, v]) => !v || v.ready !== true)
    .map(([_, v]) => (v && v.code ? String(v.code) : 'DEP_UNAVAILABLE'));

  const readinessDebug = {
    version: 'v1',
    ticket_id: ticketId,
    as_of: snapshot.as_of,
    degraded: Boolean(snapshot.degraded),
    missing_required_dep_keys,
    missing_dep_codes
  };

  const depSnapshot = createDepSnapshot({
    depStates,
    snapshot_id: `dep_${Date.now().toString(36)}`,
    as_of: snapshot.as_of,
    probe_context: 'fill_readiness_gate'
  });

  const ev = emitSystemRejectionEvidenceV1({
    ticket_id: ticketId,
    ticket_kind: ticket_kind ? String(ticket_kind) : null,
    stable_code: EVIDENCE_REASON_RUNTIME.READINESS_BLOCKED,
    http,
    details_kind: 'readiness_debug_v1',
    details_payload: readinessDebug,
    extra_artifacts: [
      { kind: 'dep_snapshot_v1', filename: 'dep_snapshot_v1.json', payload: depSnapshot }
    ],
    mode_snapshot
  });

  return {
    evidence_run_id: ev.evidence_run_id,
    runDir: ev.runDir,
    readiness_debug_path: ev.details_path
  };
}

module.exports = {
  emitReadinessBlockedEvidenceV1
};
