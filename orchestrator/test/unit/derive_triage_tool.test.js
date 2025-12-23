const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const { makeTicketStoreFixture } = require('./fixtures/ticketStore');
const deriveToolTicketFromTriage = require('../../lib/deriveToolTicketFromTriage');

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

    // Verify back-reference (should be at both canonical and legacy locations)
    assert.strictEqual(triageTicket.derived.tool_ticket_id, toolId1, 'Back-reference should be set at ticket.derived');
    assert.strictEqual(triageTicket.metadata.derived.tool_ticket_id, toolId1, 'Back-reference should also be in metadata.derived (mirror)');
    console.log('[Test] Back-reference verified at both locations (canonical + mirror)');

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

module.exports = {
  testTriageToolDerivation,
  testNoDerivationWhenDisabled,
  testNoDerivationOnReject
};
