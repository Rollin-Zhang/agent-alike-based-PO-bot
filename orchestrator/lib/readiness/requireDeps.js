/**
 * M2-A.1 requireDeps Middleware
 * 
 * Per-endpoint 最小依賴集合 gating
 * 
 * 不可變規則：
 * - 介面：requireDeps(['filesystem','memory'])（只接受 DepKey）
 * - 判斷：每次 request 都用 evaluator 的 snapshot 決定 missing deps
 * - 若缺 required ⇒ HTTP 503 + 503 body（固定 schema）
 * - Counter 打點規則：只在 middleware 擋下時打點，禁止把 dep-level DEP_* codes 打到 counter
 */

const { validate503Body, HTTP_CODES } = require('./ssot');
const { evaluateReadiness } = require('./evaluateReadiness');
const { readinessMetrics } = require('./readinessMetrics');

/**
 * Create requireDeps middleware
 * 
 * @param {string[]} requiredDepKeys - Array of DepKeys required for this endpoint
 * @param {Function} getDepStatesFn - Function to get current depStates (from toolGateway.getDepStates)
 * @returns {Function} Express middleware
 */
function requireDeps(requiredDepKeys, getDepStatesFn) {
  if (!Array.isArray(requiredDepKeys) || requiredDepKeys.length === 0) {
    throw new Error('requireDeps: requiredDepKeys must be a non-empty array');
  }
  if (typeof getDepStatesFn !== 'function') {
    throw new Error('requireDeps: getDepStatesFn must be a function');
  }

  return function requireDepsMiddleware(req, res, next) {
    try {
      // Get current readiness state
      const depStates = getDepStatesFn();
      const snapshot = evaluateReadiness(depStates, new Date());

      // Check if any required deps are missing
      const missingRequired = [];
      for (const depKey of requiredDepKeys) {
        const depState = snapshot.required[depKey];
        if (!depState || !depState.ready) {
          missingRequired.push(depKey);
        }
      }

      // If missing required deps, block with 503
      if (missingRequired.length > 0) {
        // Increment counters
        for (const depKey of missingRequired) {
          readinessMetrics.incrementRequiredUnavailable(depKey);
        }

        // Build 503 body
        const body = {
          error_code: HTTP_CODES.REQUIRED_UNAVAILABLE,
          missing_required: missingRequired,
          degraded: snapshot.degraded,
          as_of: snapshot.as_of
        };

        // Validate 503 body (self-check)
        if (!validate503Body(body)) {
          throw new Error('requireDeps: generated invalid 503 body (SSOT violation)');
        }

        return res.status(503).json(body);
      }

      // All required deps ready, continue
      next();
    } catch (error) {
      // Internal error, pass to error handler
      console.error('[requireDeps] Middleware error:', error);
      next(error);
    }
  };
}

module.exports = { requireDeps };
