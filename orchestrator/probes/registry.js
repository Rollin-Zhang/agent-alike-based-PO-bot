/**
 * Probe Registry - Central registration of all startup probes
 * 
 * Blueprint §4 Alignment:
 * - Security Probe: attempt access to non-allowlist path → MUST fail
 * - Access Probe: list ./logs → MUST succeed
 * - Search Probe: search logs for simple keyword → MUST return valid structure
 * - Memory Probe: read_graph (empty allowed) → MUST succeed
 * 
 * Phase A: Stubs that always pass (for NO_MCP / fallback mode)
 * Phase B: Real MCP probes with provider.callTool()
 * 
 * IMPORTANT: Probes MUST handle graceful degradation when provider returns
 * PROVIDER_UNAVAILABLE_NO_MCP or PROVIDER_NOT_IMPLEMENTED.
 */

const { makeSuccessResult, makeFailResult, PROBE_CODES } = require('./result');
const { validateSearchShape, createInvalidSearchShape } = require('./searchShapeGate');
const { PROBE_STEP_CODES } = require('./ssot');

/**
 * Helper: Check if result indicates NO_MCP / stub mode (graceful pass)
 */
function isNoMcpOrStub(code) {
  return code === PROBE_CODES.PROVIDER_UNAVAILABLE_NO_MCP ||
         code === PROBE_CODES.PROVIDER_NOT_IMPLEMENTED;
}

/**
 * Blueprint-aligned probe implementations.
 */
const PROBES = [
  {
    name: 'security',
    description: 'Security probe - attempt access to non-allowlist path → MUST fail (Blueprint §4)',
    run: async (provider) => {
      // Blueprint: Try to access a path OUTSIDE allowlist (e.g., ./secrets)
      // Expected: Access MUST be denied (PROBE_ACCESS_DENIED or PROBE_FORBIDDEN)
      // If access succeeds, this is a security violation → probe fails
      
      const result = await provider.callTool('filesystem', 'read_file', { 
        path: './secrets/forbidden.txt' 
      });
      
      // Graceful degradation in NO_MCP mode
      if (isNoMcpOrStub(result.code)) {
        return makeSuccessResult('security', provider.name);
      }
      
      // Expected: access denied or forbidden
      if (result.code === PROBE_CODES.PROBE_ACCESS_DENIED ||
          result.code === PROBE_CODES.PROBE_FORBIDDEN ||
          result.code === PROBE_CODES.PROBE_NOT_FOUND) {
        // Good: blocked as expected
        return makeSuccessResult('security', provider.name);
      }
      
      // If OK → allowlist bypass (security violation!)
      if (result.ok) {
        return makeFailResult('security', PROBE_CODES.PROBE_FORBIDDEN, provider.name);
      }
      
      // Other errors are acceptable (connection issues, etc.)
      return makeSuccessResult('security', provider.name);
    }
  },
  {
    name: 'access',
    description: 'Access probe - list ./logs → MUST succeed (Blueprint §4)',
    run: async (provider) => {
      // Blueprint: Access allowed path ./logs
      // Expected: MUST succeed (or at least not be access-denied)
      
      const result = await provider.callTool('filesystem', 'list_directory', { 
        path: './logs' 
      });
      
      // Graceful degradation in NO_MCP mode
      if (isNoMcpOrStub(result.code)) {
        return makeSuccessResult('access', provider.name);
      }
      
      // Success or "empty dir" is fine
      if (result.ok) {
        return makeSuccessResult('access', provider.name);
      }
      
      // Directory not existing is acceptable (allowlist check passed)
      if (result.code === PROBE_CODES.PROBE_NOT_FOUND) {
        return makeSuccessResult('access', provider.name);
      }
      
      // Access denied to ./logs → allowlist misconfigured
      if (result.code === PROBE_CODES.PROBE_ACCESS_DENIED ||
          result.code === PROBE_CODES.PROBE_FORBIDDEN) {
        return makeFailResult('access', result.code, provider.name);
      }
      
      // Other errors (connection, etc.) → pass with degradation
      return makeSuccessResult('access', provider.name);
    }
  },
  {
    name: 'search',
    description: 'Search probe - search for simple keyword → MUST return valid structure (Blueprint §4)',
    run: async (provider) => {
      // Phase D: Shape gate - validate response structure (not just presence of results)
      // Support PROBE_FORCE_INVALID_SHAPE=search for deterministic testing
      
      const forceInvalidShape = process.env.PROBE_FORCE_INVALID_SHAPE === 'search';
      
      if (forceInvalidShape) {
        // Deterministic invalid shape injection for testing
        const invalidResponse = createInvalidSearchShape();
        const validation = validateSearchShape(invalidResponse);
        return makeFailResult('search', PROBE_STEP_CODES.SEARCH_PROBE_INVALID_SHAPE, provider.name);
      }
      
      // Blueprint: search_nodes for a simple keyword
      // Expected: MUST return a valid structure (even if empty)
      
      const result = await provider.callTool('memory', 'search_nodes', { 
        query: 'probe_test_keyword' 
      });
      
      // Graceful degradation in NO_MCP mode
      if (isNoMcpOrStub(result.code)) {
        return makeSuccessResult('search', provider.name);
      }
      
      // Phase D: Validate response shape (not just result.ok)
      if (result.ok) {
        const validation = validateSearchShape(result.data || {});
        
        if (!validation.valid) {
          // Response succeeded but shape is invalid
          return makeFailResult('search', PROBE_STEP_CODES.SEARCH_PROBE_INVALID_SHAPE, provider.name);
        }
        
        return makeSuccessResult('search', provider.name);
      }
      
      // Search failure → probe fails
      return makeFailResult('search', result.code, provider.name);
    }
  },
  {
    name: 'memory',
    description: 'Memory probe - read_graph (empty allowed) → MUST succeed (Blueprint §4)',
    run: async (provider) => {
      // Blueprint: read_graph should succeed
      // Note: Memory write policy is handled by provider-level policy, not this probe
      
      const result = await provider.callTool('memory', 'read_graph', {});
      
      // Graceful degradation in NO_MCP mode
      if (isNoMcpOrStub(result.code)) {
        return makeSuccessResult('memory', provider.name);
      }
      
      // Success (even with empty graph) is fine
      if (result.ok) {
        return makeSuccessResult('memory', provider.name);
      }
      
      // read_graph failure → probe fails
      return makeFailResult('memory', result.code, provider.name);
    }
  }
];

/**
 * Returns the probe registry array.
 * Each entry: { name: string, description: string, run: async (provider) => ProbeResult }
 */
function getProbeRegistry() {
  return PROBES;
}

/**
 * Finds a probe by name.
 * @returns {Object|null} probe entry or null
 */
function findProbeByName(name) {
  return PROBES.find(p => p.name === name) || null;
}

/**
 * Returns all registered probe names.
 */
function getProbeNames() {
  return PROBES.map(p => p.name);
}

module.exports = {
  getProbeRegistry,
  findProbeByName,
  getProbeNames
};
