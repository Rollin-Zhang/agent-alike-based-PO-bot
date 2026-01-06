/**
 * deriveReplyTicketFromTool.js
 * 
 * Derives REPLY ticket from TOOL ticket when conditions are met.
 * Implements: gates, idempotency, duplicate recovery, template override rules.
 * 
 * Commit 6B.2: Pure derivation logic, no server integration.
 * M2-C.2: Uses canonical toolVerdict helpers (no legacy reads).
 */

const { v4: uuidv4 } = require('uuid');
const { buildLegacyReplyTicketTemplate } = require('./buildLegacyReplyTicketTemplate');
const schemaGate = require('./schemaGate');
const { readToolVerdict, isProceed } = require('./toolVerdict');

/**
 * Derive REPLY ticket from TOOL ticket if conditions met.
 * 
 * @param {Object} toolTicket - TOOL ticket being filled
 * @param {Object} outputs - Fill outputs (preferred source for tool_verdict)
 * @param {Object} triageTicket - Parent TRIAGE ticket (for template)
 * @param {string} fetchedContext - Context notes string
 * @param {TicketStore} ticketStore - Store instance
 * @returns {Promise<Object>} Result: { created, recovered, reply_ticket_id, reason }
 */
async function deriveReplyTicketFromTool(
  toolTicket,
  outputs,
  triageTicket,
  fetchedContext,
  ticketStore
) {
  // --- GATE 1: kind must be TOOL ---
  if (toolTicket.metadata?.kind !== 'TOOL') {
    return { created: false, reason: 'gate_kind_not_tool' };
  }

  // --- GATE 2: ENABLE_REPLY_DERIVATION must be "true" ---
  if (process.env.ENABLE_REPLY_DERIVATION !== 'true') {
    return { created: false, reason: 'gate_reply_derivation_disabled' };
  }

  // --- GATE 3: TOOL_ONLY_MODE must not be "true" ---
  if (process.env.TOOL_ONLY_MODE === 'true') {
    return { created: false, reason: 'gate_tool_only_mode' };
  }

  // --- GATE 4: tool_verdict must be PROCEED (single entry, includes source for debug) ---
  const verdict = readToolVerdict(outputs, toolTicket);

  if (!verdict || verdict.status === null) {
    if (verdict && verdict.invalid_status !== undefined) {
      schemaGate.emitWarning({
        warn_code: schemaGate.WARN_CODE.TOOL_VERDICT_INVALID,
        boundary: schemaGate.BOUNDARY.TICKET_DERIVE,
        direction: schemaGate.DIRECTION.INTERNAL,
        kind: schemaGate.KIND.TOOL,
        ticket_id: toolTicket.id,
        schema_ref: 'ticket.json',
        errors: [{ path: '/tool_verdict', keyword: 'toolVerdict' }],
        note: `invalid tool_verdict from ${verdict.source}`,
        details: {
          source: verdict.source,
          raw: verdict.raw,
          invalid_status: verdict.invalid_status
        }
      });
    }
    return { created: false, reason: 'missing_tool_verdict' };
  }

  if (!isProceed(verdict)) {
    return {
      created: false,
      reason: 'gate_tool_verdict_not_proceed'
    };
  }

  // --- IDEMPOTENCY: Check if already derived ---
  const existingDerived = toolTicket.derived;
  if (existingDerived && existingDerived.reply_ticket_id) {
    return { 
      created: false, 
      recovered: false,
      reply_ticket_id: existingDerived.reply_ticket_id,
      reason: 'idempotent'
    };
  }

  // --- DUPLICATE RECOVERY: Check for orphan REPLY tickets ---
  // Only list if we don't have reply_ticket_id yet
  const orphanReplies = await ticketStore.list({
    type: 'DraftTicket',
    'metadata.kind': 'REPLY',
    'metadata.parent_ticket_id': toolTicket.id
  });

  if (orphanReplies && orphanReplies.length > 0) {
    // Found orphan REPLY, recover it
    const orphanId = orphanReplies[0].id;
    toolTicket.derived = {
      ...(toolTicket.derived || {}),
      reply_ticket_id: orphanId,
      reply_derived_at: new Date().toISOString()
    };
    console.log(`[derive] TOOL -> REPLY recovered orphan ticket=${orphanId}`);
    return {
      created: false,
      recovered: true,
      reply_ticket_id: orphanId,
      reason: 'recovered_orphan'
    };
  }

  // --- CREATE NEW REPLY TICKET ---
  // Build template from triageTicket
  const replyTicketId = uuidv4();
  
  // Use outputs for template, fallback to stored final_outputs if outputs is null/undefined
  const templateOutputs = outputs !== null && outputs !== undefined
    ? outputs
    : (toolTicket.metadata && toolTicket.metadata.final_outputs) || {};
  
  const template = buildLegacyReplyTicketTemplate(
    triageTicket,
    replyTicketId,
    templateOutputs,
    fetchedContext
  );

  // Template override rules:
  // PRESERVE: type, status, flow_id, event (from template)
  // OVERRIDE: id, ticket_id, kind, parent_ticket_id, timestamps, triage_reference_id
  const replyTicket = {
    ...template,
    id: replyTicketId,
    ticket_id: replyTicketId,
    metadata: {
      ...template.metadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      kind: 'REPLY',
      parent_ticket_id: toolTicket.id,
      triage_reference_id: triageTicket.id,
      tool_verdict_source: verdict.source
    }
  };

  // Internal boundary validation (strict internal must never explode)
  const gate = schemaGate.gateInternal(replyTicket, {
    kind: schemaGate.KIND.REPLY,
    boundary: schemaGate.BOUNDARY.TICKET_DERIVE,
    ticketId: replyTicketId,
    schemaRef: 'ticket.json'
  });

  if (!gate.ok) {
    return { created: false, reason: 'schema_validation_failed' };
  }

  // Persist REPLY ticket
  await ticketStore.create(replyTicket);

  // Write back-reference (fail-fast: will throw on error)
  toolTicket.derived = {
    ...(toolTicket.derived || {}),
    reply_ticket_id: replyTicketId,
    reply_derived_at: new Date().toISOString()
  };

  // Log derivation
  console.log(`[derive] TOOL -> REPLY ticket=${replyTicketId}`);

  return {
    created: true,
    recovered: false,
    reply_ticket_id: replyTicketId,
    reason: 'created'
  };
}

module.exports = deriveReplyTicketFromTool;
