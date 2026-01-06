/**
 * NoMcpProvider - Provider for NO_MCP mode (Phase A primary)
 * 
 * Phase A: Deterministic Safety Skeleton
 * 
 * This provider does NOT connect to any MCP servers.
 * All callTool invocations return a stable code indicating unavailability.
 * 
 * This allows Phase A tests to run without any MCP dependencies.
 */

const { PROBE_CODES } = require('../result');

class NoMcpProvider {
  constructor() {
    this.name = 'NoMcpProvider';
  }

  /**
   * Always returns PROVIDER_UNAVAILABLE_NO_MCP.
   * This is expected behavior in NO_MCP mode.
   * 
   * @param {string} serverId
   * @param {string} toolName
   * @param {Object} args
   * @returns {Promise<{ok: boolean, code: string, data: null}>}
   */
  async callTool(serverId, toolName, args) {
    return {
      ok: false,
      code: PROBE_CODES.PROVIDER_UNAVAILABLE_NO_MCP,
      data: null
    };
  }

  async initialize() {
    // No-op: NoMcpProvider doesn't connect to anything
  }

  async cleanup() {
    // No-op
  }
}

module.exports = { NoMcpProvider };
