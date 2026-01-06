/**
 * Phase B Integration Tests - Real MCP Provider
 * 
 * These tests require real MCP servers to be available.
 * Gate: RUN_REAL_MCP_TESTS=true
 * 
 * Test categories:
 * - B1: RealMcpProvider initialization and callTool
 * - B2: Memory read-only policy enforcement
 * - B3: Probe execution with real provider
 */

const path = require('path');

/**
 * Test helper: run tests only when RUN_REAL_MCP_TESTS=true
 */
function skipUnlessRealMcp(testName) {
  if (process.env.RUN_REAL_MCP_TESTS !== 'true') {
    console.log(`[SKIP] ${testName} (requires RUN_REAL_MCP_TESTS=true)`);
    return true;
  }
  return false;
}

/**
 * B1: RealMcpProvider returns PROVIDER_NOT_IMPLEMENTED before initialize()
 */
async function testRealMcpProviderNotInitialized() {
  const { RealMcpProvider, MEMORY_READ_ONLY_TOOLS } = require('../../probes/providers/RealMcpProvider');
  const { PROBE_CODES } = require('../../probes/result');
  
  const provider = new RealMcpProvider();
  
  // Without initialize(), callTool should return PROVIDER_NOT_IMPLEMENTED
  const result = await provider.callTool('memory', 'read_graph', {});
  
  if (result.code !== PROBE_CODES.PROVIDER_NOT_IMPLEMENTED) {
    throw new Error(`Expected PROVIDER_NOT_IMPLEMENTED, got ${result.code}`);
  }
  
  if (result.ok !== false) {
    throw new Error('Expected ok=false for uninitialized provider');
  }
  
  // Verify MEMORY_READ_ONLY_TOOLS is exported and contains expected tools
  if (!Array.isArray(MEMORY_READ_ONLY_TOOLS)) {
    throw new Error('MEMORY_READ_ONLY_TOOLS should be an array');
  }
  if (!MEMORY_READ_ONLY_TOOLS.includes('read_graph')) {
    throw new Error('MEMORY_READ_ONLY_TOOLS should include read_graph');
  }
  
  console.log('[PASS] testRealMcpProviderNotInitialized');
  return true;
}

/**
 * B2: RealMcpProvider.isToolAllowed enforces read-only policy (default)
 * And allows writes when MEMORY_WRITE_ENABLED=true
 */
async function testMemoryReadOnlyPolicy() {
  const { RealMcpProvider } = require('../../probes/providers/RealMcpProvider');
  
  // Test default (read-only)
  const providerReadOnly = new RealMcpProvider();
  
  // Read tools should be allowed
  if (!providerReadOnly.isToolAllowed('memory', 'read_graph')) {
    throw new Error('read_graph should be allowed');
  }
  if (!providerReadOnly.isToolAllowed('memory', 'search_nodes')) {
    throw new Error('search_nodes should be allowed');
  }
  if (!providerReadOnly.isToolAllowed('memory', 'open_nodes')) {
    throw new Error('open_nodes should be allowed');
  }
  
  // Write tools should be blocked by default
  if (providerReadOnly.isToolAllowed('memory', 'create_entities')) {
    throw new Error('create_entities should NOT be allowed by default');
  }
  if (providerReadOnly.isToolAllowed('memory', 'delete_entities')) {
    throw new Error('delete_entities should NOT be allowed by default');
  }
  
  // Test with memoryWriteEnabled=true (Stage 2+ scenario)
  const providerWriteEnabled = new RealMcpProvider({ memoryWriteEnabled: true });
  
  // Write tools should be allowed when explicitly enabled
  if (!providerWriteEnabled.isToolAllowed('memory', 'create_entities')) {
    throw new Error('create_entities should be allowed when memoryWriteEnabled=true');
  }
  if (!providerWriteEnabled.isToolAllowed('memory', 'delete_entities')) {
    throw new Error('delete_entities should be allowed when memoryWriteEnabled=true');
  }
  
  // Non-memory servers should allow all (for now)
  if (!providerReadOnly.isToolAllowed('filesystem', 'read_file')) {
    throw new Error('Non-memory server tools should be allowed');
  }
  
  console.log('[PASS] testMemoryReadOnlyPolicy');
  return true;
}

/**
 * B3: RealMcpProvider returns PROBE_FORBIDDEN for blocked tools
 */
async function testMemoryWriteBlocked() {
  const { RealMcpProvider } = require('../../probes/providers/RealMcpProvider');
  const { PROBE_CODES } = require('../../probes/result');
  
  const provider = new RealMcpProvider();
  // We need to fake initialization to test the policy check
  provider.initialized = true;
  provider.toolGateway = {
    executeTool: async () => { throw new Error('Should not reach here'); }
  };
  
  const result = await provider.callTool('memory', 'create_entities', {
    entities: [{ name: 'test' }]
  });
  
  if (result.ok !== false) {
    throw new Error('Expected ok=false for blocked tool');
  }
  if (result.code !== PROBE_CODES.PROBE_FORBIDDEN) {
    throw new Error(`Expected PROBE_FORBIDDEN, got ${result.code}`);
  }
  if (!result.data || result.data.reason !== 'tool_not_allowed_by_policy') {
    throw new Error('Expected data.reason = tool_not_allowed_by_policy');
  }
  
  console.log('[PASS] testMemoryWriteBlocked');
  return true;
}

/**
 * B4: Phase B probes handle NO_MCP mode gracefully
 */
async function testPhaseBProbesNoMcpMode() {
  const { NoMcpProvider } = require('../../probes/providers/NoMcpProvider');
  const { getProbeRegistry } = require('../../probes/registry');
  const { PROBE_CODES } = require('../../probes/result');
  
  const provider = new NoMcpProvider();
  const probes = getProbeRegistry();
  
  // All Phase B probes should pass with NoMcpProvider
  // (graceful degradation - they check for PROVIDER_UNAVAILABLE_NO_MCP)
  for (const probe of probes) {
    const result = await probe.run(provider);
    
    if (!result.ok) {
      throw new Error(`Probe ${probe.name} should pass in NO_MCP mode, got code: ${result.code}`);
    }
  }
  
  console.log('[PASS] testPhaseBProbesNoMcpMode');
  return true;
}

/**
 * B5: createProviderFromEnv returns correct provider type with defensive fallback
 */
async function testCreateProviderFromEnv() {
  const { createProviderFromEnv } = require('../../probes/ProbeRunner');
  
  // Case 1: Explicit NO_MCP=true → NoMcpProvider
  const noMcpProvider = createProviderFromEnv({ noMcp: true });
  if (noMcpProvider.name !== 'NoMcpProvider') {
    throw new Error(`Expected NoMcpProvider for noMcp=true, got ${noMcpProvider.name}`);
  }
  
  // Case 2: realMcpTests=true → RealMcpProvider
  const realProvider = createProviderFromEnv({ realMcpTests: true });
  if (realProvider.name !== 'RealMcpProvider') {
    throw new Error(`Expected RealMcpProvider for realMcpTests=true, got ${realProvider.name}`);
  }
  
  // Case 3: No env vars, no config → NoMcpProvider:fallback (defensive)
  const fallbackProvider = createProviderFromEnv({});
  if (!fallbackProvider.name.startsWith('NoMcpProvider')) {
    throw new Error(`Expected NoMcpProvider fallback, got ${fallbackProvider.name}`);
  }
  
  console.log('[PASS] testCreateProviderFromEnv');
  return true;
}

/**
 * B6: RealMcpProvider with real MCP (gated)
 */
async function testRealMcpProviderWithRealMcp() {
  if (skipUnlessRealMcp('testRealMcpProviderWithRealMcp')) return true;
  
  const { RealMcpProvider } = require('../../probes/providers/RealMcpProvider');
  const { PROBE_CODES } = require('../../probes/result');
  
  const configPath = path.join(__dirname, '../fixtures/mcp_config_minimal.json');
  const provider = new RealMcpProvider({ 
    configPath,
    logger: { log: () => {}, error: () => {}, warn: () => {} } // Quiet logger
  });
  
  try {
    await provider.initialize();
    
    // Test read_graph (should work)
    const readResult = await provider.callTool('memory', 'read_graph', {});
    if (!readResult.ok) {
      throw new Error(`read_graph failed: ${readResult.code}`);
    }
    
    // Test create_entities (should be blocked by policy)
    const writeResult = await provider.callTool('memory', 'create_entities', {
      entities: [{ name: 'probe_test', entityType: 'test', observations: [] }]
    });
    if (writeResult.code !== PROBE_CODES.PROBE_FORBIDDEN) {
      throw new Error(`Expected PROBE_FORBIDDEN for create_entities, got ${writeResult.code}`);
    }
    
    console.log('[PASS] testRealMcpProviderWithRealMcp');
    return true;
  } finally {
    await provider.cleanup();
  }
}

/**
 * B7: Full probe run with real MCP (gated)
 */
async function testFullProbeRunWithRealMcp() {
  if (skipUnlessRealMcp('testFullProbeRunWithRealMcp')) return true;
  
  const { ProbeRunner, createProviderFromEnv } = require('../../probes/ProbeRunner');
  
  const configPath = path.join(__dirname, '../fixtures/mcp_config_minimal.json');
  const provider = createProviderFromEnv({ noMcp: false, configPath });
  
  try {
    await provider.initialize();
    
    const runner = new ProbeRunner();
    const { results, allPassed } = await runner.runAll({ provider });
    
    if (!allPassed) {
      const failed = results.filter(r => !r.ok);
      throw new Error(`Probes failed: ${failed.map(r => `${r.name}:${r.code}`).join(', ')}`);
    }
    
    console.log('[PASS] testFullProbeRunWithRealMcp');
    return true;
  } finally {
    await provider.cleanup();
  }
}

// Export all tests
module.exports = {
  testRealMcpProviderNotInitialized,
  testMemoryReadOnlyPolicy,
  testMemoryWriteBlocked,
  testPhaseBProbesNoMcpMode,
  testCreateProviderFromEnv,
  testRealMcpProviderWithRealMcp,
  testFullProbeRunWithRealMcp
};
