#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Joi = require('joi');
const { mapToCandidateLite } = require('./mappers/generic');

// 簡易審計：寫入 logs/ingest_audit.jsonl
function writeAudit(entry) {
  try {
    const p = path.resolve(process.cwd(), 'logs/ingest_audit.jsonl');
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(p, line);
  } catch (_) { /* ignore */ }
}

// CandidateLite Joi Schema（最小版）
const candidateLiteSchema = Joi.object({
  platform: Joi.string().required(),
  account: Joi.object({ handle: Joi.string().required() }).required(),
  seed: Joi.object({ type: Joi.string().required(), value: Joi.string().allow('').required() }).required(),
  features: Joi.object({
    lang: Joi.string().required(),
    author: Joi.string().allow(''),
    len: Joi.number().integer().min(0).required(),
    engagement: Joi.object({ likes: Joi.number().integer().min(0).required(), comments: Joi.number().integer().min(0).required() }).required(),
    posted_at_iso: Joi.string().isoDate().allow(null)
  }).required(),
  context_digest: Joi.object({
    target_snippet: Joi.string().allow('').required(),
    original_len: Joi.number().integer().min(0).required(),
    is_truncated: Joi.boolean().required()
  }).required(),
  submitted_at: Joi.string().isoDate().required(),
  candidate_id: Joi.string().required()
});

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const [k, v] = a.split('=');
    if (k.startsWith('--')) out[k.slice(2)] = v === undefined ? true : v;
  }
  return out;
}

async function readSource(opts) {
  if (opts.file) {
    const p = path.resolve(process.cwd(), opts.file);
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  }
  const finalUrl = opts.url || process.env.SOURCE_API_URL;
  if (finalUrl) {
    return await fetchWithRetry(finalUrl, {
      headers: buildSourceHeaders(opts),
      timeout: 20000,
      maxRetries: parseInt(process.env.SOURCE_MAX_RETRIES || '3', 10)
    });
  }
  throw new Error('Must provide --file or --url');
}

function buildSourceHeaders(opts) {
  const h = { 'Accept': 'application/json', 'User-Agent': 'POBot-Ingest/1.0' };
  const token = opts.source_token || process.env.SOURCE_BEARER_TOKEN;
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

async function fetchWithRetry(url, { headers, timeout, maxRetries }) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const res = await axios.get(url, { headers, timeout, validateStatus: () => true });
      const { status, data } = res;
      writeAudit({ phase: 'source_fetch', url, status, headers: res.headers });
      if (status === 200) return data;
      if (status === 429) {
        const ra = res.headers['retry-after'];
        const waitMs = ra ? (parseFloat(ra) * 1000) : backoffMs(attempt);
        await sleep(waitMs);
      } else if (status >= 500 && status < 600) {
        await sleep(backoffMs(attempt));
      } else {
        throw new Error(`Source HTTP ${status}`);
      }
    } catch (e) {
      writeAudit({ phase: 'source_error', url, error: e.message });
      if (attempt >= maxRetries) throw e;
      await sleep(backoffMs(attempt));
    }
    attempt++;
  }
  throw new Error('Source fetch failed after retries');
}

function backoffMs(attempt) {
  const base = 500 * (attempt + 1);
  const jitter = Math.floor(Math.random() * 200);
  return base + jitter;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postBatch(baseURL, payload, headers, mode, waitMs, retries = 2) {
  const url = `${baseURL}/v1/triage/batch?mode=${encodeURIComponent(mode||'sync')}&wait_ms=${waitMs||0}`;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await axios.post(url, payload, { headers, timeout: 20000 });
      writeAudit({ phase: 'triage_batch', status: res.status, count: payload.candidates?.length || 0 });
      return res.data;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status === 429 || (status >= 500 && status < 600)) {
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function main() {
  const args = parseArgs();
  const baseURL = args.base || process.env.ORCH_URL || 'http://127.0.0.1:3000';
  const mode = args.mode || 'sync';
  const waitMs = parseInt(args.wait_ms || '1200', 10);
  const bearer = process.env.TRIAGE_BEARER_TOKEN;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.REQUIRE_AUTH === 'true' && bearer) headers['Authorization'] = `Bearer ${bearer}`;

  const raw = await readSource(args);
  const arr = Array.isArray(raw) ? raw : (raw.items || raw.data || []);
  if (!Array.isArray(arr) || arr.length === 0) {
    console.error('No items to ingest');
    process.exit(2);
  }

  // map
  const candidates = [];
  for (const item of arr) {
    const cand = mapToCandidateLite(item);
    const { error } = candidateLiteSchema.validate(cand);
    if (error) {
      writeAudit({ phase: 'validate_drop', candidate_id: cand.candidate_id, error: error.message });
      continue; // 丟棄無效項目
    }
    candidates.push(cand);
  }
  const payload = { candidates, mode, wait_ms: waitMs };

  const result = await postBatch(baseURL, payload, headers, mode, waitMs);
  console.log(JSON.stringify(result, null, 2));

  // 導入後查詢回顧摘要
  try {
    const ids = (result.results || []).map(r => r.candidate_id).filter(Boolean);
    if (ids.length) {
      const url = `${baseURL}/v1/triage/results?ids=${encodeURIComponent(ids.join(','))}`;
      const r2 = await axios.get(url, { headers: headers['Authorization'] ? { Authorization: headers['Authorization'] } : undefined });
      const results = r2.data?.results || [];
      const agg = results.reduce((acc, r) => { acc[r.state] = (acc[r.state]||0)+1; return acc; }, {});
      writeAudit({ phase: 'results_summary', counts: agg, ids_count: ids.length });
      console.error('SUMMARY', agg);
    }
  } catch (e) {
    writeAudit({ phase: 'results_summary_error', error: e.message });
  }
}

main().catch(err => {
  console.error('INGEST_FAILED', err.response?.status, err.response?.data || err.message);
  process.exit(1);
});
