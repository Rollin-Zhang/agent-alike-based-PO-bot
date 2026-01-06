/**
 * ProbeResult - Stable result format for startup probes
 * 
 * Phase A: Deterministic Safety Skeleton
 * 
 * All probe results must use stable error codes (not error message strings).
 * Tests can only assert on: name, ok, code, forced, provider.
 */

/**
 * Stable error codes (DO NOT rely on error message strings)
 */
const PROBE_CODES = Object.freeze({
  // Success
  OK: 'OK',
  
  // Forced failure (PROBE_FORCE_FAIL env)
  PROBE_FORCED_FAIL: 'PROBE_FORCED_FAIL',
  
  // Provider-level codes
  PROVIDER_UNAVAILABLE_NO_MCP: 'PROVIDER_UNAVAILABLE_NO_MCP',
  PROVIDER_NOT_IMPLEMENTED: 'PROVIDER_NOT_IMPLEMENTED',
  PROVIDER_CALL_FAILED: 'PROVIDER_CALL_FAILED',
  
  // Probe-level codes (Phase B will add more)
  PROBE_FORBIDDEN: 'PROBE_FORBIDDEN',
  PROBE_ACCESS_DENIED: 'PROBE_ACCESS_DENIED',
  PROBE_NOT_FOUND: 'PROBE_NOT_FOUND',
  PROBE_TIMEOUT: 'PROBE_TIMEOUT',
  PROBE_UNKNOWN_ERROR: 'PROBE_UNKNOWN_ERROR'
});

/**
 * Creates a standardized probe result object.
 * 
 * @param {Object} params
 * @param {string} params.name - Probe name (must match registry)
 * @param {boolean} params.ok - Whether probe passed
 * @param {string} params.code - Stable error code from PROBE_CODES
 * @param {boolean} [params.forced=false] - Whether failure was forced via PROBE_FORCE_FAIL
 * @param {string} [params.provider='unknown'] - Provider name that executed the probe
 * @returns {Object} ProbeResult
 */
function makeProbeResult({ name, ok, code, forced = false, provider = 'unknown' }) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('ProbeResult requires non-empty name');
  }
  if (typeof ok !== 'boolean') {
    throw new Error('ProbeResult requires boolean ok');
  }
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error('ProbeResult requires non-empty code');
  }
  
  return Object.freeze({
    name,
    ok,
    code,
    forced,
    provider,
    timestamp: new Date().toISOString()
  });
}

/**
 * Creates a success result.
 */
function makeSuccessResult(name, provider = 'unknown') {
  return makeProbeResult({
    name,
    ok: true,
    code: PROBE_CODES.OK,
    forced: false,
    provider
  });
}

/**
 * Creates a forced failure result (for PROBE_FORCE_FAIL).
 */
function makeForcedFailResult(name) {
  return makeProbeResult({
    name,
    ok: false,
    code: PROBE_CODES.PROBE_FORCED_FAIL,
    forced: true,
    provider: 'runner'
  });
}

/**
 * Creates a failure result with a specific code.
 */
function makeFailResult(name, code, provider = 'unknown') {
  return makeProbeResult({
    name,
    ok: false,
    code,
    forced: false,
    provider
  });
}

module.exports = {
  PROBE_CODES,
  makeProbeResult,
  makeSuccessResult,
  makeForcedFailResult,
  makeFailResult
};
