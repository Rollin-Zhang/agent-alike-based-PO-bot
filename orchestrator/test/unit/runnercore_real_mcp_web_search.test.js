/**
 * RunnerCore Real MCP Integration Test - web_search (gated)
 *
 * Gate: RUN_REAL_MCP_TESTS=true
 *
 * Acceptance (minimal):
 * - status ok
 * - return shape is received by RunnerCore (we validate step result_summary shape markers)
 * - bytes do not leak into RunReport JSON (no blob/bytes payload)
 *
 * Notes:
 * - This test is intentionally NOT asserting specific search content.
 * - External network + provider variability => keep checks minimal.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run: runCore } = require('../../lib/tool_runner/RunnerCore');
const { InProcessToolsGatewayAdapter } = require('../../lib/tool_runner/ToolGatewayAdapter');
const { ToolExecutionService } = require('../../lib/tool_execution/ToolExecutionService');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { depsForToolName } = require('../../lib/readiness/ssot');

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

async function waitForAuditMatch({ logPath, predicate, timeoutMs = 2000 }) {
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

async function testRunnerCoreRealMcpWebSearchSummariesShape() {
  if (shouldSkip('testRunnerCoreRealMcpWebSearchSummariesShape')) return true;

  const prevSchemaGateMode = process.env.SCHEMA_GATE_MODE;
  const prevNoMcp = process.env.NO_MCP;

  process.env.SCHEMA_GATE_MODE = 'off';
  delete process.env.NO_MCP;

  const ToolGateway = require('../../tool_gateway/ToolGateway');

  // Build an explicit config with an absolute path so cwd doesn't matter.
  const repoRoot = path.resolve(__dirname, '../../..');
  const webSearchEntry = path.join(repoRoot, 'tools', 'web-search-mcp-main', 'dist', 'index.js');
  const webSearchNodeModules = path.join(repoRoot, 'tools', 'web-search-mcp-main', 'node_modules');

  assert.ok(fs.existsSync(webSearchEntry), `web_search MCP entry not found: ${webSearchEntry}`);
  assert.ok(
    fs.existsSync(webSearchNodeModules),
    'web_search MCP node_modules not found; run: cd tools/web-search-mcp-main && npm install'
  );

  // Isolate audit log per run to avoid cross-test pollution.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-web-search-runnercore-'));
  const auditFilePath = path.join(tmpDir, 'tool_audit.jsonl');
  const prevAuditPath = process.env.TOOL_AUDIT_PATH;
  process.env.TOOL_AUDIT_PATH = auditFilePath;

  const toolGateway = new ToolGateway(console, {
    mcp_servers: {
      web_search: {
        command: 'node',
        args: [webSearchEntry],
        transport: 'stdio',
        env: {
          MAX_CONTENT_LENGTH: '2000',
          DEFAULT_TIMEOUT: '6000',
          BROWSER_HEADLESS: 'true',
          MAX_BROWSERS: '1'
        },
        tools: ['get-web-search-summaries'],
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
    assert.strictEqual(deps.web_search?.ready, true, 'web_search provider should be ready after initialize()');

    const toolExecutionService = new ToolExecutionService({ toolGateway, logger: console, mode: 'NORMAL' });
    const gateway = new InProcessToolsGatewayAdapter(toolExecutionService, console);

    const ticket = {
      id: 'ticket_runnercore_real_mcp_web_search_1',
      kind: 'TOOL',
      status: 'pending',
      tool_steps: [
        {
          tool_name: 'web_search',
          args: { query: 'OpenAI', limit: 1 },
          _original_shape: 'server_tool',
          _original_server: 'web_search',
          _original_tool: 'get-web-search-summaries'
        }
      ]
    };

    const runReport = await runCore(ticket, deps, {
      gateway,
      requiredDeps: (toolName) => depsForToolName(toolName)
    });

    assert.strictEqual(runReport.status, RUN_STATUS.OK, 'Run should be OK');
    assert.strictEqual(runReport.step_reports.length, 1, 'Should have 1 step');
    assert.strictEqual(runReport.step_reports[0].status, RUN_STATUS.OK, 'Step should be OK');

    // Shape-only check: MCP tool returns { content: [ { type: 'text', text: '...' } ] }
    // RunnerCore stores only result_summary, so we check for markers.
    const summary = runReport.step_reports[0].result_summary;
    assert.ok(typeof summary === 'string' && summary.length > 0, 'result_summary should be non-empty');
    assert.ok(summary.includes('"type":"text"') || summary.includes('type'), 'result_summary should include text content shape marker');

    // Bytes/blob must not leak into RunReport JSON
    const reportText = JSON.stringify(runReport);
    assert.ok(!reportText.includes('evidence_bytes'), 'RunReport must not contain evidence_bytes');
    assert.ok(!reportText.includes('base64'), 'RunReport must not contain base64 blobs');

    const audit = await waitForAuditMatch({
      logPath: auditFilePath,
      predicate: (e) => e && e.server === 'web_search' && e.tool === 'get-web-search-summaries'
    });

    assert.ok(audit, 'Expected audit entry for web_search.get-web-search-summaries');

    console.log('[PASS] testRunnerCoreRealMcpWebSearchSummariesShape');
    return true;
  } finally {
    try {
      await toolGateway.shutdown();
    } catch {
      // ignore
    }

    if (prevAuditPath === undefined) delete process.env.TOOL_AUDIT_PATH;
    else process.env.TOOL_AUDIT_PATH = prevAuditPath;

    if (prevSchemaGateMode === undefined) delete process.env.SCHEMA_GATE_MODE;
    else process.env.SCHEMA_GATE_MODE = prevSchemaGateMode;

    if (prevNoMcp === undefined) delete process.env.NO_MCP;
    else process.env.NO_MCP = prevNoMcp;
  }
}

async function runAll() {
  console.log('=== RunnerCore Real MCP Tests (web_search) ===');

  try {
    await testRunnerCoreRealMcpWebSearchSummariesShape();
    console.log('✓ RunnerCore real MCP web_search: summaries shape (gated)');
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

module.exports = { runAll, testRunnerCoreRealMcpWebSearchSummariesShape };
