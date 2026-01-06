/**
 * CutoverPolicy.js (M2-C.1)
 * Canonical-only cutover policy SSOT.
 *
 * Contract (SSOT):
 * - Single global cutoff: CUTOVER_UNTIL_MS (epoch ms)
 * - mode(nowMs): 'pre_cutover' | 'post_cutover'
 * - legacy_write_allowed: always false
 * - legacy_read_allowed: pre_cutover may allow for residual compat (observable)
 *
 * Notes:
 * - This module is the ONLY place allowed to interpret cutoff.
 */

const MODES = Object.freeze({
  PRE: 'pre_cutover',
  POST: 'post_cutover'
});

// NOTE: DUALWRITE_UNTIL_MS is deprecated (kept only for backward compatibility).
function parseCutoverUntilMs(env = process.env) {
  const raw = env.CUTOVER_UNTIL_MS ?? env.DUALWRITE_UNTIL_MS ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.floor(ms);
}

function parseCutoverConfig(env = process.env) {
  if (env.CUTOVER_UNTIL_MS !== undefined && env.CUTOVER_UNTIL_MS !== '') {
    return { ms: parseCutoverUntilMs({ CUTOVER_UNTIL_MS: env.CUTOVER_UNTIL_MS }), source: 'CUTOVER_UNTIL_MS' };
  }

  if (env.DUALWRITE_UNTIL_MS !== undefined && env.DUALWRITE_UNTIL_MS !== '') {
    return { ms: parseCutoverUntilMs({ DUALWRITE_UNTIL_MS: env.DUALWRITE_UNTIL_MS }), source: 'DUALWRITE_UNTIL_MS' };
  }

  return { ms: null, source: null };
}

function createCutoverPolicy(options = {}) {
  const {
    cutover_until_ms,
    nowFn = () => Date.now(),
    legacy_read_allowed_pre_cutover = true
  } = options;

  const fromEnv = parseCutoverConfig();
  const effectiveCutoff = cutover_until_ms !== undefined ? cutover_until_ms : fromEnv.ms;
  const env_source = cutover_until_ms !== undefined ? 'explicit' : fromEnv.source;

  function mode(nowMs = nowFn()) {
    if (!effectiveCutoff) return MODES.PRE;
    return nowMs <= effectiveCutoff ? MODES.PRE : MODES.POST;
  }

  function isLegacyWriteAllowed() {
    return false;
  }

  function isLegacyReadAllowed(nowMs = nowFn()) {
    return mode(nowMs) === MODES.PRE ? Boolean(legacy_read_allowed_pre_cutover) : false;
  }

  return {
    cutover_until_ms: effectiveCutoff || null,
    env_source,
    mode,
    isLegacyWriteAllowed,
    isLegacyReadAllowed
  };
}

module.exports = {
  MODES,
  parseCutoverUntilMs,
  parseCutoverConfig,
  createCutoverPolicy
};
