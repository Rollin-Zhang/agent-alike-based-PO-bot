/**
 * Verdict Engine Types - Commit 12 (v6-minimal)
 *
 * Deterministic verdict based ONLY on ToolContext v6:
 * - evidence length
 * - tool_trace error codes
 * - truncated flag
 *
 * No access to evidence content.
 */

// ============================================================================
// VERDICT STATUS (Three-State Output)
// ============================================================================

export type VerdictStatus = 'PROCEED' | 'DEFER' | 'BLOCK';

export interface VerdictAuditSignals {
  evidenceCount: number;
  errorCodes: string[];
  truncated: boolean;
}

// ============================================================================
// OUTPUT RESULT
// ============================================================================

/**
 * Verdict result with audit trail.
 * Includes original signals for logging/debugging.
 */
export interface VerdictResult {
  status: VerdictStatus;
  reason: string;
  signals?: VerdictAuditSignals;
}
