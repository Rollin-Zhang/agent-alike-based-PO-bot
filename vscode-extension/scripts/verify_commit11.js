// Commit 11 “一眼看穿”驗收腳本
// 目的：快速驗證 Evidence Aggregator v6 的關鍵不爆點
// - evidence 排序正確
// - truncated 行為正確
// - tool_trace 不會難以判讀（摘要 trace 有 summary:true）
// - 每筆 evidence 具備 source/snippet/relevance_score

const assert = (cond, msg) => {
  if (!cond) {
    throw new Error(msg);
  }
};

const { MAX_TOTAL_EVIDENCE_CHARS } = require('../out/shared/constants.js');
const { aggregateEvidence } = require('../out/adapters/aggregator.js');

const mkResult = (evidence, opts = {}) => ({
  evidence,
  ...(opts.error ? { error: opts.error } : {}),
  ...(opts.detail ? { detail: opts.detail } : {}),
  ...(opts.tool_trace ? { tool_trace: opts.tool_trace } : {})
});

const fsResult = mkResult([
  { source: 'fs:./docs/a.md', snippet: 'fs-snippet', relevance_score: 0.2 }
]);

const memResult = mkResult([
  { source: 'entity:Alice', snippet: 'memory-snippet', relevance_score: 0.5 }
]);

const webResult = mkResult([
  { source: 'web_search:1', snippet: 'web-snippet', relevance_score: 0.9, url: 'https://example.com' }
], {
  error: 'WEB_NO_RESULTS',
  detail: { reason: 'synthetic' },
  tool_trace: [
    { tool_name: 'get-web-search-summaries', error: 'WEB_NO_RESULTS', detail: { reason: 'synthetic' } }
  ]
});

const ctx = aggregateEvidence(fsResult, memResult, webResult);

console.log('=== Commit 11 verification ===');

// 1) evidence 三件套
for (const [i, e] of ctx.evidence.entries()) {
  assert(typeof e.source === 'string' && e.source.length > 0, `evidence[${i}].source missing`);
  assert(typeof e.snippet === 'string', `evidence[${i}].snippet missing`);
  assert(typeof e.relevance_score === 'number', `evidence[${i}].relevance_score missing`);
}
console.log('✅ evidence schema: source/snippet/relevance_score present');

// 2) 排序 (0.9, 0.5, 0.2)
assert(ctx.evidence.length === 3, 'expected 3 evidence items');
assert(ctx.evidence[0].relevance_score === 0.9, 'expected highest relevance first');
assert(ctx.evidence[1].relevance_score === 0.5, 'expected middle relevance second');
assert(ctx.evidence[2].relevance_score === 0.2, 'expected lowest relevance last');
console.log('✅ evidence sorting by relevance_score works');

// 3) tool_trace：error codes must be pure (no colon)；摘要 trace 必須可辨識
let hasSummary = false;
for (const t of ctx.tool_trace) {
  if (t.error) {
    assert(!String(t.error).includes(':'), `tool_trace error code contains colon: ${t.error}`);
  }
  if (t.detail && t.detail.summary === true) {
    hasSummary = true;
  }
}
assert(hasSummary, 'expected at least one summary tool_trace entry with detail.summary=true');
console.log('✅ tool_trace: pure error codes; summary trace is taggable');

// 4) truncated 行為：用超大 snippet 觸發
const huge = 'x'.repeat(MAX_TOTAL_EVIDENCE_CHARS + 10);
const ctx2 = aggregateEvidence(
  mkResult([{ source: 'fs:huge', snippet: huge, relevance_score: 0.1 }]),
  mkResult([{ source: 'mem:small', snippet: 'small', relevance_score: 0.2 }]),
  mkResult([{ source: 'web:small', snippet: 'small2', relevance_score: 0.3 }])
);
assert(ctx2.truncated === true, 'expected truncated=true when budget exceeded');
assert(ctx2.evidence.length >= 0, 'expected evidence array');
console.log('✅ truncated: budget enforcement works');

console.log('\n✅ ALL PASSED');
