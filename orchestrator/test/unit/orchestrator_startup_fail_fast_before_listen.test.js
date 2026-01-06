/**
 * Phase D Acceptance (A): Process-level fail-fast BEFORE listen
 *
 * Verifies:
 * - STRICT_PROBES=true + PROBE_FORCE_FAIL=<probe>
 * - starting orchestrator exits(1)
 * - startup_probe_report.v1.json is still written (best-effort)
 * - exit happens before the app starts listening
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function runOrchestratorOnce(env = {}) {
  return new Promise((resolve) => {
    const cwd = path.resolve(__dirname, '../..');
    const nodePath = process.execPath;

    const childEnv = {
      ...process.env,
      ...env
    };

    const child = spawn(nodePath, ['index.js'], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

describe('Phase D (A): Orchestrator process-level fail-fast', () => {
  jest.setTimeout(20000);

  it('exits(1) before listen and still writes startup_probe_report', async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logs-'));

    const { exitCode, stdout, stderr } = await runOrchestratorOnce({
      NO_MCP: 'true',
      STRICT_PROBES: 'true',
      PROBE_FORCE_FAIL: 'security',
      ORCHESTRATOR_PORT: '0',
      ENABLE_AUDIT_LOGS: 'false',
      LOGS_DIR: logsDir
    });

    try {
      assert.strictEqual(exitCode, 1);

      // Must not reach listen log
      const combined = `${stdout}\n${stderr}`;
      assert.ok(
        !combined.includes('Orchestrator running at http://localhost:'),
        'should exit before listen (no listen log)'
      );

      // Best-effort: artifacts written
      const startupProbesDir = path.join(logsDir, 'startup_probes');
      const runDirs = listDirs(startupProbesDir);
      assert.ok(runDirs.length >= 1, 'should create startup_probes/<run_id> directory');

      // Pick the newest dir by mtime
      const newest = runDirs
        .map((name) => {
          const full = path.join(startupProbesDir, name);
          return { name, mtimeMs: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].name;

      const runDir = path.join(startupProbesDir, newest);
      const reportPath = path.join(runDir, 'startup_probe_report.v1.json');
      const snapshotPath = path.join(runDir, 'dep_snapshot.v1.json');

      assert.ok(fs.existsSync(reportPath), 'startup_probe_report.v1.json should exist');
      assert.ok(fs.existsSync(snapshotPath), 'dep_snapshot.v1.json should exist');

      const report = readJson(reportPath);
      assert.strictEqual(report.version, 'v1');
      assert.strictEqual(report.mode, 'strict');
      assert.strictEqual(report.no_mcp, true);
      assert.strictEqual(report.strict_probes, true);
      assert.strictEqual(report.all_passed, false);
      assert.strictEqual(report.exit_code, 1);

      // Ensure at least one failed step (via StepReport fields)
      assert.ok(Array.isArray(report.step_reports) && report.step_reports.length > 0);
      const anyFailed = report.step_reports.some(
        (s) => (s.status === 'blocked' || s.status === 'failed') && s.code !== null
      );
      assert.strictEqual(anyFailed, true);
    } finally {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
