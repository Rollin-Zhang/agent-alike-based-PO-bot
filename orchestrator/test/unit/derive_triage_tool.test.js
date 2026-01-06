const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const { makeTicketStoreFixture } = require('./fixtures/ticketStore');
const deriveToolTicketFromTriage = require('../../lib/deriveToolTicketFromTriage');
const schemaGate = require('../../lib/schemaGate');

/**
 * Test: TRIAGE -> TOOL derivation with idempotency
 */
async function testTriageToolDerivation() {
  const fixture = makeTicketStoreFixture();
  const { store, cleanup } = fixture;

  try {
    console.log('[Test] testTriageToolDerivation: START');

    // Set environment
    process.env.ENABLE_TOOL_DERIVATION = 'true';

    // Create TRIAGE ticket
    const triageId = uuidv4();
    const triageTicket = {
      id: triageId,
      ticket_id: triageId,
      type: 'TriageTicket',
      status: 'pending',
      flow_id: 'triage_v1',
      event: { content: 'Test event' },
      metadata: {
        kind: 'TRIAGE',
        candidate_id: 'test-candidate',
        created_at: new Date().toISOString()
      }
    };

    await store.create(triageTicket);

    // First fill: should derive TOOL ticket
    const outputs1 = { decision: 'APPROVE', reason: 'Test approval' };
    const toolId1 = await deriveToolTicketFromTriage(triageTicket, outputs1, store);

    assert.ok(toolId1, 'Should create TOOL ticket on first fill');
    console.log(`[Test] First fill created TOOL ticket: ${toolId1}`);

    // Verify TOOL ticket exists
    const toolTicket = await store.get(toolId1);
    assert.ok(toolTicket, 'TOOL ticket should exist');
    assert.strictEqual(toolTicket.id, toolTicket.ticket_id, 'TOOL id should equal ticket_id');
    assert.strictEqual(toolTicket.status, 'pending', 'TOOL status should be pending');
    assert.strictEqual(toolTicket.metadata.kind, 'TOOL', 'TOOL kind should be TOOL');
    assert.strictEqual(toolTicket.metadata.parent_ticket_id, triageId, 'TOOL parent should be TRIAGE id');

    // Verify back-reference (canonical only)
    assert.strictEqual(triageTicket.derived.tool_ticket_id, toolId1, 'Back-reference should be set at ticket.derived');
    assert.ok(!triageTicket.metadata.derived, 'Should not write legacy metadata.derived');
    console.log('[Test] Back-reference verified (canonical only)');

    // Second fill: should NOT derive (idempotent)
    const outputs2 = { decision: 'APPROVE', reason: 'Second approval' };
    const toolId2 = await deriveToolTicketFromTriage(triageTicket, outputs2, store);

    assert.strictEqual(toolId2, null, 'Should NOT create second TOOL ticket (idempotent)');
    console.log('[Test] Second fill correctly skipped derivation (idempotent)');

    // Verify only one TOOL ticket exists
    const allTickets = await store.list({ limit: 100 });
    const toolTickets = allTickets.filter(t => t.metadata?.kind === 'TOOL');
    assert.strictEqual(toolTickets.length, 1, 'Should have exactly one TOOL ticket');

    console.log('[Test] testTriageToolDerivation: PASS ✓');
    return true;

  } catch (err) {
    console.error('[Test] testTriageToolDerivation: FAIL ✗');
    console.error(err);
    return false;
  } finally {
    cleanup();
    delete process.env.ENABLE_TOOL_DERIVATION;
  }
}

/**
 * Test: No derivation when ENABLE_TOOL_DERIVATION is false
 */
async function testNoDerivationWhenDisabled() {
  const fixture = makeTicketStoreFixture();
  const { store, cleanup } = fixture;

  try {
    console.log('[Test] testNoDerivationWhenDisabled: START');

    // Explicitly disable (or leave unset)
    delete process.env.ENABLE_TOOL_DERIVATION;

    // Create TRIAGE ticket
    const triageId = uuidv4();
    const triageTicket = {
      id: triageId,
      ticket_id: triageId,
      type: 'TriageTicket',
      status: 'pending',
      flow_id: 'triage_v1',
      event: { content: 'Test event' },
      metadata: {
        kind: 'TRIAGE',
        candidate_id: 'test-candidate',
        created_at: new Date().toISOString()
      }
    };

    await store.create(triageTicket);

    // Fill with APPROVE but derivation disabled
    const outputs = { decision: 'APPROVE', reason: 'Test' };
    const toolId = await deriveToolTicketFromTriage(triageTicket, outputs, store);

    assert.strictEqual(toolId, null, 'Should NOT derive when disabled');

    // Verify no TOOL tickets
    const allTickets = await store.list({ limit: 100 });
    const toolTickets = allTickets.filter(t => t.metadata?.kind === 'TOOL');
    assert.strictEqual(toolTickets.length, 0, 'Should have zero TOOL tickets');

    console.log('[Test] testNoDerivationWhenDisabled: PASS ✓');
    return true;

  } catch (err) {
    console.error('[Test] testNoDerivationWhenDisabled: FAIL ✗');
    console.error(err);
    return false;
  } finally {
    cleanup();
  }
}

/**
 * Test: No derivation for REJECT decision
 */
async function testNoDerivationOnReject() {
  const fixture = makeTicketStoreFixture();
  const { store, cleanup } = fixture;

  try {
    console.log('[Test] testNoDerivationOnReject: START');

    process.env.ENABLE_TOOL_DERIVATION = 'true';

    // Create TRIAGE ticket
    const triageId = uuidv4();
    const triageTicket = {
      id: triageId,
      ticket_id: triageId,
      type: 'TriageTicket',
      status: 'pending',
      flow_id: 'triage_v1',
      event: { content: 'Test event' },
      metadata: {
        kind: 'TRIAGE',
        candidate_id: 'test-candidate',
        created_at: new Date().toISOString()
      }
    };

    await store.create(triageTicket);

    // Fill with REJECT
    const outputs = { decision: 'REJECT', reason: 'Test rejection' };
    const toolId = await deriveToolTicketFromTriage(triageTicket, outputs, store);

    assert.strictEqual(toolId, null, 'Should NOT derive on REJECT');

    // Verify no back-reference
    assert.ok(!triageTicket.metadata.derived?.tool_ticket_id, 'Should not set back-reference');

    console.log('[Test] testNoDerivationOnReject: PASS ✓');
    return true;

  } catch (err) {
    console.error('[Test] testNoDerivationOnReject: FAIL ✗');
    console.error(err);
    return false;
  } finally {
    cleanup();
    delete process.env.ENABLE_TOOL_DERIVATION;
  }
}

/**
 * Acceptance (S2-D): strict internal reject must not block/mutate parent.
 *
 * Stage 2 hard rule (current):
 *   internal strict reject strategy = skip (do NOT create a child ticket).
 * If product later decides to create a blocked child for observability/UI,
 * update SSOT/guardrails first, then update this test.
 *
 * - Create a TRIAGE ticket that is eligible for derivation
 * - Enable strict schemaGate and derivation
 * - Derivation should be skipped (return null)
 * - Parent ticket must not become blocked/failed, and must not gain derived backref
 * - schemaGate must emit audit + metrics for schema_gate_reject
 */
async function testInternalStrictRejectDoesNotMutateParent() {
  const fixture = makeTicketStoreFixture();
  const { store, cleanup } = fixture;

  const prevMode = process.env.SCHEMA_GATE_MODE;
  const prevDerive = process.env.ENABLE_TOOL_DERIVATION;

  const audit = [];

  try {
    console.log('[Test] testInternalStrictRejectDoesNotMutateParent: START');

    process.env.SCHEMA_GATE_MODE = 'strict';
    process.env.ENABLE_TOOL_DERIVATION = 'true';

    schemaGate.resetMetrics();
    schemaGate.setAuditLogger((e) => audit.push(e));

    const beforeMetrics = schemaGate.getMetrics().schema_strict_reject_total;

    // Create a TRIAGE ticket with a schema-valid event (so only derived payload is the failing surface)
    const triageId = uuidv4();
    const triageTicket = {
      id: triageId,
      ticket_id: triageId,
      type: 'DraftTicket',
      status: 'pending',
      flow_id: 'triage_v1',
      event: {
        type: 'thread_reply',
        thread_id: 'thread-1',
        content: 'Test event content',
        actor: 'tester',
        timestamp: new Date().toISOString()
      },
      metadata: {
        kind: 'TRIAGE',
        candidate_id: 'test-candidate',
        created_at: new Date().toISOString()
      }
    };

    await store.create(triageTicket);

    const parentSnapshot = JSON.parse(JSON.stringify({
      status: triageTicket.status,
      kind: triageTicket.metadata?.kind,
      candidate_id: triageTicket.metadata?.candidate_id,
      created_at: triageTicket.metadata?.created_at
    }));

    const outputs = { decision: 'APPROVE', reason: 'Force derive with strict internal gate' };
    const toolId = await deriveToolTicketFromTriage(triageTicket, outputs, store);

    assert.strictEqual(toolId, null, 'Should skip derivation on strict internal schema reject');

    // Parent must not be blocked/failed, and must not gain derived backrefs.
    // Allow benign observability metadata (e.g. counters) if ever added later.
    assert.strictEqual(triageTicket.status, parentSnapshot.status, 'Parent status must not change');
    assert.notStrictEqual(triageTicket.status, 'blocked', 'Parent must not be blocked by internal strict reject');
    assert.notStrictEqual(triageTicket.status, 'failed', 'Parent must not be failed by internal strict reject');

    assert.strictEqual(triageTicket.metadata?.kind, parentSnapshot.kind, 'Parent kind must not change');
    assert.strictEqual(triageTicket.metadata?.candidate_id, parentSnapshot.candidate_id, 'Parent candidate_id must not change');
    assert.strictEqual(triageTicket.metadata?.created_at, parentSnapshot.created_at, 'Parent created_at must not change');

    assert.ok(!triageTicket.metadata?.block, 'Parent must not gain metadata.block');
    assert.ok(!triageTicket.metadata?.blocked_at, 'Parent must not gain metadata.blocked_at');
    assert.ok(!triageTicket.metadata?.error, 'Parent must not gain metadata.error');

    assert.ok(!triageTicket.derived?.tool_ticket_id, 'Parent must not gain derived.tool_ticket_id');
    assert.ok(!triageTicket.metadata?.derived?.tool_ticket_id, 'Parent must not gain metadata.derived.tool_ticket_id');

    // No TOOL tickets should be created
    const allTickets = await store.list({ limit: 100 });
    const toolTickets = allTickets.filter((t) => t.metadata?.kind === 'TOOL');
    assert.strictEqual(toolTickets.length, 0, 'Should not create TOOL ticket on strict internal reject');

    const afterMetrics = schemaGate.getMetrics().schema_strict_reject_total;
    assert.ok(afterMetrics >= beforeMetrics + 1, 'Should increment schema strict reject total');

    const rejectAudit = audit.find((e) =>
      e.action === 'schema_gate_reject' &&
      e.direction === schemaGate.DIRECTION.INTERNAL &&
      e.boundary === schemaGate.BOUNDARY.TICKET_DERIVE &&
      e.kind === schemaGate.KIND.TOOL &&
      e.code === 'SCHEMA_VALIDATION_FAILED'
    );
    assert.ok(rejectAudit, 'Should emit schema_gate_reject audit entry for internal derive');

    // Harden against false-pass: reject must include actual error detail.
    // (If someone later changes schemaGate to reject without errors, this should fail.)
    assert.ok(Number(rejectAudit.warn_count || 0) > 0, 'reject audit should have warn_count > 0');
    assert.ok(Array.isArray(rejectAudit.warn_codes) && rejectAudit.warn_codes.length > 0, 'reject audit should include non-empty warn_codes');
    assert.ok(Array.isArray(rejectAudit.errors) && rejectAudit.errors.length > 0, 'reject audit should include non-empty errors');

    // The exact warn_code may vary (enum violations are schema_invalid; missing required is missing).
    assert.ok(
      rejectAudit.warn_codes.includes('schema_invalid') || rejectAudit.warn_codes.includes('missing'),
      'reject audit warn_codes should include schema_invalid or missing'
    );

    console.log('[Test] testInternalStrictRejectDoesNotMutateParent: PASS ✓');
    return true;
  } catch (err) {
    console.error('[Test] testInternalStrictRejectDoesNotMutateParent: FAIL ✗');
    console.error(err);
    return false;
  } finally {
    schemaGate.setAuditLogger(null);
    schemaGate.resetMetrics();

    if (prevMode === undefined) delete process.env.SCHEMA_GATE_MODE;
    else process.env.SCHEMA_GATE_MODE = prevMode;

    if (prevDerive === undefined) delete process.env.ENABLE_TOOL_DERIVATION;
    else process.env.ENABLE_TOOL_DERIVATION = prevDerive;

    cleanup();
  }
}

module.exports = {
  testTriageToolDerivation,
  testNoDerivationWhenDisabled,
  testNoDerivationOnReject,
  testInternalStrictRejectDoesNotMutateParent
};
