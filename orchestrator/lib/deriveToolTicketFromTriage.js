const { v4: uuidv4 } = require('uuid');
const schemaGate = require('./schemaGate');

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

  // Idempotency: skip if already derived
  const existingDerived = ticket.derived;
  if (existingDerived && existingDerived.tool_ticket_id) {
    return null;
  }

  // Create TOOL ticket
  const newId = uuidv4();

  // SSOT tool_steps source of truth: metadata.tool_input.tool_steps
  // Use legacy shape { server, tool, args } so RunnerCore bridge can preserve _original_tool.
  const content = String(ticket?.event?.content || '').trim();
  const query = content.length > 0 ? content.slice(0, 120) : `triage:${ticket.metadata?.candidate_id || newId}`;
  const tool_steps = [
    {
      server: 'memory',
      tool: 'search_nodes',
      args: { query }
    }
  ];

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
      candidate_id: ticket.metadata.candidate_id,
      triage_reference_id: ticket.id,
      tool_input: {
        source: 'deriveToolTicketFromTriage',
        tool_steps
      }
    }
  };

  // Internal boundary validation (strict internal must never explode)
  const gate = schemaGate.gateInternal(toolTicket, {
    kind: schemaGate.KIND.TOOL,
    boundary: schemaGate.BOUNDARY.TICKET_DERIVE,
    ticketId: toolTicket.id,
    schemaRef: 'ticket.json'
  });

  if (!gate.ok) {
    return null;
  }

  // Persist TOOL ticket
  await ticketStore.create(toolTicket);

  // Write back-reference (canonical only)
  ticket.derived = {
    ...(ticket.derived || {}),
    tool_ticket_id: newId
  };

  // Log derivation (exact format)
  console.log(`[derive] TRIAGE -> TOOL ticket=${newId}`);

  return newId;
}

module.exports = deriveToolTicketFromTriage;
