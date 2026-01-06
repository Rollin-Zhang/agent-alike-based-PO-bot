#!/usr/bin/env node
'use strict';

/**
 * strict_gate_check.js (M2-C.2)
 *
 * Fetches /metrics JSON from a running orchestrator and evaluates the
 * strict cutover readiness gate using SSOT logic in lib/compat/strictCutoverGate.
 *
 * Exit codes:
 *   0 - Gate ok (safe to enable strict/cleanup)
 *   1 - Gate not ok (do NOT enable)
 *   2 - Tool error (fetch/parse/shape)
 */

const axios = require('axios');
const { createCutoverPolicy } = require('../lib/compat/CutoverPolicy');
const { canEnableStrict } = require('../lib/compat/strictCutoverGate');

function parseArgs(argv) {
  const args = { url: null, timeoutMs: 5000, json: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') {
      args.url = argv[i + 1] || null;
      i++;
    } else if (a === '--timeout-ms') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) args.timeoutMs = Math.floor(n);
      i++;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  node orchestrator/scripts/strict_gate_check.js [--url <metricsUrl>] [--timeout-ms <ms>] [--json]',
    '',
    'Defaults:',
    '  --url        http://localhost:${ORCHESTRATOR_PORT||3000}/metrics',
    '  --timeout-ms 5000',
    '',
    'Examples:',
    '  node orchestrator/scripts/strict_gate_check.js',
    '  node orchestrator/scripts/strict_gate_check.js --url http://localhost:3000/metrics',
    '  node orchestrator/scripts/strict_gate_check.js --json'
  ].join('\n');
}

function defaultMetricsUrlFromEnv() {
  const port = process.env.ORCHESTRATOR_PORT || process.env.PORT || '3000';
  return `http://localhost:${port}/metrics`;
}

function normalizeMetricsUrl(inputUrl) {
  if (!inputUrl) return null;
  const u = String(inputUrl).trim();
  if (u === '') return null;
  return u;
}

function shapeError(msg) {
  const e = new Error(msg);
  e.code = 'SHAPE_ERROR';
  return e;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const url = normalizeMetricsUrl(args.url) || defaultMetricsUrlFromEnv();

  let resp;
  try {
    resp = await axios.get(url, { timeout: args.timeoutMs, responseType: 'json', validateStatus: () => true });
  } catch (e) {
    console.error(`[strict-gate] fetch failed url=${url}: ${e.message}`);
    process.exit(2);
  }

  if (resp.status !== 200) {
    console.error(`[strict-gate] unexpected status=${resp.status} url=${url}`);
    process.exit(2);
  }

  const json = resp.data;
  if (!json || typeof json !== 'object') throw shapeError('metrics body is not an object');
  if (!json.cutover || typeof json.cutover !== 'object') throw shapeError('metrics.cutover missing');
  if (!json.cutover.metrics || typeof json.cutover.metrics !== 'object') throw shapeError('metrics.cutover.metrics missing');
  if (!Array.isArray(json.cutover.metrics.counters)) throw shapeError('metrics.cutover.metrics.counters must be array');

  const nowMs = Date.now();
  const cutover_until_ms = json.cutover.cutover_until_ms ?? null;
  const env_source = json.cutover.env_source ?? null;

  const policy = createCutoverPolicy({
    cutover_until_ms: cutover_until_ms === null ? null : Number(cutover_until_ms),
    nowFn: () => nowMs
  });

  const result = canEnableStrict({
    nowMs,
    policy,
    metricsSnapshot: json.cutover.metrics
  });

  const out = {
    ok: result.ok,
    mode: result.mode,
    counts: result.counts,
    reasons: result.reasons,
    cutover_until_ms: policy.cutover_until_ms,
    env_source,
    now_ms: nowMs,
    metrics_url: url
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const status = out.ok ? 'OK' : 'BLOCKED';
    console.log(`[strict-gate] ${status} mode=${out.mode} cutover_until_ms=${out.cutover_until_ms || 'null'} env_source=${out.env_source || 'null'}`);
    console.log(`[strict-gate] counts canonical_missing=${out.counts.canonical_missing} cutover_violation=${out.counts.cutover_violation} legacy_read=${out.counts.legacy_read}`);
    if (!out.ok) {
      console.log(`[strict-gate] reasons: ${out.reasons.join(', ')}`);
    }
  }

  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => {
  const code = e && e.code ? String(e.code) : 'ERROR';
  console.error(`[strict-gate] ${code}: ${e.message}`);
  process.exit(2);
});
