/**
 * toolVerdict.js - Canonical Tool Verdict helpers (M2-C.2)
 *
 * Contract:
 * - Canonical persisted location: ticket.tool_verdict
 * - Preferred transient input: outputs.tool_verdict
 * - This module does NOT read legacy locations (ticket.final_outputs/tool_verdict, ticket.metadata.final_outputs/tool_verdict).
 */

const VALID_STATUSES = ['PROCEED', 'DEFER', 'BLOCK'];

function normalizeStatusString(status) {
  if (typeof status !== 'string') return null;
  const normalized = status.trim().toUpperCase();
  return normalized;
}

/**
 * Normalizes a verdict input.
 *
 * Accepted inputs:
 * - string: 'PROCEED' | 'DEFER' | 'BLOCK' (case-insensitive)
 * - object: { status: <string>, reason?: <string> }
 *
 * Returns:
 * - null if input is null/undefined
 * - { status, reason? } for valid verdicts
 * - { status: null, raw, invalid_status } for invalid inputs
 */
function normalizeToolVerdict(input) {
  if (input === null || input === undefined) return null;

  // String form
  if (typeof input === 'string') {
    const s = normalizeStatusString(input);
    if (!s) return { status: null, raw: input, invalid_status: input };
    if (!VALID_STATUSES.includes(s)) return { status: null, raw: input, invalid_status: s };
    return { status: s };
  }

  // Object form
  if (typeof input === 'object') {
    const rawStatus = input.status;
    const s = normalizeStatusString(rawStatus);
    if (!s) return { status: null, raw: input, invalid_status: rawStatus };
    if (!VALID_STATUSES.includes(s)) return { status: null, raw: input, invalid_status: s };

    const verdict = { status: s };
    if (typeof input.reason === 'string' && input.reason.trim() !== '') {
      verdict.reason = input.reason;
    }
    return verdict;
  }

  return { status: null, raw: input, invalid_status: String(input) };
}

/**
 * Reads tool verdict from preferred sources.
 * Precedence:
 *   outputs.tool_verdict > ticket.tool_verdict
 */
function readToolVerdict(outputs, ticket) {
  let raw;
  let source;

  if (outputs && Object.prototype.hasOwnProperty.call(outputs, 'tool_verdict')) {
    raw = outputs.tool_verdict;
    source = 'outputs.tool_verdict';
  } else if (ticket && Object.prototype.hasOwnProperty.call(ticket, 'tool_verdict')) {
    raw = ticket.tool_verdict;
    source = 'ticket.tool_verdict';
  } else {
    return null;
  }

  const normalized = normalizeToolVerdict(raw);
  if (normalized === null) return null;

  // Attach debug fields used by derivation logic (stable strings, no cardinality risk)
  return {
    ...normalized,
    source,
    raw
  };
}

function isProceed(verdict) {
  return Boolean(verdict && verdict.status === 'PROCEED');
}

module.exports = {
  VALID_STATUSES,
  normalizeToolVerdict,
  readToolVerdict,
  isProceed
};
