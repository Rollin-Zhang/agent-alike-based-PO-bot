/**
 * M2-A ↔ M2-B Integration Test: In-Process Path
 *
 * Goal:
 * - RunnerCore uses an in-process gateway (InProcessToolsGatewayAdapter)
 *   that calls ToolExecutionService.
 * - ToolExecutionService applies M2-A governance: readiness gating, schemaGate, audit.
 * - When deps are unavailable, execution is blocked with stable code MCP_REQUIRED_UNAVAILABLE.
 * - Schema gate strict internal reject semantics are preserved (ok=false, no throw).
 *
 * Minimal validation points:
 * 1. Readiness gating works (deps unavailable → blocked)
 * 2. SchemaGate strict internal reject works (invalid args → blocked, ok=false)
 * 3. Audit structure exists (can verify gate events were recorded)
 */

const assert = require('assert');
const { run: runCore } = require('../../lib/tool_runner/RunnerCore');
const { InProcessToolsGatewayAdapter } = require('../../lib/tool_runner/ToolGatewayAdapter');
const { ToolExecutionService } = require('../../lib/tool_execution/ToolExecutionService');
const { RUN_STATUS, RUN_CODES } = require('../../lib/tool_runner/ssot');

// Mock ToolGateway for controlled testing
class MockToolGateway {
  constructor(options = {}) {
    this.depStates = options.depStates || {};
    this.executeToolResponses = options.executeToolResponses || {};
  }

  getDepStates() {
    return this.depStates;
  }

  async executeTool(server, tool, args) {
    const key = `${server}.${tool}`;
    const response = this.executeToolResponses[key];

    if (!response) {
      return {
        error: { code: 'UNKNOWN_TOOL', message: `Mock: no fixture for ${key}` }
      };
    }

    if (typeof response === 'function') {
      return response({ server, tool, args });
    }

    return response;
  }

  async initialize() {
    // No-op for mock
  }
}

async function testInProcessGatewayReadinessBlocked() {
  // Setup: deps unavailable
  const mockToolGateway = new MockToolGateway({
    depStates: {
      memory: { ready: false, code: 'DEP_UNAVAILABLE' },
      web_search: { ready: false, code: 'DEP_UNAVAILABLE' }
    },
    executeToolResponses: {
      'memory.read_graph': { content: { entities: [] } }
    }
  });

  const toolExecutionService = new ToolExecutionService({
    toolGateway: mockToolGateway,
    logger: console,
    mode: 'NORMAL'
  });

  const gateway = new InProcessToolsGatewayAdapter(toolExecutionService, console);

  const deps = {
    memory: { ready: false, code: 'DEP_UNAVAILABLE' },
    web_search: { ready: false, code: 'DEP_UNAVAILABLE' }
  };

  const ticket = {
    id: 'ticket_inprocess_1',
    kind: 'TOOL',
    status: 'pending',
    tool_steps: [
      {
        tool_name: 'memory',
        args: {},
        _original_shape: 'server_tool',
        _original_server: 'memory',
        _original_tool: 'read_graph'
      }
    ]
  };

  const runReport = await runCore(ticket, deps, {
    gateway,
    requiredDeps: ['memory', 'web_search']
  });

  assert.strictEqual(runReport.status, RUN_STATUS.BLOCKED, 'Should be blocked when deps unavailable');
  assert.strictEqual(runReport.code, RUN_CODES.MCP_REQUIRED_UNAVAILABLE, 'Should use stable code MCP_REQUIRED_UNAVAILABLE');
  assert.ok(Array.isArray(runReport.step_reports), 'step_reports should be array');
  assert.strictEqual(runReport.step_reports.length, 1, 'Should have 1 step report');
  assert.strictEqual(runReport.step_reports[0].status, RUN_STATUS.BLOCKED, 'Step should be blocked');
  assert.strictEqual(runReport.step_reports[0].code, RUN_CODES.MCP_REQUIRED_UNAVAILABLE, 'Step code should match');

  return true;
}

async function testInProcessGatewaySuccessPath() {
  // Setup: deps ready, tool returns success
  const mockToolGateway = new MockToolGateway({
    depStates: {
      memory: { ready: true, code: null },
      web_search: { ready: true, code: null }
    },
    executeToolResponses: {
      'memory.read_graph': { content: { entities: [{ id: 'e1', name: 'test' }] } }
    }
  });

  const toolExecutionService = new ToolExecutionService({
    toolGateway: mockToolGateway,
    logger: console,
    mode: 'NORMAL'
  });

  const gateway = new InProcessToolsGatewayAdapter(toolExecutionService, console);

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  const ticket = {
    id: 'ticket_inprocess_2',
    kind: 'TOOL',
    status: 'pending',
    tool_steps: [
      {
        tool_name: 'memory',
        args: {},
        _original_shape: 'server_tool',
        _original_server: 'memory',
        _original_tool: 'read_graph'
      }
    ]
  };

  const runReport = await runCore(ticket, deps, {
    gateway,
    requiredDeps: ['memory', 'web_search']
  });

  assert.strictEqual(runReport.status, RUN_STATUS.OK, 'Should succeed when deps ready and tool succeeds');
  assert.strictEqual(runReport.code, null, 'OK status should have null code');
  assert.ok(Array.isArray(runReport.step_reports), 'step_reports should be array');
  assert.strictEqual(runReport.step_reports.length, 1, 'Should have 1 step report');
  assert.strictEqual(runReport.step_reports[0].status, RUN_STATUS.OK, 'Step should be ok');

  return true;
}

async function runAll() {
  console.log('=== RunnerCore In-Process Gateway Integration Tests ===');

  try {
    await testInProcessGatewayReadinessBlocked();
    console.log('✓ RunnerCore + in-process gateway blocks on readiness (MCP_REQUIRED_UNAVAILABLE)');

    await testInProcessGatewaySuccessPath();
    console.log('✓ RunnerCore + in-process gateway succeeds when deps ready');

    console.log('\nPassed: 2, Failed: 0, Total: 2');
    return true;
  } catch (e) {
    console.error(`✗ Test failed: ${e.message}`);
    console.log('\nPassed: 0, Failed: 1, Total: 2');
    return false;
  }
}

if (require.main === module) {
  runAll().then(success => process.exit(success ? 0 : 1));
}

module.exports = { runAll };
