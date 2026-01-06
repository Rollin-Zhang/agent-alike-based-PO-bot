/**
 * M2-A.1 Readiness Metrics
 * 
 * Counter 累積與 snapshot for /metrics
 * 
 * 不可變規則：
 * - counter key 格式：「depKey|MCP_REQUIRED_UNAVAILABLE」
 * - 只在 middleware 擋下時打點（不能用 DEP_* codes）
 */

const { REQUIRED_DEPS, OPTIONAL_DEPS, HTTP_CODES, formatCounterKey } = require('./ssot');

class ReadinessMetrics {
  constructor() {
    // Counter: { [depKey|MCP_REQUIRED_UNAVAILABLE]: number }
    this.requiredUnavailableTotal = {};
    
    // Initialize counters to 0
    for (const { key } of REQUIRED_DEPS) {
      const counterKey = formatCounterKey(key, HTTP_CODES.REQUIRED_UNAVAILABLE);
      this.requiredUnavailableTotal[counterKey] = 0;
    }
  }

  /**
   * Increment counter when middleware blocks request
   * 
   * @param {string} depKey - DepKey (not ProviderId)
   */
  incrementRequiredUnavailable(depKey) {
    const counterKey = formatCounterKey(depKey, HTTP_CODES.REQUIRED_UNAVAILABLE);
    
    if (this.requiredUnavailableTotal[counterKey] === undefined) {
      // Defensive: initialize if not exists
      this.requiredUnavailableTotal[counterKey] = 0;
    }
    
    this.requiredUnavailableTotal[counterKey]++;
  }

  /**
   * Get /metrics readiness snapshot
   * 
   * @param {Object} readinessSnapshot - from evaluator
   * @returns {Object} metrics readiness shape
   */
  getMetricsSnapshot(readinessSnapshot) {
    const requiredReady = {};
    const optionalReady = {};

    // required_ready: { [depKey]: 0|1 }
    for (const { key } of REQUIRED_DEPS) {
      requiredReady[key] = readinessSnapshot.required[key]?.ready ? 1 : 0;
    }

    // optional_ready: { [depKey]: 0|1 }
    for (const { key } of OPTIONAL_DEPS) {
      optionalReady[key] = readinessSnapshot.optional[key]?.ready ? 1 : 0;
    }

    return {
      degraded: readinessSnapshot.degraded ? 1 : 0,
      required_ready: requiredReady,
      optional_ready: optionalReady,
      required_unavailable_total: { ...this.requiredUnavailableTotal }
    };
  }

  /**
   * Reset counters (for testing)
   */
  reset() {
    for (const key of Object.keys(this.requiredUnavailableTotal)) {
      this.requiredUnavailableTotal[key] = 0;
    }
  }
}

// Singleton instance
const readinessMetrics = new ReadinessMetrics();

module.exports = { ReadinessMetrics, readinessMetrics };
