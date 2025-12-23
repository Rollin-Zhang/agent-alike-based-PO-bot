const { v4: uuidv4 } = require('uuid');
const { readDerived, writeDerived } = require('./derivedCompat');

/**
 * Derive TOOL ticket from TRIAGE ticket if conditions met.
 * @param {Object} ticket - TRIAGE ticket
 * @param {Object} outputs - Fill outputs (must contain decision)
 * @param {TicketStore} ticketStore - Store instance
 * @returns {Promise<string|null>} - Created TOOL ticket ID or null if not derived
 */
async function deriveToolTicketFromTriage(ticket, outputs, ticketStore) {
  // Gate: kind=TRIAGE + decision=APPROVE + ENABLE_TOOL_DERIVATION=true
  if (
    ticket.metadata?.kind !== 'TRIAGE' ||
    outputs?.decision !== 'APPROVE' ||
    process.env.ENABLE_TOOL_DERIVATION !== 'true'
  ) {
    return null;
  }

  // Idempotency: skip if already derived (use compat helper)
  const existingDerived = readDerived(ticket);
  if (existingDerived?.tool_ticket_id) {
    return null;
  }

  // Create TOOL ticket
  const newId = uuidv4();
  const toolTicket = {
    id: newId,
    ticket_id: newId,
    type: 'ToolTicket',
    status: 'pending',
    flow_id: 'tool_execution_v1',
    event: ticket.event, // Inherit from TRIAGE
    metadata: {
      created_at: new Date().toISOString(),
      kind: 'TOOL',
      parent_ticket_id: ticket.id,
      candidate_id: ticket.metadata.candidate_id
    }
  };

  // Persist TOOL ticket
  await ticketStore.create(toolTicket);

  // Write back-reference using compat helper (writes to both canonical and legacy locations)
  writeDerived(ticket, { tool_ticket_id: newId });

  // Log derivation (exact format)
  console.log(`[derive] TRIAGE -> TOOL ticket=${newId}`);

  return newId;
}

module.exports = deriveToolTicketFromTriage;
