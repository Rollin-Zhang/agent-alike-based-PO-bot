/**
 * Commit 12 Verdict Engine Unit Tests
 *
 * Validates all verdict paths:
 * - Security BLOCK (criticalViolations, BLOCK_ERRORS)
 * - Data DEFER (no evidence, low chars, DEFER_ERRORS)
 * - Happy PROCEED
 */

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
};

const { computeVerdict, _testing } = require('../out/verdict/verdictEngine.js');

// Helper to create minimal ToolContext
const mkCtx = (evidence = [], tool_trace = [], truncated = false) => ({
  evidence,
  tool_trace,
  truncated
});

console.log('=== Commit 12: Verdict Engine Tests ===\n');

// ============================================================================
// TEST 1: Security BLOCK (FS_PATH_BLOCKED)
// ============================================================================
{
  const ctx = mkCtx(
    [{ source: 'fs:a', snippet: 'x', relevance_score: 0.1 }],
    [{ tool_name: 'fs', error: 'FS_PATH_BLOCKED' }],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.status === 'BLOCK', 'FS_PATH_BLOCKED should BLOCK');
  assert(result.reason.includes('FS_PATH_BLOCKED'), 'reason should include error code');
  console.log('✅ TEST 1: FS_PATH_BLOCKED -> BLOCK');
}

// ============================================================================
// TEST 3: Security BLOCK (MEM_TOOL_FORBIDDEN error)
// ============================================================================
{
  const ctx = mkCtx(
    [{ source: 'mem:a', snippet: 'x', relevance_score: 0.1 }],
    [{ tool_name: 'memory', error: 'MEM_TOOL_FORBIDDEN' }],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.status === 'BLOCK', 'MEM_TOOL_FORBIDDEN should BLOCK');
  console.log('✅ TEST 2: MEM_TOOL_FORBIDDEN -> BLOCK');
}

// ============================================================================
// TEST 4: Security BLOCK (WEB_TOOL_FORBIDDEN error)
// ============================================================================
{
  const ctx = mkCtx(
    [{ source: 'web:a', snippet: 'x', relevance_score: 0.1 }],
    [{ tool_name: 'web_search', error: 'WEB_TOOL_FORBIDDEN' }],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.status === 'BLOCK', 'WEB_TOOL_FORBIDDEN should BLOCK');
  console.log('✅ TEST 3: WEB_TOOL_FORBIDDEN -> BLOCK');
}

// ============================================================================
// TEST 5: DEFER (no evidence)
// ============================================================================
{
  const ctx = mkCtx([], [], false);
  const result = computeVerdict(ctx);
  assert(result.status === 'DEFER', 'zero evidence should DEFER');
  assert(result.reason.includes('No evidence'), 'reason should mention no evidence');
  console.log('✅ TEST 4: evidence.length=0 -> DEFER');
}

// ============================================================================
// TEST 7: DEFER (MEM_SCHEMA_DRIFT error)
// ============================================================================
{
  const ctx = mkCtx(
    [{ source: 'mem:a', snippet: 'x', relevance_score: 0.1 }],
    [{ tool_name: 'memory', error: 'MEM_SCHEMA_DRIFT' }],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.status === 'DEFER', 'MEM_SCHEMA_DRIFT should DEFER');
  console.log('✅ TEST 5: MEM_SCHEMA_DRIFT -> DEFER');
}

// ============================================================================
// TEST 8: DEFER (WEB_PARSE_FAILED error)
// ============================================================================
{
  const ctx = mkCtx(
    [{ source: 'web:a', snippet: 'x', relevance_score: 0.1 }],
    [{ tool_name: 'web_search', error: 'WEB_PARSE_FAILED' }],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.status === 'DEFER', 'WEB_PARSE_FAILED should DEFER');
  console.log('✅ TEST 6: WEB_PARSE_FAILED -> DEFER');
}

// ============================================================================
// TEST 9: DEFER (WEB_NO_RESULTS error)
// ============================================================================
{
  const ctx = mkCtx(
    [{ source: 'web:a', snippet: 'x', relevance_score: 0.1 }],
    [{ tool_name: 'web_search', error: 'WEB_NO_RESULTS' }],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.status === 'DEFER', 'WEB_NO_RESULTS should DEFER');
  console.log('✅ TEST 7: WEB_NO_RESULTS -> DEFER');
}

// ============================================================================
// TEST 10: Happy PROCEED
// ============================================================================
{
  const ctx = mkCtx(
    [
      { source: 'fs:1', snippet: 'hello', relevance_score: 0.1 },
      { source: 'mem:1', snippet: 'world', relevance_score: 0.2 }
    ],
    [],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.status === 'PROCEED', 'healthy signals should PROCEED');
  assert(result.reason.includes('all checks passed'), 'reason should mention checks passed');
  console.log('✅ TEST 8: healthy ctx -> PROCEED');
}

// ============================================================================
// TEST 9: PROCEED even if truncated=true (no errors)
// ============================================================================
{
  const ctx = mkCtx(
    [
      { source: 'fs:1', snippet: 'hello', relevance_score: 0.1 }
    ],
    [],
    true
  );
  const result = computeVerdict(ctx);
  assert(result.status === 'PROCEED', 'truncated without errors should still PROCEED');
  console.log('✅ TEST 9: truncated=true + no errors -> PROCEED');
}

// ============================================================================
// TEST 11: Priority order (BLOCK before DEFER)
// ============================================================================
{
  const ctx = mkCtx(
    [],
    [
      { tool_name: 'fs', error: 'FS_PATH_BLOCKED' },
      { tool_name: 'web_search', error: 'WEB_PARSE_FAILED' }
    ],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.status === 'BLOCK', 'BLOCK should take priority over DEFER');
  console.log('✅ TEST 9: BLOCK priority over DEFER');
}

// ============================================================================
// TEST 10: Audit signals returned
// ============================================================================
{
  const ctx = mkCtx(
    [
      { source: 'fs:a', snippet: 'hello world', relevance_score: 0.5 },
      { source: 'mem:b', snippet: 'test content here', relevance_score: 0.6 }
    ],
    [
      { tool_name: 'fs', error: 'FS_PATH_BLOCKED' }
    ],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.signals, 'signals should exist');
  assert(result.signals.evidenceCount === 2, 'signals.evidenceCount should be 2');
  assert(result.signals.errorCodes.length === 1, 'signals.errorCodes length should be 1');
  assert(result.signals.errorCodes[0] === 'FS_PATH_BLOCKED', 'signals.errorCodes[0] mismatch');
  assert(result.signals.truncated === false, 'signals.truncated should be false');
  console.log('✅ TEST 10: signals returned for audit');
}

// ============================================================================
// TEST 11: Exact match (no startsWith)
// ============================================================================
{
  const ctx = mkCtx(
    [{ source: 'fs:1', snippet: 'x', relevance_score: 0.1 }],
    [{ tool_name: 'fs', error: 'FS_PATH_SOMETHING_ELSE' }],
    false
  );
  const result = computeVerdict(ctx);
  assert(result.status !== 'BLOCK', 'non-exact match should not BLOCK');
  console.log('✅ TEST 11: exact error code matching (no startsWith)');
}

// ============================================================================
// TEST 12: Deterministic (same input, same output)
// ============================================================================
{
  const ctx = mkCtx(
    [{ source: 'mem:1', snippet: 'hello', relevance_score: 0.1 }],
    [{ tool_name: 'memory', error: 'MEM_SCHEMA_INVALID' }],
    true
  );
  const r1 = computeVerdict(ctx);
  const r2 = computeVerdict(ctx);
  assert(r1.status === r2.status, 'same input should produce same status');
  assert(r1.reason === r2.reason, 'same input should produce same reason');
  console.log('✅ TEST 12: deterministic computeVerdict');
}

console.log('\n✅ ALL 13 TESTS PASSED');
