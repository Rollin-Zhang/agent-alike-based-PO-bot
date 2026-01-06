/**
 * ProbeRunner - Unified Startup Probe Runner
 * 
 * Phase A: Deterministic Safety Skeleton
 * 
 * Responsibilities:
 * - Manage probe execution flow
 * - Handle PROBE_FORCE_FAIL (bypass provider, deterministic failure)
 * - Aggregate results and determine overall pass/fail
 * - Does NOT directly touch MCP / filesystem / memory
 * 
 * Runner only handles flow control and decision making.
 */

const { getProbeRegistry } = require('./registry');
const { makeForcedFailResult } = require('./result');

class ProbeRunner {
  /**
   * @param {Object} options
   * @param {string} [options.forceFailName] - Probe name to force-fail (from PROBE_FORCE_FAIL env)
   */
  constructor(options = {}) {
    this.forceFailName = options.forceFailName || null;
  }

  /**
   * Checks if a probe should be force-failed.
   * Force-fail bypasses provider entirely - runner handles it directly.
   * 
   * @param {string} probeName
   * @returns {boolean}
   */
  shouldForceFail(probeName) {
    return this.forceFailName !== null && this.forceFailName === probeName;
  }

  /**
   * Runs all registered probes.
   * 
   * @param {Object} params
   * @param {Object} params.provider - Provider instance (NoMcpProvider or RealMcpProvider)
   * @returns {Promise<{results: Array, allPassed: boolean}>}
   */
  async runAll({ provider }) {
    const registry = getProbeRegistry();
    const results = [];

    for (const probe of registry) {
      let result;

      // PROBE_FORCE_FAIL: bypass provider, runner creates fail result directly
      if (this.shouldForceFail(probe.name)) {
        result = makeForcedFailResult(probe.name);
      } else {
        try {
          result = await probe.run(provider);
        } catch (err) {
          // Probe threw an error - convert to fail result
          // Note: We do NOT include error message in result (no string matching)
          const { makeFailResult, PROBE_CODES } = require('./result');
          result = makeFailResult(probe.name, PROBE_CODES.PROBE_UNKNOWN_ERROR, provider.name);
        }
      }

      results.push(result);
    }

    const allPassed = results.every(r => r.ok === true);

    return {
      results,
      allPassed
    };
  }
}

/**
 * Creates a provider based on environment.
 * 
 * Defensive fallback logic (Phase A & B compatible):
 * - NO_MCP=true → NoMcpProvider
 * - RUN_REAL_MCP_TESTS=true OR MCP_CONFIG_PATH exists → RealMcpProvider
 * - Otherwise → NoMcpProvider (tagged as 'NoMcpProvider:fallback')
 * 
 * This ensures:
 * - Phase A tests work without setting NO_MCP (deterministic by default)
 * - Production with real MCP requires explicit opt-in (RUN_REAL_MCP_TESTS or config path)
 * - System won't "explode" on a fresh clone with no config
 * 
 * @param {Object} options
 * @param {boolean} [options.noMcp] - Whether NO_MCP mode is explicitly enabled
 * @param {string} [options.configPath] - Path to MCP config (for RealMcpProvider)
 * @param {boolean} [options.realMcpTests] - Whether RUN_REAL_MCP_TESTS is enabled
 * @returns {Object} Provider instance
 */
function createProviderFromEnv({ noMcp, configPath, realMcpTests } = {}) {
  const fs = require('fs');
  
  // Case 1: Explicit NO_MCP=true → NoMcpProvider
  if (noMcp === true) {
    const { NoMcpProvider } = require('./providers/NoMcpProvider');
    return new NoMcpProvider();
  }
  
  // Case 2: RUN_REAL_MCP_TESTS=true OR configPath exists → try RealMcpProvider
  const hasConfig = configPath && fs.existsSync(configPath);
  if (realMcpTests === true || hasConfig) {
    const { RealMcpProvider } = require('./providers/RealMcpProvider');
    return new RealMcpProvider({ configPath });
  }
  
  // Case 3: Fallback → NoMcpProvider (tagged to indicate it's a fallback)
  // This prevents "explosion" on fresh clone with no MCP config
  const { NoMcpProvider } = require('./providers/NoMcpProvider');
  const provider = new NoMcpProvider();
  provider.name = 'NoMcpProvider:fallback'; // Tag for observability
  return provider;
}

module.exports = {
  ProbeRunner,
  createProviderFromEnv
};
