/**
 * buildLegacyReplyTicketTemplate
 * 
 * Pure function to build a REPLY ticket template from a TRIAGE ticket.
 * Extracted from original object literal in index.js for testability.
 * 
 * @param {Object} triageTicket - Source TRIAGE ticket
 * @param {string} replyTicketId - UUID for new REPLY ticket
 * @param {Object} outputs - Triage outputs containing reply_strategy and target_prompt_id
 * @param {string} fetchedContext - Context notes string
 * @returns {Object} REPLY ticket template (DraftTicket)
 */
function buildLegacyReplyTicketTemplate(triageTicket, replyTicketId, outputs, fetchedContext) {
  if (!triageTicket) {
    throw new Error('buildLegacyReplyTicketTemplate: triageTicket is required');
  }
  if (!replyTicketId) {
    throw new Error('buildLegacyReplyTicketTemplate: replyTicketId is required');
  }
  if (!outputs) {
    throw new Error('buildLegacyReplyTicketTemplate: outputs is required');
  }

  return {
    id: replyTicketId,
    ticket_id: replyTicketId,
    type: 'DraftTicket',
    status: 'pending',
    flow_id: 'reply_zh_hant_v1',
    event: triageTicket.event,
    metadata: {
      created_at: new Date().toISOString(),
      triage_reference_id: triageTicket.id,
      candidate_id: triageTicket.metadata.candidate_id,
      prompt_id: outputs.target_prompt_id || 'reply.standard',
      kind: 'REPLY',
      reply_input: {
        strategy: outputs.reply_strategy,
        context_notes: fetchedContext || ''
      }
    }
  };
}

module.exports = { buildLegacyReplyTicketTemplate };
