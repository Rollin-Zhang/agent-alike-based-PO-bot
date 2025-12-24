/**
 * Wait/polling helpers for integration tests
 * Only for test usage - do not import in production code
 */

const { httpListTickets } = require('./http');

/**
 * Wait for ticket matching predicate with polling
 * @param {string} baseUrl - Server base URL
 * @param {Function} predicate - (ticket) => boolean
 * @param {Object} options - {timeoutMs: 5000, intervalMs: 100}
 * @returns {Promise<Object>} Matching ticket
 * @throws {Error} If timeout or no match
 */
async function waitForTicket(baseUrl, predicate, options = {}) {
  const { timeoutMs = 5000, intervalMs = 100 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await httpListTickets(baseUrl, { limit: 10000 });
    const tickets = response.data || [];
    const match = tickets.find(predicate);
    if (match) {
      return match;
    }
    await sleep(intervalMs);
  }

  throw new Error(`waitForTicket timeout after ${timeoutMs}ms`);
}

/**
 * Find REPLY ticket by parent reference
 * Supports both new derivation path and legacy path:
 * - New path: parent_ticket_id === toolId (TOOL→REPLY)
 * - Legacy path: triage_reference_id === triageId (TRIAGE→REPLY, no parent_ticket_id)
 * 
 * @param {string} baseUrl - Server base URL
 * @param {string} parentId - Parent ticket ID (TOOL for new path, TRIAGE for legacy)
 * @param {Object} options - { legacy: boolean, timeoutMs, intervalMs }
 * @returns {Promise<Object>} REPLY ticket
 */
async function findReplyByParent(baseUrl, parentId, options = {}) {
  const { legacy = false, ...waitOptions } = options;

  // Branch: new derivation path vs legacy path
  const predicate = legacy
    ? (t) => t.metadata?.kind === 'REPLY' && t.metadata?.triage_reference_id === parentId
    : (t) => t.metadata?.kind === 'REPLY' && t.metadata?.parent_ticket_id === parentId;

  return waitForTicket(baseUrl, predicate, waitOptions);
}

/**
 * Sleep helper
 * @param {number} ms - Milliseconds
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  waitForTicket,
  findReplyByParent,
  sleep
};
