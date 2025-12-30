/**
 * Evidence Aggregator - Merges results from multiple adapters
 *
 * Commit 11: Evidence Aggregator (v6)
 * - Combines evidence from fs, memory, web_search adapters
 * - Sorts by relevance_score (highest first)
 * - Enforces total character budget with truncation
 * - Collects tool_trace with pure error codes (no colon suffixes)
 */

import { MAX_TOTAL_EVIDENCE_CHARS } from '../shared/constants';
import type { AdapterResult, Evidence, ToolContext, ToolTraceEntry } from '../shared/toolContext';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Deduplicate by source, keeping the best candidate.
 * Policy: keep higher relevance_score; if tie, keep longer snippet.
 */
function deduplicateEvidenceBest(evidence: Evidence[]): Evidence[] {
  const bestBySource = new Map<string, Evidence>();

  for (const e of evidence) {
    const current = bestBySource.get(e.source);
    if (!current) {
      bestBySource.set(e.source, e);
      continue;
    }

    if (e.relevance_score > current.relevance_score) {
      bestBySource.set(e.source, e);
      continue;
    }

    if (e.relevance_score === current.relevance_score) {
      const eLen = e.snippet.length;
      const cLen = current.snippet.length;
      if (eLen > cLen) {
        bestBySource.set(e.source, e);
      }
    }
  }

  return Array.from(bestBySource.values());
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Aggregates evidence from multiple adapter results.
 * 
 * @param fsResult - Result from filesystem adapter
 * @param memResult - Result from memory graph adapter
 * @param webResult - Result from web search adapter
 * @returns Aggregated ToolContext with merged evidence and traces
 * 
 * Behavior:
 * 1. Collects tool_trace entries from all adapters (errors with pure codes)
 * 2. Normalizes and merges evidence arrays
 * 3. Deduplicates by source
 * 4. Sorts by relevance_score (highest first)
 * 5. Truncates to MAX_TOTAL_EVIDENCE_CHARS budget
 */
export function aggregateEvidence(
  fsResult: AdapterResult,
  memResult: AdapterResult,
  webResult: AdapterResult
): ToolContext {
  const tool_trace: ToolTraceEntry[] = [];

  // Preserve per-tool traces emitted by adapters.
  for (const result of [fsResult, memResult, webResult]) {
    if (Array.isArray(result.tool_trace)) {
      tool_trace.push(...result.tool_trace);
    }
  }

  for (const [name, result] of [
    ['fs', fsResult],
    ['memory', memResult],
    ['web_search', webResult]
  ] as const) {
    if (result.error) {
      tool_trace.push({
        tool_name: name,
        error: result.error,
        detail: { ...(result.detail || {}), summary: true }
      });
    }
  }

  let all = [...fsResult.evidence, ...memResult.evidence, ...webResult.evidence];
  all = deduplicateEvidenceBest(all);
  all.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

  let totalChars = 0;
  let truncated = false;
  const evidence: Evidence[] = [];

  for (const e of all) {
    if (totalChars + e.snippet.length > MAX_TOTAL_EVIDENCE_CHARS) {
      truncated = true;
      break;
    }
    evidence.push(e);
    totalChars += e.snippet.length;
  }

  return { evidence, tool_trace, truncated };
}

export const _testing = {
  deduplicateEvidenceBest
};
