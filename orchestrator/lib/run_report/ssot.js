'use strict';

/**
 * Phase C SSOT for RunReport v1 / StepReport v1
 *
 * Scope:
 * - This SSOT is ONLY for run_report_v1.json evidence artifact.
 * - It must not change legacy RunnerCore RunReport shape.
 */

const RUN_REPORT_VERSION = 'v1';

// Retry policy v1 (future-proofing; Phase C does not implement retries yet)
const RETRY_POLICY_ID = 'v1_default';
const DEFAULT_MAX_ATTEMPTS = 1;

// Retryable stable codes (v1). Keep minimal and conservative.
const RETRYABLE_SET_V1 = Object.freeze([
  'TOOL_TIMEOUT',
  'TOOL_UNAVAILABLE'
]);

// Step side-effect SSOT (Decision: RunnerCore only consults this table; no overrides)
// Values are intentionally coarse.
const TOOL_SIDE_EFFECTS = Object.freeze({
  memory: 'write',
  web_search: 'read',
  filesystem: 'write'
});

// Attempt event types (append-only)
const ATTEMPT_EVENT_TYPES_V1 = Object.freeze({
  RUN_START: 'RUN_START',
  RUN_END: 'RUN_END',
  STEP_START: 'STEP_START',
  STEP_END: 'STEP_END'
});

module.exports = {
  RUN_REPORT_VERSION,
  RETRY_POLICY_ID,
  DEFAULT_MAX_ATTEMPTS,
  RETRYABLE_SET_V1,
  TOOL_SIDE_EFFECTS,
  ATTEMPT_EVENT_TYPES_V1
};
