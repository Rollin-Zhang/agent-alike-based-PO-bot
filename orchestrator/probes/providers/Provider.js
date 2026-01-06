/**
 * Provider Interface - Abstract base for probe providers
 * 
 * Phase A: Deterministic Safety Skeleton
 * 
 * Providers handle the actual execution of probe checks.
 * Phase A only requires NoMcpProvider.
 * Phase B will implement RealMcpProvider using ToolGateway.
 * 
 * Provider contract:
 * - name: string identifier
 * - callTool(serverId, toolName, args): async => { ok, code, data }
 */

/**
 * Provider result format (returned by callTool).
 * @typedef {Object} ProviderCallResult
 * @property {boolean} ok - Whether the call succeeded
 * @property {string} code - Stable error code
 * @property {any} [data] - Optional response data
 */

/**
 * Base provider class (for documentation / type checking).
 * Real implementations should extend or duck-type this interface.
 */
class Provider {
  constructor(name) {
    if (new.target === Provider) {
      throw new Error('Provider is abstract and cannot be instantiated directly');
    }
    this.name = name;
  }

  /**
   * Calls an MCP tool.
   * @param {string} serverId - MCP server identifier
   * @param {string} toolName - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<ProviderCallResult>}
   */
  async callTool(serverId, toolName, args) {
    throw new Error('callTool must be implemented by subclass');
  }

  /**
   * Initializes the provider (if needed).
   * @returns {Promise<void>}
   */
  async initialize() {
    // Default: no-op
  }

  /**
   * Cleans up the provider (if needed).
   * @returns {Promise<void>}
   */
  async cleanup() {
    // Default: no-op
  }
}

module.exports = { Provider };
