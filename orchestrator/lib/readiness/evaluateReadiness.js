/**
 * M2-A.1 Readiness Evaluator
 * 
 * 唯一真理來源：禁止到處 if(NO_MCP)；所有 readiness 只看 evaluator 輸出
 * 
 * Input: depStates (來自 toolGateway.getDepStates(), ProviderId 視角)
 * Output: ReadinessSnapshot (DepKey 視角，依 SSOT mapping 聚合)
 */

const {
  REQUIRED_DEPS,
  OPTIONAL_DEPS,
  PROVIDER_TO_DEPKEY,
  DEP_CODES,
  validateReadinessSnapshot
} = require('./ssot');

/**
 * Evaluate readiness from provider states
 * 
 * @param {Object} depStates - { [providerId]: { ready:boolean, code:DEP_*, detail?:object } }
 * @param {Date|string} now - timestamp for as_of
 * @returns {Object} ReadinessSnapshot (DepKey 視角)
 * 
 * 不可變規則：
 * - DepKey 的 ready 只由對應 ProviderId 決定（mapping 唯一）
 * - optional 任一不 ready ⇒ degraded=true
 * - required 任一不 ready ⇒ degraded=true（但是否 503 由 middleware 決定，不在 evaluator）
 */
function evaluateReadiness(depStates, now) {
  if (!depStates || typeof depStates !== 'object') {
    throw new Error('evaluateReadiness: depStates must be an object');
  }

  const asOf = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  
  let degraded = false;
  const required = {};
  const optional = {};

  // Process required deps
  for (const { key, provider } of REQUIRED_DEPS) {
    const providerState = depStates[provider];
    
    if (!providerState || !providerState.ready) {
      // Not ready: mark degraded
      degraded = true;
      required[key] = {
        ready: false,
        code: (providerState && providerState.code) || DEP_CODES.UNAVAILABLE,
        ...(providerState && providerState.detail ? { detail: providerState.detail } : {})
      };
    } else {
      // Ready
      required[key] = {
        ready: true,
        code: null
      };
    }
  }

  // Process optional deps
  for (const { key, provider } of OPTIONAL_DEPS) {
    const providerState = depStates[provider];
    
    if (!providerState || !providerState.ready) {
      // Optional not ready: mark degraded (不影響 required ready)
      degraded = true;
      optional[key] = {
        ready: false,
        code: (providerState && providerState.code) || DEP_CODES.UNAVAILABLE,
        ...(providerState && providerState.detail ? { detail: providerState.detail } : {})
      };
    } else {
      // Ready
      optional[key] = {
        ready: true,
        code: null
      };
    }
  }

  const snapshot = {
    degraded,
    required,
    optional,
    as_of: asOf
  };

  // Validate output (self-check)
  if (!validateReadinessSnapshot(snapshot)) {
    throw new Error('evaluateReadiness: generated invalid snapshot (SSOT violation)');
  }

  return snapshot;
}

module.exports = { evaluateReadiness };
