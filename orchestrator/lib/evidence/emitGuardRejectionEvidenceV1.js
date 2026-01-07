'use strict';

const crypto = require('crypto');

const { emitSystemRejectionEvidenceV1 } = require('./emitSystemRejectionEvidenceV1');
const { EVIDENCE_REASON_RUNTIME } = require('./ssot');

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/**
 * emitGuardRejectionEvidenceV1
 *
 * Minimal, HTTP-handler level evidence emission for guard rejections.
 * - Writes a minimal run_report_v1.json into `${LOGS_DIR}/${evidence_run_id}/`
 * - Writes lease_debug_v1.json (token hashes only)
 * - writeRunReportV1 triggers evidence_manifest_v1.json + manifest_self_hash_v1.json
 */
function emitGuardRejectionEvidenceV1(params = {}) {
  const {
    ticket_id,
    ticket_kind,
    stable_code,
    http = {},
    lease_expected = {},
    lease_provided = {},
    mode_snapshot
  } = params;

  const ticketId = String(ticket_id || '');
  if (!ticketId) throw new Error('emitGuardRejectionEvidenceV1: ticket_id required');

  const code = String(stable_code || '');
  if (!code) throw new Error('emitGuardRejectionEvidenceV1: stable_code required');

  // Gate: only allow known runtime stable code(s) for now.
  if (code !== EVIDENCE_REASON_RUNTIME.LEASE_OWNER_MISMATCH) {
    throw new Error(`emitGuardRejectionEvidenceV1: unsupported_stable_code:${code}`);
  }

  // Schema-locked debug payload (no env dump / no raw token).
  const leaseDebug = {
    ticket_id: ticketId,
    lease_owner_expected: lease_expected.lease_owner ? String(lease_expected.lease_owner) : null,
    lease_owner_provided: lease_provided.lease_owner ? String(lease_provided.lease_owner) : null,
    lease_token_hash: lease_provided.lease_token ? sha256Hex(lease_provided.lease_token) : null
  };

  const ev = emitSystemRejectionEvidenceV1({
    ticket_id: ticketId,
    ticket_kind: ticket_kind ? String(ticket_kind) : null,
    stable_code: code,
    http,
    details_kind: 'lease_debug_v1',
    details_payload: leaseDebug,
    mode_snapshot,
    check_name: 'guard_rejection_evidence_ok'
  });

  return {
    evidence_run_id: ev.evidence_run_id,
    runDir: ev.runDir,
    lease_debug_path: ev.details_path
  };
}

module.exports = {
  emitGuardRejectionEvidenceV1
};
