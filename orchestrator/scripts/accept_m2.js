#!/usr/bin/env node
'use strict';

/**
 * accept_m2.js (M2)
 * One-click full M2 acceptance entrypoint.
 *
 * Runs (in order):
 *   A) accept:no_mcp
 *   B) accept:real_mcp
 *   C) strict gate check (best-effort; requires running server)
 *
 * Writes a machine-readable report to orchestrator/out/m2_acceptance_report.json
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function nowIso() {
  return new Date().toISOString();
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpmScript(orchestratorDir, scriptName, extraArgs, env, inheritStdio) {
  const args = ['run', scriptName];
  if (extraArgs && extraArgs.length > 0) args.push('--', ...extraArgs);

  const start = Date.now();
  const res = spawnSync(npmBin(), args, {
    cwd: orchestratorDir,
    env,
    stdio: inheritStdio ? 'inherit' : 'pipe',
    encoding: 'utf8'
  });
  const end = Date.now();

  return {
    ok: res.status === 0,
    exitCode: typeof res.status === 'number' ? res.status : null,
    duration_ms: end - start,
    error: res.error ? String(res.error.message || res.error) : null,
    stdout: inheritStdio ? null : res.stdout,
    stderr: inheritStdio ? null : res.stderr
  };
}

function tryStrictGateCheck(orchestratorDir, env) {
  const start = Date.now();
  const args = ['scripts/strict_gate_check.js', '--json'];

  const res = spawnSync(process.execPath, args, {
    cwd: orchestratorDir,
    env,
    stdio: 'pipe',
    encoding: 'utf8'
  });

  const end = Date.now();
  const exitCode = typeof res.status === 'number' ? res.status : null;

  const rawStdout = (res.stdout || '').trim();
  const rawStderr = (res.stderr || '').trim();

  let parsed = null;
  if (exitCode === 0 || exitCode === 1) {
    try {
      parsed = rawStdout ? JSON.parse(rawStdout) : null;
    } catch (e) {
      parsed = null;
    }
  }

  const isLikelyUnavailable =
    exitCode === 2 &&
    typeof rawStderr === 'string' &&
    (rawStderr.includes('fetch failed') || rawStderr.includes('unexpected status='));

  const status =
    exitCode === 0 ? 'allow' :
      exitCode === 1 ? 'blocked' :
        isLikelyUnavailable ? 'unavailable' :
          exitCode === 2 ? 'tool_error' :
            'unknown';

  return {
    ok: exitCode === 0,
    status,
    exitCode,
    duration_ms: end - start,
    decision: parsed,
    stderr: rawStderr || null,
    stdout_unparsed: parsed ? null : (rawStdout || null)
  };
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function main() {
  const orchestratorDir = path.resolve(__dirname, '..');
  const outPath = path.resolve(orchestratorDir, 'out/m2_acceptance_report.json');

  const baseEnv = { ...process.env };

  const report = {
    kind: 'm2_acceptance_report',
    generated_at: nowIso(),
    orchestrator_dir: orchestratorDir,
    steps: {
      accept_no_mcp: null,
      accept_real_mcp: null,
      strict_gate_check: null
    },
    overall: {
      pass: false,
      reasons: []
    }
  };

  console.log('[accept:m2] A) Running accept:no_mcp ...');
  report.steps.accept_no_mcp = runNpmScript(orchestratorDir, 'accept:no_mcp', [], baseEnv, true);

  console.log('[accept:m2] B) Running accept:real_mcp ...');
  report.steps.accept_real_mcp = runNpmScript(orchestratorDir, 'accept:real_mcp', [], baseEnv, true);

  console.log('[accept:m2] C) Running strict gate check (best-effort) ...');
  report.steps.strict_gate_check = tryStrictGateCheck(orchestratorDir, baseEnv);

  const aOk = !!report.steps.accept_no_mcp && report.steps.accept_no_mcp.ok;
  const bOk = !!report.steps.accept_real_mcp && report.steps.accept_real_mcp.ok;

  if (!aOk) report.overall.reasons.push('accept:no_mcp failed');
  if (!bOk) report.overall.reasons.push('accept:real_mcp failed');

  report.overall.pass = aOk && bOk;

  writeJson(outPath, report);

  const strictStatus = report.steps.strict_gate_check ? report.steps.strict_gate_check.status : 'unknown';
  console.log(`[accept:m2] Report written: ${outPath}`);
  console.log(`[accept:m2] Strict gate status: ${strictStatus}`);

  if (report.overall.pass) {
    console.log('[accept:m2] PASS');
    process.exit(0);
  }

  console.error(`[accept:m2] FAIL: ${report.overall.reasons.join('; ')}`);
  process.exit(1);
}

main();
