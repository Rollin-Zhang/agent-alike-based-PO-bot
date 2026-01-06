#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const axios = require('axios');

const { startServerWithEnv } = require('../test/unit/helpers/server');

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
    timeout: 8000,
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

async function waitFor(predicateFn, { timeoutMs, intervalMs, label }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicateFn();
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timeout_waiting_for:${label}`);
}

function isObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

function contractDrift(message, details) {
  const err = new Error(`contract_drift:${message}`);
  err.contract = { message, details };
  return err;
}

async function main() {
  const startedAt = nowIso();
  const runId = `phaseA_${Date.now().toString(36)}`;

  const repoRoot = path.resolve(__dirname, '..');
  const evidenceRoot = path.join(repoRoot, 'evidence_store');
  const dateDir = new Date().toISOString().slice(0, 10);
  const runDir = path.join(evidenceRoot, dateDir, 'phaseA', runId);
  ensureDir(runDir);

  const artifacts = {};
  const endpointObs = [];
  let exitCode = 0;

  const schemaPath = path.join(repoRoot, 'schemas', 'contract_observation.v1.0.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const envOverrides = {
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true'
  };

  const { baseUrl, stop, logsBuffer, port } = await startServerWithEnv(envOverrides);

  try {
    // --- /health ---
    const health = await httpJson(baseUrl, 'GET', '/health');
    endpointObs.push({
      name: 'health',
      method: 'GET',
      path: '/health',
      status: health.status,
      ok: health.ok,
      response_sample: isObject(health.body) ? {
        required: health.body.required,
        optional: health.body.optional,
        at: health.body.at
      } : health.body
    });
    writeJson(path.join(runDir, 'health.json'), health);
    artifacts.health = 'health.json';

    if (!health.ok) throw new Error(`health_failed:${health.status}`);
    if (!isObject(health.body) || !isObject(health.body.required) || !isObject(health.body.optional)) {
      throw contractDrift('health_shape', { sample: health.body });
    }

    // --- /metrics ---
    const metrics = await httpJson(baseUrl, 'GET', '/metrics');
    endpointObs.push({
      name: 'metrics',
      method: 'GET',
      path: '/metrics',
      status: metrics.status,
      ok: metrics.ok,
      response_sample: isObject(metrics.body)
        ? { tickets: metrics.body.tickets, readiness: metrics.body.readiness, cutover: metrics.body.cutover }
        : metrics.body
    });
    writeJson(path.join(runDir, 'metrics.json'), metrics);
    artifacts.metrics = 'metrics.json';

    if (!metrics.ok) throw new Error(`metrics_failed:${metrics.status}`);
    if (!isObject(metrics.body) || !isObject(metrics.body.tickets)) {
      throw contractDrift('metrics_shape', { sample: metrics.body });
    }
    for (const k of ['pending', 'running', 'done', 'failed', 'blocked']) {
      if (!Object.prototype.hasOwnProperty.call(metrics.body.tickets, k)) {
        throw contractDrift('metrics_tickets_keys', { missing: k, sample: metrics.body.tickets });
      }
    }

    // --- POST /events ---
    const triageEvent = {
      type: 'thread_post',
      source: 'phaseA-smoke',
      event_id: `phaseA-${Date.now()}`,
      content: 'Phase A smoke (TRIAGE→TOOL→REPLY) deterministic direct fill',
      features: { engagement: { likes: 100, comments: 50 } }
    };

    writeJson(path.join(runDir, 'event_request.json'), triageEvent);
    artifacts.event_request = 'event_request.json';

    const eventResp = await httpJson(baseUrl, 'POST', '/events', triageEvent);
    endpointObs.push({
      name: 'events',
      method: 'POST',
      path: '/events',
      status: eventResp.status,
      ok: eventResp.ok,
      request_sample: triageEvent,
      response_sample: eventResp.body
    });
    writeJson(path.join(runDir, 'event_response.json'), eventResp);
    artifacts.event_response = 'event_response.json';

    if (!eventResp.ok) throw new Error(`events_failed:${eventResp.status}`);
    const triageId = eventResp.body && eventResp.body.ticket_id;
    if (!triageId) throw contractDrift('events_response_missing_ticket_id', { sample: eventResp.body });

    // --- GET /v1/tickets/:id (triage) ---
    const triageTicket1 = await httpJson(baseUrl, 'GET', `/v1/tickets/${triageId}`);
    endpointObs.push({
      name: 'get_ticket',
      method: 'GET',
      path: '/v1/tickets/:id',
      status: triageTicket1.status,
      ok: triageTicket1.ok,
      response_sample: isObject(triageTicket1.body)
        ? { id: triageTicket1.body.id, status: triageTicket1.body.status, flow_id: triageTicket1.body.flow_id, metadata: triageTicket1.body.metadata }
        : triageTicket1.body
    });
    writeJson(path.join(runDir, 'triage_ticket_before_fill.json'), triageTicket1);
    artifacts.triage_ticket_before_fill = 'triage_ticket_before_fill.json';

    if (!triageTicket1.ok) throw new Error(`get_ticket_failed:${triageTicket1.status}`);
    if (!isObject(triageTicket1.body) || triageTicket1.body.id !== triageId) {
      throw contractDrift('get_ticket_shape', { sample: triageTicket1.body });
    }

    // --- POST /v1/tickets/:id/fill (triage) ---
    const triageOutputs = {
      decision: 'APPROVE',
      short_reason: 'Phase A deterministic direct fill',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    };
    const triageFillReq = { outputs: triageOutputs, by: 'http_fill' };
    writeJson(path.join(runDir, 'triage_fill_request.json'), triageFillReq);
    artifacts.triage_fill_request = 'triage_fill_request.json';

    const triageFillResp = await httpJson(baseUrl, 'POST', `/v1/tickets/${triageId}/fill`, triageFillReq);
    endpointObs.push({
      name: 'fill_ticket',
      method: 'POST',
      path: '/v1/tickets/:id/fill',
      status: triageFillResp.status,
      ok: triageFillResp.ok,
      request_sample: triageFillReq,
      response_sample: triageFillResp.body
    });
    writeJson(path.join(runDir, 'triage_fill_response.json'), triageFillResp);
    artifacts.triage_fill_response = 'triage_fill_response.json';

    if (!triageFillResp.ok) throw new Error(`fill_triage_failed:${triageFillResp.status}`);

    // --- Wait for TOOL ticket ---
    const toolTicket = await waitFor(async () => {
      const list = await httpJson(baseUrl, 'GET', '/v1/tickets?limit=10000');
      if (!list.ok || !Array.isArray(list.body)) return null;
      return list.body.find((t) => t?.metadata?.kind === 'TOOL' && t?.metadata?.parent_ticket_id === triageId) || null;
    }, { timeoutMs: 8000, intervalMs: 200, label: 'tool_ticket' });

    writeJson(path.join(runDir, 'tool_ticket.json'), toolTicket);
    artifacts.tool_ticket = 'tool_ticket.json';

    if (!toolTicket?.id) throw contractDrift('tool_ticket_missing_id', { sample: toolTicket });

    // --- POST /v1/tickets/:id/fill (tool) ---
    const toolOutputs = {
      tool_verdict: 'PROCEED',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    };
    const toolFillReq = { outputs: toolOutputs, by: 'http_fill' };
    writeJson(path.join(runDir, 'tool_fill_request.json'), toolFillReq);
    artifacts.tool_fill_request = 'tool_fill_request.json';

    const toolFillResp = await httpJson(baseUrl, 'POST', `/v1/tickets/${toolTicket.id}/fill`, toolFillReq);
    writeJson(path.join(runDir, 'tool_fill_response.json'), toolFillResp);
    artifacts.tool_fill_response = 'tool_fill_response.json';

    if (!toolFillResp.ok) throw new Error(`fill_tool_failed:${toolFillResp.status}`);

    // --- Wait for REPLY ticket ---
    const replyTicket = await waitFor(async () => {
      const list = await httpJson(baseUrl, 'GET', '/v1/tickets?limit=10000');
      if (!list.ok || !Array.isArray(list.body)) return null;
      return list.body.find((t) => t?.metadata?.kind === 'REPLY' && t?.metadata?.parent_ticket_id === toolTicket.id) || null;
    }, { timeoutMs: 8000, intervalMs: 200, label: 'reply_ticket' });

    writeJson(path.join(runDir, 'reply_ticket.json'), replyTicket);
    artifacts.reply_ticket = 'reply_ticket.json';

    // --- Final triage ticket snapshot ---
    const triageTicket2 = await httpJson(baseUrl, 'GET', `/v1/tickets/${triageId}`);
    writeJson(path.join(runDir, 'triage_ticket_after_fill.json'), triageTicket2);
    artifacts.triage_ticket_after_fill = 'triage_ticket_after_fill.json';

    if (!triageTicket2.ok) throw new Error(`get_ticket_after_fill_failed:${triageTicket2.status}`);
    if (!isObject(triageTicket2.body) || triageTicket2.body.status !== 'done') {
      throw contractDrift('triage_terminal_status', { expected: 'done', sample: triageTicket2.body });
    }
    const finalOutputs = triageTicket2.body?.metadata?.final_outputs;
    if (!isObject(finalOutputs) || finalOutputs.decision !== 'APPROVE') {
      throw contractDrift('triage_final_outputs', { expectedDecision: 'APPROVE', sample: finalOutputs });
    }

    // --- Contract observation ---
    const endedAt = nowIso();
    const observation = {
      schema_version: '1.0',
      phase: 'A',
      run_id: runId,
      started_at: startedAt,
      ended_at: endedAt,
      base_url: baseUrl,
      env: {
        NO_MCP: envOverrides.NO_MCP,
        ENABLE_TOOL_DERIVATION: envOverrides.ENABLE_TOOL_DERIVATION,
        ENABLE_REPLY_DERIVATION: envOverrides.ENABLE_REPLY_DERIVATION,
        ORCHESTRATOR_PORT: String(port)
      },
      endpoints: endpointObs,
      artifacts
    };

    if (!validate(observation)) {
      throw contractDrift('contract_observation_schema_invalid', { errors: validate.errors });
    }

    writeJson(path.join(runDir, 'contract_observation.json'), observation);
    artifacts.contract_observation = 'contract_observation.json';

    // --- Write server logs ---
    fs.writeFileSync(path.join(runDir, 'server.log'), String(logsBuffer.join('')), 'utf8');
    artifacts.server_log = 'server.log';

    const summary = {
      schema_version: '1.0',
      phase: 'A',
      run_id: runId,
      base_url: baseUrl,
      started_at: startedAt,
      ended_at: nowIso(),
      ok: true,
      exit_code: 0,
      evidence_dir: runDir
    };

    ensureDir(path.join(repoRoot, 'out'));
    writeJson(path.join(repoRoot, 'out', 'phaseA_smoke_report.json'), summary);

    writeJson(path.join(evidenceRoot, 'latest_phaseA.json'), {
      updated_at: nowIso(),
      run_id: runId,
      evidence_dir: runDir
    });

    console.log(`[phaseA] PASS run_id=${runId} evidence_dir=${runDir}`);
    process.exit(0);
  } catch (err) {
    const endedAt = nowIso();

    if (err && typeof err === 'object' && err.contract) {
      exitCode = 7;
      writeJson(path.join(runDir, 'contract_drift.json'), {
        schema_version: '1.0',
        phase: 'A',
        run_id: runId,
        started_at: startedAt,
        ended_at: endedAt,
        ok: false,
        exit_code: exitCode,
        error: String(err.message || err),
        contract: err.contract
      });
    } else {
      exitCode = 2;
      writeJson(path.join(runDir, 'run_error.json'), {
        schema_version: '1.0',
        phase: 'A',
        run_id: runId,
        started_at: startedAt,
        ended_at: endedAt,
        ok: false,
        exit_code: exitCode,
        error: String(err && err.message ? err.message : err)
      });
    }

    try {
      fs.writeFileSync(path.join(runDir, 'server.log'), String(logsBuffer.join('')), 'utf8');
    } catch {}

    try {
      ensureDir(path.join(repoRoot, 'out'));
      writeJson(path.join(repoRoot, 'out', 'phaseA_smoke_report.json'), {
        schema_version: '1.0',
        phase: 'A',
        run_id: runId,
        base_url: `http://localhost:${port}`,
        started_at: startedAt,
        ended_at: endedAt,
        ok: false,
        exit_code: exitCode,
        evidence_dir: runDir
      });
    } catch {}

    try {
      writeJson(path.join(evidenceRoot, 'latest_phaseA.json'), {
        updated_at: nowIso(),
        run_id: runId,
        evidence_dir: runDir
      });
    } catch {}

    console.error(`[phaseA] FAIL exit_code=${exitCode} error=${String(err && err.message ? err.message : err)}`);
    process.exit(exitCode);
  } finally {
    await stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
