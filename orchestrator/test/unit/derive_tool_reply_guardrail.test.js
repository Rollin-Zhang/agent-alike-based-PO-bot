const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const { makeTicketStoreFixture } = require('./fixtures/ticketStore');
const schemaGate = require('../../lib/schemaGate');
const { maybeDeriveReplyFromToolOnFill } = require('../../lib/maybeDeriveReplyFromToolOnFill');

/**
 * Acceptance (M2-B.3-1): strict internal reject must not block/mutate parent TOOL.
 *
 * Symmetry with TRIAGE→TOOL guardrail:
 * - strict internal schemaGate strategy = skip (do NOT create a child ticket)
 * - Parent TOOL must not become blocked/failed, and must not gain derived backref
 * - schemaGate must emit audit + metrics for schema_gate_reject
 */
async function testToolReplyInternalStrictRejectDoesNotMutateParent() {
  const fixture = makeTicketStoreFixture();
  const { store, cleanup } = fixture;

  const prevMode = process.env.SCHEMA_GATE_MODE;
  const prevDerive = process.env.ENABLE_REPLY_DERIVATION;
  const prevToolOnly = process.env.TOOL_ONLY_MODE;

  const audit = [];

  try {
    console.log('[Test] testToolReplyInternalStrictRejectDoesNotMutateParent: START');

    process.env.SCHEMA_GATE_MODE = 'strict';
    process.env.ENABLE_REPLY_DERIVATION = 'true';
    delete process.env.TOOL_ONLY_MODE;

    schemaGate.resetMetrics();
    schemaGate.setAuditLogger((e) => audit.push(e));

    const beforeMetrics = schemaGate.getMetrics().schema_strict_reject_total;

    // Create TRIAGE ticket with intentionally schema-invalid event.
    // This must NOT throw in derivation; it must be rejected by schemaGate when validating derived REPLY.
    const triageId = uuidv4();
    const triageTicket = {
      id: triageId,
      ticket_id: triageId,
      type: 'DraftTicket',
      status: 'pending',
      flow_id: 'triage_v1',
      event: { content: 'intentionally-invalid-event-shape' },
      metadata: {
        kind: 'TRIAGE',
        candidate_id: 'test-candidate',
        created_at: new Date().toISOString()
      }
    };
    await store.create(triageTicket);

    // Parent TOOL ticket
    const toolId = uuidv4();
    const toolTicket = {
      id: toolId,
      ticket_id: toolId,
      type: 'DraftTicket',
      status: 'done',
      flow_id: 'tool_v1',
      event: { content: 'tool-event-not-used-for-reply-template' },
      metadata: {
        kind: 'TOOL',
        parent_ticket_id: triageId,
        created_at: new Date().toISOString(),
        final_outputs: {
          tool_verdict: { status: 'PROCEED' }
        }
      }
    };

    const parentSnapshot = JSON.parse(
      JSON.stringify({
        status: toolTicket.status,
        kind: toolTicket.metadata?.kind,
        parent_ticket_id: toolTicket.metadata?.parent_ticket_id,
        created_at: toolTicket.metadata?.created_at
      })
    );

    const outputs = {
      // Prefer outputs.tool_verdict per toolVerdictCompat precedence
      tool_verdict: { status: 'PROCEED' },
      // Template builder requires outputs object (fields are optional)
      reply_strategy: 'test',
      target_prompt_id: 'reply.standard'
    };

    const res = await maybeDeriveReplyFromToolOnFill(toolTicket, outputs, store, console);

    assert.strictEqual(res.attempted, true, 'Derivation should be attempted for TOOL');
    assert.strictEqual(res.created, false, 'Should skip derivation on strict internal schema reject');
    assert.strictEqual(res.reason, 'schema_validation_failed', 'Should surface schema_validation_failed reason');

    // Parent TOOL must not be blocked/failed, and must not gain derived backrefs.
    assert.strictEqual(toolTicket.status, parentSnapshot.status, 'Parent status must not change');
    assert.notStrictEqual(toolTicket.status, 'blocked', 'Parent must not be blocked by internal strict reject');
    assert.notStrictEqual(toolTicket.status, 'failed', 'Parent must not be failed by internal strict reject');

    assert.strictEqual(toolTicket.metadata?.kind, parentSnapshot.kind, 'Parent kind must not change');
    assert.strictEqual(
      toolTicket.metadata?.parent_ticket_id,
      parentSnapshot.parent_ticket_id,
      'Parent parent_ticket_id must not change'
    );
    assert.strictEqual(toolTicket.metadata?.created_at, parentSnapshot.created_at, 'Parent created_at must not change');

    assert.ok(!toolTicket.metadata?.block, 'Parent must not gain metadata.block');
    assert.ok(!toolTicket.metadata?.blocked_at, 'Parent must not gain metadata.blocked_at');
    assert.ok(!toolTicket.metadata?.error, 'Parent must not gain metadata.error');

    assert.ok(!toolTicket.derived?.reply_ticket_id, 'Parent must not gain derived.reply_ticket_id');
    assert.ok(
      !toolTicket.metadata?.derived?.reply_ticket_id,
      'Parent must not gain metadata.derived.reply_ticket_id'
    );

    // No REPLY tickets should be created
    const allTickets = await store.list({ limit: 200 });
    const replyTickets = allTickets.filter((t) => t.metadata?.kind === 'REPLY');
    assert.strictEqual(replyTickets.length, 0, 'Should not create REPLY ticket on strict internal reject');

    const afterMetrics = schemaGate.getMetrics().schema_strict_reject_total;
    assert.ok(afterMetrics >= beforeMetrics + 1, 'Should increment schema strict reject total');

    const rejectAudit = audit.find(
      (e) =>
        e.action === 'schema_gate_reject' &&
        e.direction === schemaGate.DIRECTION.INTERNAL &&
        e.boundary === schemaGate.BOUNDARY.TICKET_DERIVE &&
        e.kind === schemaGate.KIND.REPLY &&
        e.code === 'SCHEMA_VALIDATION_FAILED'
    );
    assert.ok(rejectAudit, 'Should emit schema_gate_reject audit entry for internal derive');

    // Harden against false-pass: reject must include actual error detail.
    assert.ok(Number(rejectAudit.warn_count || 0) > 0, 'reject audit should have warn_count > 0');
    assert.ok(
      Array.isArray(rejectAudit.warn_codes) && rejectAudit.warn_codes.length > 0,
      'reject audit should include non-empty warn_codes'
    );
    assert.ok(
      Array.isArray(rejectAudit.errors) && rejectAudit.errors.length > 0,
      'reject audit should include non-empty errors'
    );

    assert.ok(
      rejectAudit.warn_codes.includes('schema_invalid') || rejectAudit.warn_codes.includes('missing'),
      'reject audit warn_codes should include schema_invalid or missing'
    );

    console.log('[Test] testToolReplyInternalStrictRejectDoesNotMutateParent: PASS ✓');
    return true;
  } catch (err) {
    console.error('[Test] testToolReplyInternalStrictRejectDoesNotMutateParent: FAIL ✗');
    console.error(err);
    return false;
  } finally {
    schemaGate.setAuditLogger(null);
    schemaGate.resetMetrics();

    if (prevMode === undefined) delete process.env.SCHEMA_GATE_MODE;
    else process.env.SCHEMA_GATE_MODE = prevMode;

    if (prevDerive === undefined) delete process.env.ENABLE_REPLY_DERIVATION;
    else process.env.ENABLE_REPLY_DERIVATION = prevDerive;

    if (prevToolOnly === undefined) delete process.env.TOOL_ONLY_MODE;
    else process.env.TOOL_ONLY_MODE = prevToolOnly;

    cleanup();
  }
}

module.exports = {
  testToolReplyInternalStrictRejectDoesNotMutateParent
};
