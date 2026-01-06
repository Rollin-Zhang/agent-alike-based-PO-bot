#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { startServerWithEnv } = require('../test/unit/helpers/server');
const { RUN_STATUS } = require('../lib/tool_runner/ssot');
const {
  createRunReportV1,
  appendAttemptEvent,
  ATTEMPT_EVENT_TYPES_V1
} = require('../lib/run_report/createRunReportV1');
const { createStepReportV1 } = require('../lib/run_report/createStepReportV1');
const { mapToStableCode } = require('../lib/run_report/stable_codes');

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: text };
  }
}

async function httpJson(baseUrl, method, pathName, body) {
  const url = new URL(pathName, baseUrl).toString();
  const res = await axios.request({
    method,
    url,
    data: body,
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
    validateStatus: () => true,
    transformResponse: (x) => x
  });

  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  const parsed = safeJsonParse(text);
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: res.headers || {},
    body: parsed.value
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function diffMetrics(before, after) {
  const out = {};
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {})
  ]);

  for (const key of keys) {
    const b = before ? before[key] : undefined;
    const a = after ? after[key] : undefined;

    if (typeof b === 'number' && typeof a === 'number') {
      out[key] = a - b;
    }
  }

  return out;
}

async function waitForRequiredReady(baseUrl, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await httpJson(baseUrl, 'GET', '/health');
    if (health.ok && health.body && typeof health.body === 'object') {
      const req = health.body.required || {};
      const memOk = Boolean(req.memory?.ready);
      const webOk = Boolean(req.web_search?.ready);
      if (memOk && webOk) {
        return health;
      }
    }
    await sleep(intervalMs);
  }
  throw new Error('timeout_waiting_for_required_deps_ready');
}

async function main() {
  const startedAt = nowIso();
  const runId = `phaseB1_${Date.now().toString(36)}`;

  const repoRoot = path.resolve(__dirname, '..');
  const outRoot = path.join(repoRoot, 'out', 'e2e_runs');
  const dateDir = new Date().toISOString().slice(0, 10);
  const runDir = path.join(outRoot, dateDir, 'phaseB1', runId);
  ensureDir(runDir);

  const artifacts = {};
  let exitCode = 0;

  const envOverrides = {
    NO_MCP: 'false',
    RUN_REAL_MCP_TESTS: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true',
    // Ensure Orchestrator uses the same config path tests use
    MCP_CONFIG_PATH: path.join(repoRoot, 'mcp_config.json')
  };

  const { baseUrl, stop, logsBuffer, port } = await startServerWithEnv(envOverrides);

  try {
    const metricsBefore = await httpJson(baseUrl, 'GET', '/metrics');
    writeJson(path.join(runDir, 'metrics_before.json'), metricsBefore);
    artifacts.metrics_before = 'metrics_before.json';

    // Wait for required deps ready
    const healthReady = await waitForRequiredReady(baseUrl);
    writeJson(path.join(runDir, 'health_ready.json'), healthReady);
    artifacts.health_ready = 'health_ready.json';

    // Tool execute (B1): call memory server via HTTP /v1/tools/execute
    // Note: /v1/tools/execute gating is conservative; required deps must be ready.
    const toolExecuteRequest = {
      server: 'memory',
      tool: 'search_nodes',
      arguments: {
        query: 'phaseB1 readiness proof'
      }
    };

    writeJson(path.join(runDir, 'tools_execute_request.json'), toolExecuteRequest);
    artifacts.tools_execute_request = 'tools_execute_request.json';

    const toolExecuteResponse = await httpJson(baseUrl, 'POST', '/v1/tools/execute', toolExecuteRequest);
    writeJson(path.join(runDir, 'tools_execute_response.json'), toolExecuteResponse);
    artifacts.tools_execute_response = 'tools_execute_response.json';

    if (!toolExecuteResponse.ok) {
      exitCode = 2;
      throw new Error(`tools_execute_failed:${toolExecuteResponse.status}`);
    }

    // Phase C: emit run_report_v1.json (append-only)
    const attemptEvents = [];
    const bag = { attempt_events: attemptEvents };

    appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.RUN_START, message: 'run_start' });
    appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.STEP_START, step_index: 1, tool_name: 'memory', message: 'step_start' });

    const stepStartedAt = startedAt;
    const stepEndedAt = nowIso();
    const stepReportV1 = createStepReportV1({
      step_index: 1,
      tool_name: 'memory',
      status: RUN_STATUS.OK,
      code: null,
      started_at: stepStartedAt,
      ended_at: stepEndedAt,
      duration_ms: 0,
      result_summary: 'tools_execute ok',
      evidence_items: []
    });

    appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.STEP_END, step_index: 1, tool_name: 'memory', status: RUN_STATUS.OK, code: null, message: 'step_end' });
    appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.RUN_END, status: RUN_STATUS.OK, code: null, message: 'run_end' });

    const runReportV1 = createRunReportV1({
      ticket_id: 'phaseB1_tools_execute',
      terminal_status: RUN_STATUS.OK,
      primary_failure_code: null,
      started_at: startedAt,
      ended_at: nowIso(),
      duration_ms: 0,
      step_reports: [stepReportV1],
      attempt_events: attemptEvents
    });

    writeJson(path.join(runDir, 'run_report_v1.json'), runReportV1);
    artifacts.run_report_v1 = 'run_report_v1.json';

    const metricsAfter = await httpJson(baseUrl, 'GET', '/metrics');
    writeJson(path.join(runDir, 'metrics_after.json'), metricsAfter);
    artifacts.metrics_after = 'metrics_after.json';

    const readinessBefore = metricsBefore.body?.readiness || {};
    const readinessAfter = metricsAfter.body?.readiness || {};
    const countersBefore = readinessBefore.required_unavailable_total || {};
    const countersAfter = readinessAfter.required_unavailable_total || {};

    writeJson(path.join(runDir, 'metrics_readiness_delta.json'), {
      required_unavailable_total_delta: diffMetrics(countersBefore, countersAfter)
    });
    artifacts.metrics_readiness_delta = 'metrics_readiness_delta.json';

    // Summary
    const summary = {
      phase: 'B1',
      run_id: runId,
      started_at: startedAt,
      finished_at: nowIso(),
      orchestrator: { baseUrl, port },
      run_report_v1: {
        terminal_status: runReportV1.terminal_status,
        primary_failure_code: runReportV1.primary_failure_code,
        path: artifacts.run_report_v1
      },
      checks: {
        required_deps_ready: true,
        tools_execute_ok: true
      },
      artifacts
    };

    writeJson(path.join(runDir, 'summary.json'), summary);
    artifacts.summary = 'summary.json';

    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Best-effort Phase C artifact on failure
    try {
      const code = mapToStableCode(err, { boundary: 'runner' });
      const attemptEvents = [];
      const bag = { attempt_events: attemptEvents };
      appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.RUN_START, message: 'run_start' });
      appendAttemptEvent(bag, { type: ATTEMPT_EVENT_TYPES_V1.RUN_END, status: RUN_STATUS.FAILED, code, message: 'run_end' });
      const runReportV1 = createRunReportV1({
        ticket_id: 'phaseB1_tools_execute',
        terminal_status: RUN_STATUS.FAILED,
        primary_failure_code: code,
        started_at: startedAt,
        ended_at: nowIso(),
        duration_ms: 0,
        step_reports: [],
        attempt_events: attemptEvents
      });
      writeJson(path.join(runDir, 'run_report_v1.json'), runReportV1);
      artifacts.run_report_v1 = 'run_report_v1.json';
    } catch {
      // ignore
    }

    const failure = {
      phase: 'B1',
      run_id: runId,
      started_at: startedAt,
      finished_at: nowIso(),
      orchestrator: { baseUrl, port },
      ok: false,
      error: errorMessage,
      artifacts
    };

    writeJson(path.join(runDir, 'failure.json'), failure);
    artifacts.failure = 'failure.json';

    console.error(JSON.stringify(failure, null, 2));
    process.exit(exitCode || 2);
  } finally {
    try {
      await stop();
    } catch {
      // ignore
    }

    // Persist server logs (best-effort)
    try {
      fs.writeFileSync(path.join(runDir, 'orchestrator_logs.txt'), logsBuffer.join(''), 'utf8');
    } catch {
      // ignore
    }
  }
}

main();
