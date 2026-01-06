/**
 * Test A1: Probe Runner Force-Fail Exit Code
 * 
 * Phase A: Deterministic Safety Skeleton
 * 
 * Verifies that PROBE_FORCE_FAIL=<probe_name> triggers:
 * - exit code === 1
 * - report contains forced=true for the targeted probe
 * 
 * This test does NOT depend on real MCP, OS permissions, or error strings.
 */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const { validateEvidenceItem } = require('../../lib/evidence/ssot');

const PROBE_SCRIPT = path.resolve(__dirname, '../../scripts/run_probes.js');

/**
 * Spawns the probe runner and captures exit code + stdout.
 * @param {Object} env - Environment variables to pass
 * @returns {Promise<{exitCode: number, stdout: string, report: Object|null}>}
 */
function runProbeScript(env = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };

    // Guardrail: Phase A probe tests must not depend on real MCP wiring.
    // If the parent process enables RUN_REAL_MCP_TESTS, it can cause the probe runner
    // to emit non-JSON logs on stdout (breaking report parsing) and introduce flakiness.
    // IMPORTANT: Force NO_MCP=true even if parent env sets NO_MCP=false (e.g. real MCP acceptance).
    childEnv.NO_MCP = 'true';
    delete childEnv.RUN_REAL_MCP_TESTS;
    // Defensive: avoid accidental real MCP selection if the selection logic changes.
    delete childEnv.MCP_CONFIG_PATH;

    const child = spawn('node', [PROBE_SCRIPT], {
      env: childEnv,
      cwd: path.resolve(__dirname, '../../..')
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (exitCode) => {
      let report = null;
      try {
        report = JSON.parse(stdout);
      } catch (e) {
        // JSON parse failed, keep report as null
      }
      resolve({ exitCode, stdout, stderr, report });
    });
  });
}

/**
 * Test A1: PROBE_FORCE_FAIL=security triggers exit(1)
 * 
 * Phase A tests work without setting NO_MCP (defensive fallback to NoMcpProvider)
 */
async function testProbeForceFailExitCode() {
  console.log('[Test] testProbeForceFailExitCode: START');

  // Run with PROBE_FORCE_FAIL=security (no NO_MCP needed - fallback handles it)
  const { exitCode, report } = await runProbeScript({
    PROBE_FORCE_FAIL: 'security'
  });

  // Assert exit code is 1 (fail-fast)
  assert.strictEqual(exitCode, 1, `Expected exit code 1, got ${exitCode}`);
  console.log('[Test] Exit code === 1: PASS ✓');

  // Assert report structure
  assert.ok(report !== null, 'Report should be valid JSON');
  assert.strictEqual(report.allPassed, false, 'allPassed should be false');
  assert.strictEqual(report.exitCode, 1, 'report.exitCode should be 1');
  assert.strictEqual(report.forceFailName, 'security', 'forceFailName should be security');
  assert.ok(Array.isArray(report.evidence), 'report.evidence should be an array');
  console.log('[Test] Report structure: PASS ✓');

  // Find the security probe result
  const securityResult = report.results.find(r => r.name === 'security');
  assert.ok(securityResult, 'security probe result should exist');
  assert.strictEqual(securityResult.ok, false, 'security probe should fail');
  assert.strictEqual(securityResult.code, 'PROBE_FORCED_FAIL', 'code should be PROBE_FORCED_FAIL');
  assert.strictEqual(securityResult.forced, true, 'forced should be true');
  console.log('[Test] security probe forced=true, code=PROBE_FORCED_FAIL: PASS ✓');

  console.log('[Test] testProbeForceFailExitCode: PASS ✓');
  return true;
}

/**
 * Test A1b: Normal run (no force-fail) exits 0
 * 
 * Phase A tests work without setting NO_MCP (defensive fallback to NoMcpProvider)
 */
async function testProbeNormalRunExitZero() {
  console.log('[Test] testProbeNormalRunExitZero: START');

  // Run without any env vars (fallback to NoMcpProvider:fallback)
  const { exitCode, report } = await runProbeScript({});

  // Assert exit code is 0 (all pass)
  assert.strictEqual(exitCode, 0, `Expected exit code 0, got ${exitCode}`);
  console.log('[Test] Exit code === 0: PASS ✓');

  // Assert all probes passed
  assert.ok(report !== null, 'Report should be valid JSON');
  assert.strictEqual(report.allPassed, true, 'allPassed should be true');
  assert.strictEqual(report.exitCode, 0, 'report.exitCode should be 0');
  assert.ok(Array.isArray(report.evidence), 'report.evidence should be an array');
  console.log('[Test] All probes passed: PASS ✓');

  // Verify no forced failures
  const forcedResults = report.results.filter(r => r.forced === true);
  assert.strictEqual(forcedResults.length, 0, 'No probes should be forced');
  console.log('[Test] No forced failures: PASS ✓');

  console.log('[Test] testProbeNormalRunExitZero: PASS ✓');
  return true;
}

/**
 * M2-A.2 (minimal integration): evidence collection uses keep_first_n
 */
async function testProbeEvidenceKeepFirstN() {
  console.log('[Test] testProbeEvidenceKeepFirstN: START');

  const { exitCode, report } = await runProbeScript({
    EVIDENCE_MAX_ITEMS_PER_REPORT: '1'
  });

  assert.strictEqual(exitCode, 0, `Expected exit code 0, got ${exitCode}`);
  assert.ok(report !== null, 'Report should be valid JSON');
  assert.ok(Array.isArray(report.evidence), 'report.evidence should be an array');

  assert.strictEqual(report.evidence.length, 1, 'evidence should be truncated to first N items');
  assert.strictEqual(report.evidence_truncated, true, 'evidence_truncated should be true when evidence is dropped');
  assert.strictEqual(report.evidence_dropped_count, report.results.length - 1, 'evidence_dropped_count should reflect dropped items');
  const first = report.evidence[0];
  assert.ok(validateEvidenceItem(first), 'first evidence item must validate');
  assert.strictEqual(first.metadata.probe_name, 'security', 'keep_first_n should keep the first probe evidence');
  assert.strictEqual(first.kind, 'probe_log');
  assert.strictEqual(first.storage, 'inline');

  console.log('[Test] testProbeEvidenceKeepFirstN: PASS ✓');
  return true;
}

module.exports = {
  testProbeForceFailExitCode,
  testProbeNormalRunExitZero,
  testProbeEvidenceKeepFirstN
};
