/**
 * Probe to StepReport Builder (Phase D)
 * 
 * 契約：
 * - 完全 deterministic：不得自行讀 clock、不得產生 UUID
 * - as_of 由外部注入
 * - 同一 ProbeResult 輸出完全相同的 StepReport
 * - code 只出自 probes/ssot.js PROBE_STEP_CODES
 */

'use strict';

const { createStepReportV1 } = require('../lib/run_report/createStepReportV1');
const { PROBE_STEP_TOOL_NAMES, PROBE_STEP_CODES, getProbeCodeStatus } = require('./ssot');

/**
 * 將 ProbeResult 轉換為 StepReport v1
 * 
 * @param {Object} params
 * @param {Object} params.probeResult - ProbeResult from ProbeRunner
 * @param {number} params.step_index - Step index (1-based)
 * @param {string} params.started_at - ISO8601 timestamp (externally injected)
 * @param {string} params.ended_at - ISO8601 timestamp (externally injected)
 * @param {number} params.duration_ms - Duration in milliseconds
 * @param {Array} [params.attempt_events] - Optional attempt events (e.g., internal tool calls)
 * @param {Object} [params.dep_snapshot_ref] - Optional dep snapshot reference
 * @returns {Object} StepReport v1
 */
function probeResultToStepReport(params) {
  const {
    probeResult,
    step_index,
    started_at,
    ended_at,
    duration_ms,
    attempt_events = [],
    dep_snapshot_ref = null
  } = params;

  // 驗證必填參數
  if (!probeResult || typeof probeResult !== 'object') {
    throw new Error('probeResult is required');
  }
  if (!started_at || typeof started_at !== 'string') {
    throw new Error('started_at (ISO8601) must be externally injected');
  }
  if (!ended_at || typeof ended_at !== 'string') {
    throw new Error('ended_at (ISO8601) must be externally injected');
  }

  // Map probe name to tool_name
  const tool_name = mapProbeNameToToolName(probeResult.name);

  // Determine status and code from ProbeResult
  let status, code;
  if (probeResult.ok) {
    // Probe passed
    status = 'ok';
    code = null;
  } else {
    // Probe failed
    code = probeResult.code || PROBE_STEP_CODES.PROBE_FORCED_FAIL;
    status = getProbeCodeStatus(code);
  }

  // Build result_summary
  const result_summary = buildResultSummary(probeResult, status, code);

  return createStepReportV1({
    step_index,
    tool_name,
    status,
    code,
    started_at,
    ended_at,
    duration_ms,
    result_summary,
    evidence_items: [], // Evidence 由外部 attachEvidence 另行處理
    dep_snapshot_ref,
    attempt_events
  });
}

/**
 * Map probe name (from registry) to StepReport tool_name (PROBE_STEP_TOOL_NAMES)
 */
function mapProbeNameToToolName(probeName) {
  const mapping = {
    'security': PROBE_STEP_TOOL_NAMES.SECURITY,
    'access': PROBE_STEP_TOOL_NAMES.ACCESS,
    'search': PROBE_STEP_TOOL_NAMES.SEARCH,
    'memory': PROBE_STEP_TOOL_NAMES.MEMORY
  };

  return mapping[probeName] || `probe.${probeName}`;
}

/**
 * Build result_summary (deterministic, no random/clock)
 */
function buildResultSummary(probeResult, status, code) {
  if (status === 'ok') {
    return `Probe '${probeResult.name}' passed`;
  }

  if (probeResult.forced) {
    return `Probe '${probeResult.name}' force-failed (PROBE_FORCE_FAIL)`;
  }

  return `Probe '${probeResult.name}' failed: ${code}`;
}

/**
 * 建立 attempt_event（deterministic helper）
 * 
 * @param {Object} params
 * @param {string} params.as_of - ISO8601 timestamp (externally injected)
 * @param {string} params.status - 'ok' | 'blocked' | 'failed'
 * @param {string|null} params.code - Stable code or null
 * @param {number} params.duration_ms - Duration
 * @param {string} [params.note] - Optional short note
 * @returns {Object} Attempt event
 */
function createAttemptEvent(params) {
  const { as_of, status, code, duration_ms, note } = params;

  if (!as_of || typeof as_of !== 'string') {
    throw new Error('as_of (ISO8601) must be externally injected');
  }
  if (!['ok', 'blocked', 'failed'].includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  const event = {
    as_of,
    status,
    code: code || null,
    duration_ms: Number(duration_ms) || 0
  };

  if (note && typeof note === 'string') {
    event.note = note;
  }

  return event;
}

module.exports = {
  probeResultToStepReport,
  createAttemptEvent,
  mapProbeNameToToolName
};
