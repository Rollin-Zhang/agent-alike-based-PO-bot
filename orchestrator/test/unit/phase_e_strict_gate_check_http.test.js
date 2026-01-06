/**
 * Phase E: Level 2 process-level behavior proof (HTTP)
 *
 * Contract:
 * - CANONICAL_MISSING_FORCE=1 (test-only, server-side) must deterministically block strict gate.
 * - STRICT_GATE_FORCE=on (test-only, client-side strict_gate_check process) must deterministically allow.
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const { startServerWithEnv } = require('./helpers/server');

const ORCHESTRATOR_ROOT = path.resolve(__dirname, '..', '..');
const STRICT_GATE_CHECK_PATH = path.join(ORCHESTRATOR_ROOT, 'scripts', 'strict_gate_check.js');

function runStrictGateCheck({ env, args = [] } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('node', [STRICT_GATE_CHECK_PATH, '--json', ...args], {
      cwd: ORCHESTRATOR_ROOT,
      env: env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // Best-effort: tolerate extra logs by extracting the first JSON object.
        const s = String(stdout || '');
        const i = s.indexOf('{');
        const j = s.lastIndexOf('}');
        if (i >= 0 && j > i) {
          try {
            parsed = JSON.parse(s.slice(i, j + 1));
          } catch {
            // ignore
          }
        }
      }

      resolve({ code, stdout, stderr, parsed });
    });
  });
}

async function testPhaseEStrictGateCheckHttp() {
  console.log('[Test] testPhaseEStrictGateCheckHttp: START');

  // Server-side deterministic metric injection
  const serverEnvOverrides = {
    NODE_ENV: 'test',
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    TOOL_ONLY_MODE: 'false',
    ENABLE_TICKET_SCHEMA_VALIDATION: 'true',
    CANONICAL_MISSING_FORCE: '1'
  };

  const { stop, port } = await startServerWithEnv(serverEnvOverrides);

  try {
    // Case A: no strict override => must BLOCK (exit 1)
    {
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        ORCHESTRATOR_PORT: String(port)
      };

      const r = await runStrictGateCheck({ env });
      assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}. stderr=${r.stderr}`);
      assert.ok(
        r.parsed && typeof r.parsed === 'object',
        `expected --json output. stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`
      );
      assert.strictEqual(r.parsed.ok, false);
      assert.ok(Array.isArray(r.parsed.reasons));
      assert.ok(r.parsed.reasons.includes('canonical_missing_nonzero'));
    }

    // Case B: STRICT_GATE_FORCE=on => must ALLOW (exit 0)
    {
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        ORCHESTRATOR_PORT: String(port),
        STRICT_GATE_FORCE: 'on'
      };

      const r = await runStrictGateCheck({ env });
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}. stderr=${r.stderr}`);
      assert.ok(
        r.parsed && typeof r.parsed === 'object',
        `expected --json output. stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`
      );
      assert.strictEqual(r.parsed.ok, true);
      assert.ok(Array.isArray(r.parsed.reasons));
      assert.ok(r.parsed.reasons.includes('forced_on'));
      assert.ok(r.parsed.reasons.includes('canonical_missing_nonzero'));
    }
  } finally {
    await stop();
  }

  console.log('[Test] testPhaseEStrictGateCheckHttp: PASS ✓');
  return true;
}

module.exports = {
  testPhaseEStrictGateCheckHttp
};
