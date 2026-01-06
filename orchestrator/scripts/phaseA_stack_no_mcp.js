#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pollMetricsOk({ baseUrl, timeoutMs = 15000, intervalMs = 200 }) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout_waiting_for_metrics:${timeoutMs}ms`));
      }

      const req = http.get(`${baseUrl}/metrics`, (res) => {
        // Drain
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        setTimeout(tick, intervalMs);
      });

      req.on('error', () => setTimeout(tick, intervalMs));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(tick, intervalMs);
      });
    };

    tick();
  });
}

function spawnLogged(cmd, args, options) {
  const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  return child;
}

async function main() {
  const repoRoot = path.resolve(__dirname, '../..');
  const orchestratorCwd = path.join(repoRoot, 'orchestrator');
  const extensionCwd = path.join(repoRoot, 'vscode-extension');

  const port = process.env.ORCHESTRATOR_PORT || '3000';
  const baseUrl = `http://localhost:${port}`;

  let watchReady = false;
  let metricsReady = false;

  const childProcs = [];

  const stopAll = () => {
    for (const p of childProcs) {
      if (p && !p.killed) {
        try { p.kill('SIGTERM'); } catch {}
      }
    }
  };

  process.on('SIGINT', () => {
    stopAll();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopAll();
    process.exit(0);
  });

  // 1) Start orchestrator (NO_MCP)
  const orchEnv = {
    ...process.env,
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true',
    ORCHESTRATOR_PORT: port
  };

  const orch = spawnLogged('npm', ['run', 'start'], { cwd: orchestratorCwd, env: orchEnv });
  childProcs.push(orch);

  orch.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[phaseA_stack] orchestrator exited code=${code}`);
      process.exit(code);
    }
  });

  // 2) Compile once so Extension Host has up-to-date JS
  const compile = spawnLogged('npm', ['run', 'compile'], { cwd: extensionCwd, env: process.env });
  childProcs.push(compile);

  const compileCode = await new Promise((resolve) => compile.on('exit', resolve));
  if (compileCode !== 0) {
    console.error(`[phaseA_stack] extension compile failed code=${compileCode}`);
    process.exit(typeof compileCode === 'number' ? compileCode : 2);
  }

  // 3) Start watch (keeps running)
  const watch = spawnLogged('npm', ['run', 'watch'], { cwd: extensionCwd, env: process.env });
  childProcs.push(watch);

  watch.stdout.on('data', (d) => {
    const s = d.toString();
    if (s.includes('Watching for file changes') || s.includes('Found 0 errors. Watching')) {
      watchReady = true;
    }
  });

  watch.on('exit', (code) => {
    if (!code || code === 0) return;
    console.error(`[phaseA_stack] extension watch exited code=${code}`);
    process.exit(code);
  });

  // 4) Wait for orchestrator /metrics
  await pollMetricsOk({ baseUrl });
  metricsReady = true;

  // 5) If watch didn’t declare ready yet, wait a bit (non-fatal)
  const startWait = Date.now();
  while (!watchReady && Date.now() - startWait < 10000) {
    await sleep(100);
  }

  // Ready signal for VS Code background matcher
  if (metricsReady) {
    console.log('PHASEA_READY');
  }

  // Keep process alive as long as children run
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
