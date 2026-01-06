#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { startServerWithEnv } = require('../test/unit/helpers/server');
const { runWithV1: runRunnerCoreWithV1 } = require('../lib/tool_runner/RunnerCore');
const { HttpToolsExecuteGatewayAdapter } = require('../lib/tool_runner/ToolGatewayAdapter');
const { bridgeToolSteps } = require('../lib/tool_runner/b_script_bridge');
const { depsForToolName } = require('../lib/readiness/ssot');
const { mapRunReportStatusToVerdict } = require('../lib/tool_runner/b_script_executor_ssot');
const { buildModeSnapshotFromHttp } = require('../lib/run_report/modeSnapshot');
const { writeRunReportV1 } = require('../lib/run_report/writeRunReportV1');

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

async function waitFor(predicateFn, { timeoutMs, intervalMs, label }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicateFn();
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timeout_waiting_for:${label}`);
}

async function waitForTicketTerminal(baseUrl, ticketId, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  return waitFor(async () => {
    const t = await httpJson(baseUrl, 'GET', `/v1/tickets/${ticketId}`);
    if (!t.ok) return null;
    const status = String(t.body?.status || '');
    if (status === 'done' || status === 'failed' || status === 'blocked') return t;
    return null;
  }, { timeoutMs, intervalMs, label: `ticket_terminal:${ticketId}` });
}

async function leaseToolTicket(baseUrl, expectedTicketId, { limit = 10, leaseSec = 300 } = {}) {
  return waitFor(async () => {
    const leaseResp = await httpJson(baseUrl, 'POST', '/v1/tickets/lease', {
      kind: 'TOOL',
      limit,
      lease_sec: leaseSec
    });

    if (!leaseResp.ok) return null;
    const tickets = Array.isArray(leaseResp.body?.tickets) ? leaseResp.body.tickets : [];
    if (tickets.length === 0) return null;

    const leased = expectedTicketId
      ? tickets.find((t) => String(t.id || t.ticket_id) === String(expectedTicketId))
      : tickets[0];

    return leased || null;
  }, { timeoutMs: 20000, intervalMs: 500, label: `lease_tool_ticket:${expectedTicketId || 'any'}` });
}

async function main() {
  const startedAt = nowIso();
  const runId = `phaseB2_${Date.now().toString(36)}`;

  const orchestratorRoot = path.resolve(__dirname, '..');
  const outRoot = path.join(orchestratorRoot, 'out', 'e2e_runs');
  const dateDir = new Date().toISOString().slice(0, 10);
  const runDir = path.join(outRoot, dateDir, 'phaseB2', runId);
  ensureDir(runDir);

  // Use a minimal MCP config for B2 to avoid NotebookLM auth side effects.
  const baseMcpConfigPath = path.join(orchestratorRoot, 'mcp_config.json');
  const baseMcpConfig = JSON.parse(fs.readFileSync(baseMcpConfigPath, 'utf8'));
  const minimalMcpConfig = {
    mcp_servers: {
      memory: baseMcpConfig?.mcp_servers?.memory,
      web_search: baseMcpConfig?.mcp_servers?.web_search
    },
    tool_whitelist: [
      ...((baseMcpConfig?.mcp_servers?.memory?.tools) || []),
      ...((baseMcpConfig?.mcp_servers?.web_search?.tools) || [])
    ]
  };

  const mcpConfigForRunPath = path.join(runDir, 'mcp_config_b2.json');
  writeJson(mcpConfigForRunPath, minimalMcpConfig);

  const artifacts = {};
  let exitCode = 0;

  let lastHealthBody = null;
  let lastMetricsBody = null;

  const env = {
    ...process.env,
    NO_MCP: 'false',
    RUN_REAL_MCP_TESTS: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'false',
    MCP_CONFIG_PATH: mcpConfigForRunPath
  };

  const { baseUrl, stop, logsBuffer, port } = await startServerWithEnv(env);
  const serverEnv = { ...env, ORCHESTRATOR_PORT: String(port) };

  const ids = {
    triage_ticket_id: null,
    tool_ticket_id: null,
    reply_ticket_id: null
  };

  try {
    const health = await httpJson(baseUrl, 'GET', '/health');
    writeJson(path.join(runDir, 'health.json'), health);
    artifacts.health = 'health.json';
    lastHealthBody = health.body && typeof health.body === 'object' ? health.body : null;

    const depsSnapshot = {
      ...(health.body?.required || {}),
      ...(health.body?.optional || {})
    };

    const metricsBefore = await httpJson(baseUrl, 'GET', '/metrics');
    writeJson(path.join(runDir, 'metrics_before.json'), metricsBefore);
    artifacts.metrics_before = 'metrics_before.json';
    lastMetricsBody = metricsBefore.body && typeof metricsBefore.body === 'object' ? metricsBefore.body : null;

    // Trigger event
    const eventId = `phaseB2-${Date.now()}`;
    const event = {
      type: 'thread_post',
      source: 'e2e_phaseB2',
      event_id: eventId,
      content: 'Phase B2: trigger tool pipeline (memory.search_nodes) from TRIAGE approve',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    writeJson(path.join(runDir, 'event.json'), event);
    artifacts.event = 'event.json';

    const eventResp = await httpJson(baseUrl, 'POST', '/events', event);
    writeJson(path.join(runDir, 'event_response.json'), eventResp);
    artifacts.event_response = 'event_response.json';

    if (!eventResp.ok || !eventResp.body?.ticket_id) {
      exitCode = 2;
      throw new Error(`event_submit_failed:${eventResp.status}`);
    }

    const triageId = String(eventResp.body.ticket_id);
    ids.triage_ticket_id = triageId;

    // Fill TRIAGE deterministically (acts like a worker)
    const fillBody = {
      outputs: {
        decision: 'APPROVE',
        short_reason: 'Phase B2 deterministic triage fill to trigger tool pipeline',
        reply_strategy: 'standard',
        target_prompt_id: 'reply.standard'
      },
      by: 'http_fill'
    };

    writeJson(path.join(runDir, 'triage_fill_request.json'), fillBody);
    artifacts.triage_fill_request = 'triage_fill_request.json';

    const fillResp = await httpJson(baseUrl, 'POST', `/v1/tickets/${triageId}/fill`, fillBody);
    writeJson(path.join(runDir, 'triage_fill_response.json'), fillResp);
    artifacts.triage_fill_response = 'triage_fill_response.json';

    if (!fillResp.ok) {
      exitCode = 2;
      throw new Error(`triage_fill_failed:${fillResp.status}`);
    }

    // Wait for TRIAGE to be done and derive tool_ticket_id
    const triageFinal = await waitForTicketTerminal(baseUrl, triageId, { timeoutMs: 20000, intervalMs: 500 });
    writeJson(path.join(runDir, 'triage_ticket_terminal.json'), triageFinal);
    artifacts.triage_ticket_terminal = 'triage_ticket_terminal.json';

    const toolTicketId = triageFinal.body?.derived?.tool_ticket_id;
    if (!toolTicketId) {
      exitCode = 2;
      throw new Error('missing_tool_ticket_id_after_triage');
    }

    ids.tool_ticket_id = String(toolTicketId);

    // Capture tool ticket before runner
    const toolBefore = await httpJson(baseUrl, 'GET', `/v1/tickets/${ids.tool_ticket_id}`);
    writeJson(path.join(runDir, 'tool_ticket_before_runner.json'), toolBefore);
    artifacts.tool_ticket_before_runner = 'tool_ticket_before_runner.json';

    // Lease the TOOL ticket from orchestrator (shared in-memory store)
    const leasedTool = await leaseToolTicket(baseUrl, ids.tool_ticket_id, { limit: 10, leaseSec: 300 });
    writeJson(path.join(runDir, 'tool_ticket_leased.json'), leasedTool);
    artifacts.tool_ticket_leased = 'tool_ticket_leased.json';

    // Execute tool_steps via RunnerCore (HTTP gateway to /v1/tools/execute)
    const gateway = new HttpToolsExecuteGatewayAdapter({ baseUrl, timeoutMs: 60000, logger: console });
    const bridgedTicket = bridgeToolSteps(leasedTool, { logger: console });

    const { runReport, runReportV1 } = await runRunnerCoreWithV1(bridgedTicket, depsSnapshot, {
      gateway,
      requiredDeps: depsForToolName,
      budget: { max_steps: 20, max_wall_ms: 120000 }
    });
    writeJson(path.join(runDir, 'runnercore_run_report.json'), runReport);
    artifacts.runnercore_run_report = 'runnercore_run_report.json';

    writeRunReportV1({
      filePath: path.join(runDir, 'run_report_v1.json'),
      reportV1: runReportV1,
      mode_snapshot: buildModeSnapshotFromHttp({
        env: serverEnv,
        healthBody: lastHealthBody,
        metricsBody: lastMetricsBody
      })
    });
    artifacts.run_report_v1 = 'run_report_v1.json';

    const outputs = {
      tool_context: { evidence: runReport.evidence_summary?.items || [] },
      tool_verdict: mapRunReportStatusToVerdict(runReport.status)
    };

    writeJson(path.join(runDir, 'tool_fill_request.json'), {
      outputs,
      by: 'system',
      lease_owner: leasedTool?.metadata?.lease_owner,
      lease_token: leasedTool?.metadata?.lease_token
    });
    artifacts.tool_fill_request = 'tool_fill_request.json';

    const fillToolResp = await httpJson(baseUrl, 'POST', `/v1/tickets/${ids.tool_ticket_id}/fill`, {
      outputs,
      by: 'system',
      lease_owner: leasedTool?.metadata?.lease_owner,
      lease_token: leasedTool?.metadata?.lease_token
    });
    writeJson(path.join(runDir, 'tool_fill_response.json'), fillToolResp);
    artifacts.tool_fill_response = 'tool_fill_response.json';

    const toolFinal = await waitForTicketTerminal(baseUrl, ids.tool_ticket_id, { timeoutMs: 30000, intervalMs: 500 });
    writeJson(path.join(runDir, 'tool_ticket_terminal.json'), toolFinal);
    artifacts.tool_ticket_terminal = 'tool_ticket_terminal.json';

    // Optional: derive reply ticket may have been created by tool runner
    const listAll = await httpJson(baseUrl, 'GET', '/v1/tickets?limit=10000');
    writeJson(path.join(runDir, 'tickets_list_snapshot.json'), listAll);
    artifacts.tickets_list_snapshot = 'tickets_list_snapshot.json';

    const list = Array.isArray(listAll.body) ? listAll.body : [];
    const reply = list.find((t) => t?.metadata?.kind === 'REPLY' && t?.metadata?.triage_reference_id === triageId);
    if (reply?.id) {
      ids.reply_ticket_id = String(reply.id);
      const replyFinal = await httpJson(baseUrl, 'GET', `/v1/tickets/${ids.reply_ticket_id}`);
      writeJson(path.join(runDir, 'reply_ticket.json'), replyFinal);
      artifacts.reply_ticket = 'reply_ticket.json';
    }

    const metricsAfter = await httpJson(baseUrl, 'GET', '/metrics');
    writeJson(path.join(runDir, 'metrics_after.json'), metricsAfter);
    artifacts.metrics_after = 'metrics_after.json';
    lastMetricsBody = metricsAfter.body && typeof metricsAfter.body === 'object' ? metricsAfter.body : lastMetricsBody;

    const countersBefore = metricsBefore.body?.readiness?.required_unavailable_total || {};
    const countersAfter = metricsAfter.body?.readiness?.required_unavailable_total || {};
    writeJson(path.join(runDir, 'metrics_readiness_delta.json'), {
      required_unavailable_total_delta: diffMetrics(countersBefore, countersAfter)
    });
    artifacts.metrics_readiness_delta = 'metrics_readiness_delta.json';

    // Summary / assertions
    const toolStatus = String(toolFinal.body?.status || '');
    const toolVerdict = toolFinal.body?.outputs?.tool_verdict || toolFinal.body?.metadata?.final_outputs?.tool_verdict || null;
    const toolSteps = toolBefore.body?.metadata?.tool_input?.tool_steps || toolBefore.body?.tool_steps || [];

    const ok = toolStatus === 'done' && (toolVerdict === 'PROCEED' || toolVerdict === 'BLOCK' || toolVerdict === 'SKIP' || toolVerdict === 'UNKNOWN');

    const summary = {
      phase: 'B2',
      run_id: runId,
      started_at: startedAt,
      finished_at: nowIso(),
      orchestrator: { baseUrl, port },
      ids,
      run_report_v1: {
        terminal_status: runReportV1?.terminal_status,
        primary_failure_code: runReportV1?.primary_failure_code,
        path: artifacts.run_report_v1
      },
      tool_steps_summary: Array.isArray(toolSteps)
        ? toolSteps.map((s) => ({ server: s.server, tool: s.tool, args_keys: Object.keys(s.args || {}) }))
        : [],
      tool_verdict: toolVerdict,
      tool_status: toolStatus,
      ok,
      artifacts
    };

    writeJson(path.join(runDir, 'summary.json'), summary);
    artifacts.summary = 'summary.json';

    console.log(JSON.stringify(summary, null, 2));

    if (!ok) {
      process.exit(exitCode || 2);
    }

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const failure = {
      phase: 'B2',
      run_id: runId,
      started_at: startedAt,
      finished_at: nowIso(),
      orchestrator: { baseUrl, port },
      ids,
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
