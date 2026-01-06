/**
 * strictCutoverGate.js (M2-C.1)
 *
 * Minimal, deterministic gate function for deciding whether strict/cleanup
 * can be enabled, based on cutover policy mode + low-cardinality counters.
 */

const { createCutoverPolicy } = require('./CutoverPolicy');

const STRICT_GATE_REASONS = Object.freeze({
  FORCED_ON: 'forced_on',
  FORCED_OFF: 'forced_off',
  CANONICAL_MISSING_NONZERO: 'canonical_missing_nonzero',
  CUTOVER_VIOLATION_NONZERO: 'cutover_violation_nonzero',
  LEGACY_READ_POST_CUTOVER_NONZERO: 'legacy_read_post_cutover_nonzero'
});

function getCount(metricsSnapshot, event_type, field) {
  const rows = metricsSnapshot && Array.isArray(metricsSnapshot.counters)
    ? metricsSnapshot.counters
    : [];

  const hit = rows.find((r) => r.event_type === event_type && r.field === field);
  return hit ? Number(hit.count || 0) : 0;
}

/**
 * canEnableStrict
 *
 * Rules (SSOT for M2-C.2 readiness):
 * - Always require canonical_missing == 0 and cutover_violation == 0
 * - pre_cutover: legacy_read may be > 0
 * - post_cutover: legacy_read must be 0
 */
function canEnableStrict(options = {}) {
  const {
    nowMs = Date.now(),
    policy = createCutoverPolicy(),
    metricsSnapshot,
    env = process.env
  } = options;

  const mode = policy.mode(nowMs);

  const canonical_missing = getCount(metricsSnapshot, 'canonical_missing', 'tool_verdict');
  const cutover_violation = getCount(metricsSnapshot, 'cutover_violation', 'tool_verdict');
  const legacy_read = getCount(metricsSnapshot, 'legacy_read', 'tool_verdict');

  const reasons = [];
  if (canonical_missing !== 0) reasons.push(STRICT_GATE_REASONS.CANONICAL_MISSING_NONZERO);
  if (cutover_violation !== 0) reasons.push(STRICT_GATE_REASONS.CUTOVER_VIOLATION_NONZERO);
  if (mode === 'post_cutover' && legacy_read !== 0) reasons.push(STRICT_GATE_REASONS.LEGACY_READ_POST_CUTOVER_NONZERO);

  // Test-only deterministic override
  if (env && env.NODE_ENV === 'test') {
    const force = env.STRICT_GATE_FORCE ? String(env.STRICT_GATE_FORCE) : null;
    if (force === 'on') {
      return {
        ok: true,
        mode,
        counts: { canonical_missing, cutover_violation, legacy_read },
        reasons: [STRICT_GATE_REASONS.FORCED_ON, ...reasons]
      };
    }
    if (force === 'off') {
      return {
        ok: false,
        mode,
        counts: { canonical_missing, cutover_violation, legacy_read },
        reasons: [STRICT_GATE_REASONS.FORCED_OFF, ...reasons]
      };
    }
  }

  return {
    ok: reasons.length === 0,
    mode,
    counts: { canonical_missing, cutover_violation, legacy_read },
    reasons
  };
}

module.exports = {
  STRICT_GATE_REASONS,
  canEnableStrict
};
