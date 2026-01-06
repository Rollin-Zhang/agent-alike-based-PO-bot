/**
 * RealMcpProvider - Provider for real MCP connections (Phase B)
 * 
 * Phase B Implementation:
 * - Connects via ToolGateway
 * - Executes real MCP calls
 * - Returns stable error codes (not error strings)
 * - Supports configurable memory write policy (default: read-only in Stage 1)
 * 
 * Memory Write Policy (env-controlled):
 * - MEMORY_WRITE_ENABLED=true → allow write tools (for Stage 2+ self-evolution)
 * - Otherwise → read-only (only read_graph, search_nodes, open_nodes)
 * 
 * Phase A tests must still pass (they use NoMcpProvider or fallback).
 */

const { PROBE_CODES } = require('../result');

// Memory server read-only allowlist (Stage 1 default)
const MEMORY_READ_ONLY_TOOLS = Object.freeze([
  'read_graph',
  'search_nodes',
  'open_nodes'
]);

// Memory server write tools (Stage 2+ with MEMORY_WRITE_ENABLED=true)
const MEMORY_WRITE_TOOLS = Object.freeze([
  'create_entities',
  'create_relations',
  'add_observations',
  'delete_entities',
  'delete_observations',
  'delete_relations'
]);

class RealMcpProvider {
  /**
   * @param {Object} options
   * @param {string} [options.configPath] - Path to MCP config
   * @param {boolean} [options.memoryWriteEnabled] - Override for MEMORY_WRITE_ENABLED env
   * @param {Object} [options.logger] - Logger instance
   */
  constructor(options = {}) {
    this.name = 'RealMcpProvider';
    this.options = options;
    this.toolGateway = null;
    this.initialized = false;
    this.logger = options.logger || console;
    
    // Memory write policy: env-controlled, can be overridden via options
    this.memoryWriteEnabled = options.memoryWriteEnabled ?? 
      (process.env.MEMORY_WRITE_ENABLED === 'true');
  }

  /**
   * Initializes ToolGateway with MCP connections.
   * Throws on failure (for fail-fast behavior).
   */
  async initialize() {
    if (this.initialized) return;

    const ToolGateway = require('../../tool_gateway/ToolGateway');
    
    // Load config (allow override via options or env)
    const configPath = this.options.configPath || process.env.MCP_CONFIG_PATH;
    let config = null;
    
    if (configPath) {
      const fs = require('fs');
      if (!fs.existsSync(configPath)) {
        throw new Error(`MCP config not found: ${configPath}`);
      }
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    // If no configPath, ToolGateway will use its default

    this.toolGateway = new ToolGateway(this.logger, config);
    
    // Initialize all MCP connections
    await this.toolGateway.initialize();
    
    this.initialized = true;
  }

  /**
   * Cleanup MCP connections.
   */
  async cleanup() {
    try {
      if (this.toolGateway && typeof this.toolGateway.shutdown === 'function') {
        await this.toolGateway.shutdown();
      }
    } finally {
      this.initialized = false;
      this.toolGateway = null;
    }
  }

  /**
   * Checks if a tool is allowed for memory server.
   * Policy is env-controlled: MEMORY_WRITE_ENABLED=true allows writes.
   * 
   * @param {string} serverId
   * @param {string} toolName
   * @returns {boolean}
   */
  isToolAllowed(serverId, toolName) {
    if (serverId === 'memory') {
      // Read tools always allowed
      if (MEMORY_READ_ONLY_TOOLS.includes(toolName)) {
        return true;
      }
      // Write tools only if MEMORY_WRITE_ENABLED
      if (MEMORY_WRITE_TOOLS.includes(toolName)) {
        return this.memoryWriteEnabled;
      }
      // Unknown tool → block by default
      return false;
    }
    // For other servers, allow all (can be extended later)
    return true;
  }

  /**
   * Calls an MCP tool via ToolGateway.
   * 
   * @param {string} serverId - MCP server identifier
   * @param {string} toolName - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<{ok: boolean, code: string, data: any}>}
   */
  async callTool(serverId, toolName, args) {
    if (!this.initialized) {
      return {
        ok: false,
        code: PROBE_CODES.PROVIDER_NOT_IMPLEMENTED,
        data: null
      };
    }

    // Enforce read-only policy for memory server
    if (!this.isToolAllowed(serverId, toolName)) {
      return {
        ok: false,
        code: PROBE_CODES.PROBE_FORBIDDEN,
        data: { reason: 'tool_not_allowed_by_policy', serverId, toolName }
      };
    }

    try {
      const result = await this.toolGateway.executeTool(serverId, toolName, args);
      
      // Check for MCP-level errors in result
      if (result && result.isError === true) {
        return {
          ok: false,
          code: PROBE_CODES.PROVIDER_CALL_FAILED,
          data: result
        };
      }

      return {
        ok: true,
        code: PROBE_CODES.OK,
        data: result
      };
    } catch (err) {
      // Map common errors to stable codes
      const code = this.mapErrorToCode(err);
      return {
        ok: false,
        code,
        data: { errorCode: err.code, message: err.message }
      };
    }
  }

  /**
   * Maps an error to a stable probe code.
   * Uses error.code property, NOT error message string matching.
   * @param {Error} err
   * @returns {string}
   */
  mapErrorToCode(err) {
    // Check for known error codes, not message strings
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      return PROBE_CODES.PROBE_ACCESS_DENIED;
    }
    if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
      return PROBE_CODES.PROBE_TIMEOUT;
    }
    if (err.code === 'ECONNREFUSED') {
      return PROBE_CODES.PROVIDER_CALL_FAILED;
    }
    // Generic fallback
    return PROBE_CODES.PROVIDER_CALL_FAILED;
  }
}

module.exports = { RealMcpProvider, MEMORY_READ_ONLY_TOOLS, MEMORY_WRITE_TOOLS };
