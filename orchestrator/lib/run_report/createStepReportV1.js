'use strict';

const { RUN_STATUS } = require('../tool_runner/ssot');
const { TOOL_SIDE_EFFECTS } = require('./ssot');

function isoNow() {
  return new Date().toISOString();
}

function normalizeStatus(status) {
  if (status === RUN_STATUS.OK || status === RUN_STATUS.FAILED || status === RUN_STATUS.BLOCKED) return status;
  return RUN_STATUS.FAILED;
}

function createStepReportV1(params = {}) {
  const {
    step_index,
    tool_name,
    status,
    code = null,
    started_at = isoNow(),
    ended_at = isoNow(),
    duration_ms = 0,
    result_summary = '',
    evidence_items = [],
    dep_snapshot_ref = null,
    attempt_events = []
  } = params;

  const report = {
    step_index: Number(step_index),
    tool_name: String(tool_name || ''),
    side_effect: TOOL_SIDE_EFFECTS[String(tool_name || '')] || 'unknown',
    status: normalizeStatus(status),
    code: code === null ? null : String(code),
    started_at,
    ended_at,
    duration_ms: Number(duration_ms),
    result_summary: String(result_summary || ''),
    evidence_items: Array.isArray(evidence_items) ? evidence_items : []
  };

  // Phase D: dep_snapshot_ref (optional)
  if (dep_snapshot_ref !== null && typeof dep_snapshot_ref === 'object') {
    report.dep_snapshot_ref = dep_snapshot_ref;
  }

  // Phase D: attempt_events (optional)
  if (Array.isArray(attempt_events) && attempt_events.length > 0) {
    report.attempt_events = attempt_events;
  }

  return report;
}

module.exports = { createStepReportV1 };
