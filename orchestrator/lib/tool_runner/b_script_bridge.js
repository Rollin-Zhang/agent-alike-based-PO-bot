/**
 * b_script_bridge.js
 *
 * Canonical bridge helpers for the Stage 2 B-script executor.
 *
 * Contract (M2-B.2-v2):
 * - tool_steps precedence: metadata.tool_input.tool_steps → ticket.tool_steps → []
 * - canonical tool_name format: server-level (see TOOL_NAME_CANONICAL_FORMAT)
 */

const { TOOL_NAME_CANONICAL_FORMAT } = require('./ssot');

/**
 * Normalize tool_steps to canonical format.
 *
 * Supports two input formats:
 * 1) { server, tool, args } → canonical { tool_name: 'server', args }
 * 2) { tool_name, args } → already canonical (pass through)
 *
 * Observability-only fields are preserved on the normalized step.
 * These MUST NOT be moved into args (would violate allowlist).
 *
 * @param {Array} inputSteps
 * @param {Object} opts
 * @param {Object} opts.logger - logger with error() (optional)
 * @returns {Array}
 */
function normalizeToolSteps(inputSteps, opts = {}) {
  const logger = opts.logger || console;

  if (!Array.isArray(inputSteps)) {
    return [];
  }

  return inputSteps
    .map((step, index) => {
      // Case 1: Already canonical { tool_name, args }
      if (step && step.tool_name) {
        return {
          tool_name: step.tool_name,
          args: step.args || {},
          _original_shape: 'tool_name'
        };
      }

      // Case 2: Legacy { server, tool, args } → canonical
      if (step && step.server && step.tool) {
        // SSOT alignment: tool_name canonical format is server-level (e.g. 'web_search')
        // Do NOT compose 'server.tool' here; it conflicts with TOOL_ARGS_ALLOWLIST keys.
        // If canonical format changes, update SSOT + allowlist + gateway fixtures together.
        if (TOOL_NAME_CANONICAL_FORMAT !== 'server') {
          logger?.error?.(
            `[normalize] Unexpected TOOL_NAME_CANONICAL_FORMAT='${String(TOOL_NAME_CANONICAL_FORMAT)}'`
          );
        }

        return {
          tool_name: String(step.server),
          args: step.args || {},
          _original_shape: 'server_tool',
          _original_server: String(step.server),
          _original_tool: String(step.tool)
        };
      }

      // Invalid format: emit warning and skip
      logger?.error?.(`[normalize] Invalid tool_step format at index ${index}:`, step);
      return null;
    })
    .filter((s) => s !== null);
}

/**
 * Bridge tool_steps source (SSOT order):
 * 1) ticket.metadata.tool_input.tool_steps
 * 2) ticket.tool_steps
 * 3) []
 *
 * Returns a new ticket object with canonical steps at ticket.tool_steps.
 */
function bridgeToolSteps(ticket, opts = {}) {
  const rawSteps = ticket?.metadata?.tool_input?.tool_steps || ticket?.tool_steps || [];
  const normalizedSteps = normalizeToolSteps(rawSteps, opts);

  return {
    ...ticket,
    tool_steps: normalizedSteps
  };
}

module.exports = {
  normalizeToolSteps,
  bridgeToolSteps
};
