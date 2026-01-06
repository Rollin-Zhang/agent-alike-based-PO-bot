/**
 * Phase D Follow-up Guardrail: Probe codes namespace lock
 *
 * Prevents long-term drift between:
 * - Probe codes (orchestrator/probes/ssot.js)
 * - Runner stable codes (orchestrator/lib/tool_runner/ssot.js)
 *
 * Contract (Strategy A): Probe codes must NEVER overlap with RUN_CODES strings.
 */

const assert = require('assert');

const { RUN_CODES } = require('../../lib/tool_runner/ssot');
const {
  PROBE_STEP_CODES,
  PROBE_ATTEMPT_CODES,
  PROBE_CODE_TO_STATUS,
  isProbeCode
} = require('../../probes/ssot');

describe('Probe codes namespace lock', () => {
  it('probe codes must not overlap RUN_CODES', () => {
    const runCodes = new Set(Object.values(RUN_CODES));
    const probeCodes = [
      ...Object.values(PROBE_STEP_CODES),
      ...Object.values(PROBE_ATTEMPT_CODES)
    ];

    // Sanity: isProbeCode should recognize all probe codes
    for (const code of probeCodes) {
      assert.strictEqual(isProbeCode(code), true);
    }

    const overlaps = probeCodes.filter((c) => runCodes.has(c));
    assert.deepStrictEqual(overlaps, []);
  });

  it('PROBE_CODE_TO_STATUS keys must come only from PROBE_STEP_CODES', () => {
    const stepCodes = new Set(Object.values(PROBE_STEP_CODES));
    const attemptCodes = new Set(Object.values(PROBE_ATTEMPT_CODES));

    const mappingKeys = Object.keys(PROBE_CODE_TO_STATUS);
    assert.ok(mappingKeys.length > 0, 'PROBE_CODE_TO_STATUS should not be empty');

    const invalidKeys = mappingKeys.filter((k) => !stepCodes.has(k));
    assert.deepStrictEqual(
      invalidKeys,
      [],
      `Invalid PROBE_CODE_TO_STATUS keys (must be PROBE_STEP_CODES only): ${invalidKeys.join(', ')}`
    );

    const attemptKeyLeaks = mappingKeys.filter((k) => attemptCodes.has(k));
    assert.deepStrictEqual(
      attemptKeyLeaks,
      [],
      `Attempt-only codes must not appear in PROBE_CODE_TO_STATUS: ${attemptKeyLeaks.join(', ')}`
    );
  });
});
