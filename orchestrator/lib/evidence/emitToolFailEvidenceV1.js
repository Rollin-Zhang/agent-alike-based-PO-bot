'use strict';

/**
 * emitToolFailEvidenceV1.js
 * Phase F2B-1(2): tool_fail fill-path system rejection evidence emitter
 *
 * Contract:
 * - Thin wrapper around emitSystemRejectionEvidenceV1
 * - Builds tool_debug_v1 payload with required baseline fields
 * - Stable code: 'unknown_tool' (from SSOT)
 * - Details kind: 'tool_debug_v1'
 * - Required artifacts baseline: run_report_v1, evidence_manifest_v1, manifest_self_hash_v1, tool_debug_v1
 */

const { EVIDENCE_REASON_RUNTIME } = require('./ssot');
const { emitSystemRejectionEvidenceV1 } = require('./emitSystemRejectionEvidenceV1');

/**
 * Emit tool_fail system rejection evidence (fill-path validation failure).
 *
 * @param {Object} params
 * @param {string} params.ticket_id - TOOL ticket ID
 * @param {string} params.tool_name - Tool name that failed validation
 * @param {string} params.error_type - Error type ('unknown_tool', 'invalid_args', etc.)
 * @param {string} params.message - Human-readable error message
 * @param {Object} [params.args_shape] - Optional snapshot of args keys (key → type)
 * @param {string} [params.stack] - Optional stack trace
 * @param {string} [params.gateway_phase] - Optional phase hint ('fill_validation', etc.)
 * @param {Object} [params.mode_snapshot] - Optional mode snapshot for evidence context
 * @returns {Promise<{ evidence_run_id: string }>}
 * @throws {Error} If emission fails (caller should catch and best-effort log)
 */
async function emitToolFailEvidenceV1({
  ticket_id,
  tool_name,
  error_type,
  message,
  args_shape = null,
  stack = null,
  gateway_phase = 'fill_validation',
  mode_snapshot = null
}) {
  // Validate required fields
  if (!ticket_id || typeof ticket_id !== 'string') {
    throw new Error('emitToolFailEvidenceV1: ticket_id required (string)');
  }
  if (typeof tool_name !== 'string') {
    throw new Error('emitToolFailEvidenceV1: tool_name required (string)');
  }
  if (!error_type || typeof error_type !== 'string') {
    throw new Error('emitToolFailEvidenceV1: error_type required (string)');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('emitToolFailEvidenceV1: message required (string)');
  }

  // Build schema-locked tool_debug_v1 payload
  const toolDebugPayload = {
    version: 'v1',
    ticket_id,
    tool_name,
    error_type,
    message
  };

  // Optional fields (schema allows them, but not required)
  if (args_shape && typeof args_shape === 'object') {
    toolDebugPayload.args_shape = args_shape;
  }
  if (stack && typeof stack === 'string') {
    toolDebugPayload.stack = stack;
  }
  if (gateway_phase && typeof gateway_phase === 'string') {
    toolDebugPayload.gateway_phase = gateway_phase;
  }

  // Call system emitter with stable code 'unknown_tool'
  return emitSystemRejectionEvidenceV1({
    ticket_id,
    stable_code: EVIDENCE_REASON_RUNTIME.UNKNOWN_TOOL,
    details_kind: 'tool_debug_v1',
    details_payload: toolDebugPayload,
    mode_snapshot
  });
}

module.exports = { emitToolFailEvidenceV1 };
