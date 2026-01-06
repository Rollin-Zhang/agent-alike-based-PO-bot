/**
 * RunnerCore Real MCP Integration Test - memory (gated)
 *
 * Gate: RUN_REAL_MCP_TESTS=true
 *
 * Acceptance (minimal):
 * - Tool call succeeds (status ok)
 * - RunnerCore can receive and summarize the tool result
 * - Audit structure exists (ToolGateway writes tool_audit.jsonl)
 *
 * Notes:
 * - This test is intentionally shape/contract oriented (not content oriented)
 * - This test must be skippable by default to avoid flaky CI
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run: runCore } = require('../../lib/tool_runner/RunnerCore');
const { InProcessToolsGatewayAdapter } = require('../../lib/tool_runner/ToolGatewayAdapter');
const { ToolExecutionService } = require('../../lib/tool_execution/ToolExecutionService');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');

function shouldSkip(testName) {
  if (process.env.RUN_REAL_MCP_TESTS !== 'true') {
    console.log(`[SKIP] ${testName} (requires RUN_REAL_MCP_TESTS=true)`);
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForAuditMatch({ logPath, predicate, timeoutMs = 1500 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(logPath)) {
      const text = fs.readFileSync(logPath, 'utf8');
      const lines = text.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (predicate(obj)) return obj;
        } catch {
          // ignore
        }
      }
    }
    await sleep(50);
  }
  return null;
}

async function testRunnerCoreRealMcpMemorySetThenRead() {
  if (shouldSkip('testRunnerCoreRealMcpMemorySetThenRead')) return true;

  const prevSchemaGateMode = process.env.SCHEMA_GATE_MODE;
  const prevNoMcp = process.env.NO_MCP;

  // Keep schema gate non-blocking for real MCP wiring tests.
  process.env.SCHEMA_GATE_MODE = 'off';
  delete process.env.NO_MCP;

  const ToolGateway = require('../../tool_gateway/ToolGateway');

  // Use an isolated temp file for the memory server state.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-memory-runnercore-'));
  const memoryFilePath = path.join(tmpDir, 'graph.json');
  const auditFilePath = path.join(tmpDir, 'tool_audit.jsonl');

  const prevAuditPath = process.env.TOOL_AUDIT_PATH;
  process.env.TOOL_AUDIT_PATH = auditFilePath;

  const toolGateway = new ToolGateway(console, {
    mcp_servers: {
      memory: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory@2025.8.4'],
        transport: 'stdio',
        env: { MEMORY_FILE_PATH: memoryFilePath },
        tools: [
          'create_entities',
          'add_observations',
          'read_graph',
          'search_nodes',
          'open_nodes'
        ],
        timeout: 30
      }
    },
    tool_whitelist: []
  });

  try {
    await toolGateway.initialize();

    // Ensure audit file is clean for this run.
    fs.writeFileSync(auditFilePath, '');

    const deps = toolGateway.getDepStates();
    assert.strictEqual(deps.memory?.ready, true, 'memory provider should be ready after initialize()');

    const toolExecutionService = new ToolExecutionService({ toolGateway, logger: console, mode: 'NORMAL' });
    const gateway = new InProcessToolsGatewayAdapter(toolExecutionService, console);

    const uniqueName = `runnercore_real_mcp_${Date.now()}`;

    const ticket = {
      id: 'ticket_runnercore_real_mcp_memory_1',
      kind: 'TOOL',
      status: 'pending',
      tool_steps: [
        {
          tool_name: 'memory',
          args: {
            entities: [{ name: uniqueName, entityType: 'test', observations: ['created by real MCP test'] }]
          },
          _original_shape: 'server_tool',
          _original_server: 'memory',
          _original_tool: 'create_entities'
        },
        {
          tool_name: 'memory',
          args: { query: uniqueName },
          _original_shape: 'server_tool',
          _original_server: 'memory',
          _original_tool: 'search_nodes'
        }
      ]
    };

    const runReport = await runCore(ticket, deps, {
      gateway,
      requiredDeps: ['memory']
    });

    if (runReport.status !== RUN_STATUS.OK) {
      console.error('[DEBUG] RunReport (non-OK):', JSON.stringify(runReport, null, 2));
    }

    assert.strictEqual(runReport.status, RUN_STATUS.OK, 'Run should be OK');
    assert.ok(Array.isArray(runReport.step_reports), 'step_reports should be array');
    assert.strictEqual(runReport.step_reports.length, 2, 'Should have 2 step reports');
    assert.strictEqual(runReport.step_reports[0].status, RUN_STATUS.OK, 'Step1 should be OK');
    assert.strictEqual(runReport.step_reports[1].status, RUN_STATUS.OK, 'Step2 should be OK');
    assert.ok(typeof runReport.step_reports[1].result_summary === 'string' && runReport.step_reports[1].result_summary.length > 0, 'Step2 should have result_summary');

    const audit1 = await waitForAuditMatch({
      logPath: auditFilePath,
      predicate: (e) => e && e.server === 'memory' && e.tool === 'create_entities'
    });

    const audit2 = await waitForAuditMatch({
      logPath: auditFilePath,
      predicate: (e) => e && e.server === 'memory' && e.tool === 'search_nodes'
    });

    assert.ok(audit1, 'Expected audit entry for memory.create_entities');
    assert.ok(audit2, 'Expected audit entry for memory.search_nodes');

    console.log('[PASS] testRunnerCoreRealMcpMemorySetThenRead');
    return true;
  } finally {
    try {
      await toolGateway.shutdown();
    } catch {
      // ignore
    }

    if (prevAuditPath === undefined) delete process.env.TOOL_AUDIT_PATH;
    else process.env.TOOL_AUDIT_PATH = prevAuditPath;

    // Restore env
    if (prevSchemaGateMode === undefined) delete process.env.SCHEMA_GATE_MODE;
    else process.env.SCHEMA_GATE_MODE = prevSchemaGateMode;

    if (prevNoMcp === undefined) delete process.env.NO_MCP;
    else process.env.NO_MCP = prevNoMcp;
  }
}

async function runAll() {
  console.log('=== RunnerCore Real MCP Tests (memory) ===');

  try {
    await testRunnerCoreRealMcpMemorySetThenRead();
    console.log('✓ RunnerCore real MCP memory: set → read (gated)');
    console.log('\nPassed: 1, Failed: 0, Total: 1');
    return true;
  } catch (e) {
    console.error(`✗ Test failed: ${e.message}`);
    console.log('\nPassed: 0, Failed: 1, Total: 1');
    return false;
  }
}

if (require.main === module) {
  runAll().then(success => process.exit(success ? 0 : 1));
}

module.exports = { runAll, testRunnerCoreRealMcpMemorySetThenRead };
