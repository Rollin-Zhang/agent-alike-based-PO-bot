'use strict';

const crypto = require('crypto');

const { RUN_STATUS } = require('../tool_runner/ssot');
const {
  RUN_REPORT_VERSION,
  RETRY_POLICY_ID,
  DEFAULT_MAX_ATTEMPTS,
  ATTEMPT_EVENT_TYPES_V1
} = require('./ssot');

function isoNow() {
  return new Date().toISOString();
}

function uuidv4() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older Node: RFC4122 v4
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeTerminalStatus(status) {
  if (status === RUN_STATUS.OK || status === RUN_STATUS.FAILED || status === RUN_STATUS.BLOCKED) return status;
  return RUN_STATUS.FAILED;
}

function createRunReportV1(params = {}) {
  const {
    ticket_id,
    terminal_status,
    primary_failure_code = null,
    started_at = isoNow(),
    ended_at = isoNow(),
    duration_ms = 0,
    step_reports = [],
    attempt_events = [],
    retry_policy_id = RETRY_POLICY_ID,
    max_attempts = DEFAULT_MAX_ATTEMPTS
  } = params;

  // Hard rule: run_id/as_of are internal-only.
  const run_id = uuidv4();
  const as_of = isoNow();

  return {
    version: RUN_REPORT_VERSION,
    run_id,
    as_of,
    ticket_id: String(ticket_id || ''),
    retry_policy_id: String(retry_policy_id),
    max_attempts: Number(max_attempts),
    terminal_status: normalizeTerminalStatus(terminal_status),
    primary_failure_code: primary_failure_code === null ? null : String(primary_failure_code),
    started_at,
    ended_at,
    duration_ms: Number(duration_ms),
    step_reports: Array.isArray(step_reports) ? step_reports : [],
    attempt_events: Array.isArray(attempt_events) ? attempt_events : []
  };
}

function appendAttemptEvent(reportV1, event) {
  if (!reportV1 || typeof reportV1 !== 'object') {
    throw new Error('appendAttemptEvent requires reportV1');
  }

  const e = {
    at: isoNow(),
    type: String(event?.type || ''),
    step_index: typeof event?.step_index === 'number' ? event.step_index : (event?.step_index ? Number(event.step_index) : null),
    tool_name: event?.tool_name ? String(event.tool_name) : null,
    status: event?.status ? String(event.status) : null,
    code: event?.code ? String(event.code) : null,
    message: event?.message ? String(event.message) : null
  };

  // Minimal guard: only allow known types
  const allowed = Object.values(ATTEMPT_EVENT_TYPES_V1);
  if (!allowed.includes(e.type)) {
    throw new Error(`invalid_attempt_event_type:${e.type}`);
  }

  if (!Array.isArray(reportV1.attempt_events)) {
    reportV1.attempt_events = [];
  }

  reportV1.attempt_events.push(e);
}

module.exports = {
  createRunReportV1,
  appendAttemptEvent,
  ATTEMPT_EVENT_TYPES_V1
};
