/**
 * Verdict Engine - Commit 12 (v6-minimal)
 *
 * Deterministic, stateless judge for tool-phase outcomes.
 * Input is ToolContext v6 only: { evidence, tool_trace, truncated }.
 *
 * Hard locks:
 * - No evidence content access (never reads snippet text)
 * - Exact-match error code sets (Set.has)
 * - No heuristics / thresholds beyond v6 rules
 * - No side effects
 */
import type { ToolContext } from '../shared/toolContext';
import type { VerdictAuditSignals, VerdictResult } from './types';

// ============================================================================
// ERROR CODE CLASSIFICATION (SSOT)
// ============================================================================

/**
 * Errors that trigger immediate BLOCK.
 * Security violations, unauthorized access, forbidden tools.
 */
const BLOCK_ERRORS = new Set([
  'FS_PATH_BLOCKED',
  'MEM_TOOL_FORBIDDEN',
  'WEB_TOOL_FORBIDDEN'
]);

/**
 * Errors that trigger DEFER.
 * Data issues, parse failures, schema problems.
 */
const DEFER_ERRORS = new Set([
  'MEM_SCHEMA_INVALID',
  'MEM_SCHEMA_DRIFT',
  'MEM_ENTITY_TYPE_UNKNOWN',
  'WEB_PARSE_FAILED',
  'WEB_NO_RESULTS'
]);

// ============================================================================
// CORE VERDICT (Pure Function)
// ============================================================================

/**
 * v6-minimal computeVerdict.
 *
 * Waterfall:
 * 1) If any trace.error ∈ BLOCK_ERRORS -> BLOCK
 * 2) Else if any trace.error ∈ DEFER_ERRORS -> DEFER
 * 3) Else if evidence.length === 0 -> DEFER
 * 4) Else -> PROCEED
 */
export function computeVerdict(
  ctx: ToolContext
): VerdictResult {
  const errorCodes: string[] = [];
  for (const trace of ctx.tool_trace) {
    if (trace.error) errorCodes.push(trace.error);
  }

  const signals: VerdictAuditSignals = {
    evidenceCount: ctx.evidence.length,
    errorCodes,
    truncated: ctx.truncated
  };

  for (const code of errorCodes) {
    if (BLOCK_ERRORS.has(code)) {
      return { status: 'BLOCK', reason: `security: ${code}`, signals };
    }
  }

  for (const code of errorCodes) {
    if (DEFER_ERRORS.has(code)) {
      return { status: 'DEFER', reason: `data issue: ${code}`, signals };
    }
  }

  if (ctx.evidence.length === 0) {
    return { status: 'DEFER', reason: 'No evidence collected', signals };
  }

  return { status: 'PROCEED', reason: 'all checks passed', signals };
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export const _testing = {
  BLOCK_ERRORS,
  DEFER_ERRORS
};
