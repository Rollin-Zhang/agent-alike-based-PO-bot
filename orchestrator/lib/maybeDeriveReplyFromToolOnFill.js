/**
 * maybeDeriveReplyFromToolOnFill
 *
 * Small, unit-testable helper for the /v1/tickets/:id/fill handler.
 * It wires TOOL→REPLY derivation while keeping /fill readable.
 */

const deriveReplyTicketFromTool = require('./deriveReplyTicketFromTool');

/**
 * @param {Object} ticket - Ticket being filled
 * @param {Object} outputs - Fill outputs
 * @param {TicketStore} ticketStore - Store instance
 * @param {Object} logger - Logger with warn/info/error (optional)
 * @returns {Promise<Object>} Derivation result (or skip metadata)
 */
async function maybeDeriveReplyFromToolOnFill(ticket, outputs, ticketStore, logger) {
  if (ticket?.metadata?.kind !== 'TOOL') {
    return { attempted: false, reason: 'not_tool' };
  }

  // Idempotency guard (explicit): if TOOL already has derived reply, never derive again.
  const existingDerived = ticket.derived;
  if (existingDerived && existingDerived.reply_ticket_id) {
    return {
      attempted: true,
      created: false,
      recovered: false,
      reply_ticket_id: existingDerived.reply_ticket_id,
      reason: 'idempotent'
    };
  }

  const parentTriageId = ticket.metadata?.parent_ticket_id;
  if (!parentTriageId) {
    logger?.warn?.('[derive] TOOL -> REPLY skipped: missing parent TRIAGE', {
      ticket_id: ticket?.id,
      parent_ticket_id: parentTriageId
    });

    return { attempted: false, reason: 'missing_parent_ticket_id' };
  }

  const triageTicket = await ticketStore.get(parentTriageId);
  if (!triageTicket) {
    logger?.warn?.('[derive] TOOL -> REPLY skipped: missing parent TRIAGE', {
      ticket_id: ticket?.id,
      parent_ticket_id: parentTriageId
    });

    return { attempted: false, reason: 'missing_parent_triage_ticket' };
  }

  const result = await deriveReplyTicketFromTool(ticket, outputs, triageTicket, '', ticketStore);
  return { attempted: true, ...result };
}

module.exports = { maybeDeriveReplyFromToolOnFill };
