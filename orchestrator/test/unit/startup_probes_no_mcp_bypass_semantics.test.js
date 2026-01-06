/**
 * Phase D Acceptance (B): NO_MCP bypass semantics are explicit
 *
 * Verifies (NO_MCP + STRICT_PROBES=false):
 * - report.mode === 'no_mcp_bypass'
 * - step_reports look "green" (status=ok, code=null) BUT contain attempt_event code PROBE_SKIPPED_NO_MCP
 *   so investigations can clearly see this was a degraded/bypass run.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshRequireOrchestrator() {
  const target = path.resolve(__dirname, '../..', 'index.js');
  delete require.cache[target];
  return require(target);
}

describe('Phase D (B): NO_MCP bypass semantics', () => {
  jest.setTimeout(20000);

  let originalEnv;
  let logsDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logs-'));

    process.env.NO_MCP = 'true';
    process.env.STRICT_PROBES = 'false';
    process.env.ENABLE_AUDIT_LOGS = 'false';
    process.env.LOGS_DIR = logsDir;
  });

  afterEach(() => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);

    if (logsDir) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      logsDir = null;
    }
  });

  it('marks bypass mode and appends PROBE_SKIPPED_NO_MCP attempt_event', async () => {
    const Orchestrator = freshRequireOrchestrator();
    const orch = new Orchestrator();

    const result = await orch.runStartupProbes({ bypass: true });

    assert.ok(result && result.report);
    assert.strictEqual(result.report.version, 'v1');
    assert.strictEqual(result.report.mode, 'no_mcp_bypass');
    assert.strictEqual(result.report.no_mcp, true);
    assert.strictEqual(result.report.strict_probes, false);

    assert.ok(Array.isArray(result.report.step_reports));
    assert.ok(result.report.step_reports.length > 0);

    // StepReports remain passable (HTTP-only start), but carry explicit degraded attempt_event
    for (const step of result.report.step_reports) {
      assert.strictEqual(step.status, 'ok');
      assert.strictEqual(step.code, null);

      assert.ok(Array.isArray(step.attempt_events), 'attempt_events should exist in bypass mode');
      assert.ok(step.attempt_events.length >= 1);
      const anyBypassEvent = step.attempt_events.some(
        (e) => e && e.code === 'PROBE_SKIPPED_NO_MCP'
      );
      assert.strictEqual(anyBypassEvent, true);
    }
  });
});
