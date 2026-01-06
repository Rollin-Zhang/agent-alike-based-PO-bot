'use strict';

const { ENV_KEYS } = require('../../shared/constants');
const { REQUIRED_DEPS } = require('../readiness/ssot');
const { createCutoverPolicy } = require('../compat/CutoverPolicy');
const { canEnableStrict } = require('../compat/strictCutoverGate');

function toBool(v) {
  return String(v) === 'true';
}

function resolvePlannedEnvFromEnv(env) {
  const e = env || {};
  return {
    NO_MCP: toBool(e.NO_MCP),
    enableToolDerivation: toBool(e[ENV_KEYS.ENABLE_TOOL_DERIVATION]),
    toolOnlyMode: toBool(e[ENV_KEYS.TOOL_ONLY_MODE]),
    enableTicketSchemaValidation: toBool(e[ENV_KEYS.ENABLE_TICKET_SCHEMA_VALIDATION])
  };
}

function summarizeReadiness({ healthBody, metricsBody } = {}) {
  const missing = [];
  const unavailable = [];

  const requiredKeys = REQUIRED_DEPS.map((d) => d.key);

  // Prefer /health snapshot for DepKey-level readiness.
  const required = healthBody && typeof healthBody === 'object' ? (healthBody.required || null) : null;

  if (required && typeof required === 'object') {
    for (const key of requiredKeys) {
      const dep = required[key];
      const ready = Boolean(dep && dep.ready);
      if (!ready) {
        missing.push(key);
        const code = dep && dep.code ? String(dep.code) : null;
        if (code === 'DEP_UNAVAILABLE') unavailable.push(key);
      }
    }
  }

  // If /health missing, fall back to /metrics readiness block.
  if (!required) {
    const readiness = metricsBody && typeof metricsBody === 'object' ? (metricsBody.readiness || null) : null;
    const required_ready = readiness && typeof readiness === 'object' ? (readiness.required_ready || null) : null;

    if (required_ready && typeof required_ready === 'object') {
      for (const key of requiredKeys) {
        const v = required_ready[key];
        const ready = Number(v) === 1;
        if (!ready) missing.push(key);
      }
    }
  }

  // Normalize low-cardinality output.
  const uniqMissing = Array.from(new Set(missing)).sort();
  const uniqUnavailable = Array.from(new Set(unavailable)).sort();

  const total_missing = uniqMissing.length;
  const missing_dep_codes = uniqMissing.slice(0, 10);

  const out = {
    deps_ready: total_missing === 0,
    missing_dep_codes,
    total_missing
  };

  if (uniqUnavailable.length > 0) {
    out.providers_unavailable = uniqUnavailable.slice(0, 10);
  }

  return out;
}

function normalizeCutoverMetrics(metrics) {
  // Expect cutoverMetrics.snapshot() shape.
  const m = metrics && typeof metrics === 'object' ? metrics : null;
  return {
    counters: Array.isArray(m?.counters) ? m.counters : [],
    counters_by_source: Array.isArray(m?.counters_by_source) ? m.counters_by_source : []
  };
}

function buildModeSnapshotFromHttp({ env, metricsBody, healthBody } = {}) {
  const as_of = new Date().toISOString();

  const plannedEnv = resolvePlannedEnvFromEnv(env);

  const cutoverBlock = metricsBody && typeof metricsBody === 'object' ? (metricsBody.cutover || null) : null;
  const cutover_until_ms = cutoverBlock && cutoverBlock.cutover_until_ms !== undefined ? cutoverBlock.cutover_until_ms : null;
  const env_source = cutoverBlock && cutoverBlock.env_source !== undefined ? cutoverBlock.env_source : null;
  const policy_mode = cutoverBlock && typeof cutoverBlock.mode === 'string'
    ? String(cutoverBlock.mode)
    : createCutoverPolicy({
      cutover_until_ms: cutover_until_ms === null ? null : Number(cutover_until_ms)
    }).mode(Date.now());

  const policy = createCutoverPolicy({
    cutover_until_ms: cutover_until_ms === null ? null : Number(cutover_until_ms)
  });

  const metricsSnapshot = normalizeCutoverMetrics(cutoverBlock ? cutoverBlock.metrics : null);
  const gate = canEnableStrict({
    nowMs: Date.now(),
    policy,
    metricsSnapshot,
    env
  });

  const readiness_summary = summarizeReadiness({ healthBody, metricsBody });

  return {
    as_of,
    env: plannedEnv,
    cutover: {
      cutover_until_ms: policy.cutover_until_ms,
      env_source: env_source === undefined ? null : env_source,
      policy_mode,
      metrics: metricsSnapshot,
      gate
    },
    readiness_summary
  };
}

module.exports = {
  buildModeSnapshotFromHttp,
  resolvePlannedEnvFromEnv,
  summarizeReadiness
};
