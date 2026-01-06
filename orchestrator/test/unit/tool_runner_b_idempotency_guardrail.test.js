const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const { makeTicketStoreFixture } = require('./fixtures/ticketStore');

/**
 * Guardrail (M2-B.3-2): lease mutual exclusion
 * - running tickets must not be leased by another owner
 * - release/complete must enforce lease proof when lease_token exists
 */
async function testLeaseMutualExclusionAndLeaseProof() {
  const fixture = makeTicketStoreFixture();
  const { store, cleanup } = fixture;

  try {
    console.log('[Test] testLeaseMutualExclusionAndLeaseProof: START');

    const toolId = uuidv4();
    const toolTicket = {
      id: toolId,
      ticket_id: toolId,
      type: 'DraftTicket',
      status: 'pending',
      flow_id: 'tool_v1',
      event: { content: 'tool event' },
      metadata: {
        kind: 'TOOL',
        created_at: new Date().toISOString()
      }
    };

    await store.create(toolTicket);

    const leasedA = await store.lease('TOOL', 1, 300, 'ownerA');
    assert.strictEqual(leasedA.length, 1, 'ownerA should lease the pending ticket');
    assert.strictEqual(leasedA[0].id, toolId);
    assert.strictEqual(leasedA[0].status, 'running');

    const leaseProofA = {
      lease_owner: leasedA[0].metadata.lease_owner,
      lease_token: leasedA[0].metadata.lease_token
    };

    // Another owner must not be able to lease while running
    const leasedB = await store.lease('TOOL', 1, 300, 'ownerB');
    assert.strictEqual(leasedB.length, 0, 'ownerB must not lease a running ticket');

    // Release with wrong proof should be rejected (guardrail)
    const badRelease = await store.release(toolId, { lease_owner: 'ownerB', lease_token: 'wrong' });
    assert.strictEqual(badRelease.ok, false, 'release must reject with wrong lease proof');
    assert.strictEqual(badRelease.code, 'lease_owner_mismatch');

    // Correct release should succeed
    const released = await store.release(toolId, leaseProofA);
    assert.strictEqual(released.status, 'pending', 'release should move running -> pending');

    const leasedBAfter = await store.lease('TOOL', 1, 300, 'ownerB');
    assert.strictEqual(leasedBAfter.length, 1, 'ownerB should lease after release');
    assert.strictEqual(leasedBAfter[0].id, toolId);

    console.log('[Test] testLeaseMutualExclusionAndLeaseProof: PASS ✓');
    return true;
  } catch (err) {
    console.error('[Test] testLeaseMutualExclusionAndLeaseProof: FAIL ✗');
    console.error(err);
    return false;
  } finally {
    cleanup();
  }
}

/**
 * Guardrail (M2-B.3-2): executor rerun idempotency
 * - DONE tickets must not be leased again (lease() selects pending only)
 * - complete() must be idempotent and must not overwrite final_outputs
 */
async function testDoneTicketNotReLeasedAndCompleteNotOverwritten() {
  const fixture = makeTicketStoreFixture();
  const { store, cleanup } = fixture;

  try {
    console.log('[Test] testDoneTicketNotReLeasedAndCompleteNotOverwritten: START');

    const toolId = uuidv4();
    const toolTicket = {
      id: toolId,
      ticket_id: toolId,
      type: 'DraftTicket',
      status: 'pending',
      flow_id: 'tool_v1',
      event: { content: 'tool event' },
      metadata: {
        kind: 'TOOL',
        created_at: new Date().toISOString()
      }
    };

    await store.create(toolTicket);

    const leased = await store.lease('TOOL', 1, 300, 'ownerA');
    assert.strictEqual(leased.length, 1);

    const leaseProof = {
      lease_owner: leased[0].metadata.lease_owner,
      lease_token: leased[0].metadata.lease_token
    };

    const outputs1 = { tool_verdict: { status: 'PROCEED' }, marker: 'first' };
    const done1 = await store.complete(toolId, outputs1, 'tool_runner_b', leaseProof);
    assert.strictEqual(done1.status, 'done');
    assert.deepStrictEqual(done1.metadata.final_outputs, outputs1);

    // Rerun property 1: done tickets are not leased again
    const leasedAgain = await store.lease('TOOL', 1, 300, 'ownerB');
    assert.strictEqual(leasedAgain.length, 0, 'DONE ticket must not be leased again');

    // Rerun property 2: complete is idempotent and must not overwrite final_outputs
    const outputs2 = { tool_verdict: { status: 'DEFER' }, marker: 'second' };
    const done2 = await store.complete(toolId, outputs2, 'tool_runner_b', { lease_owner: 'x', lease_token: 'y' });
    assert.strictEqual(done2.status, 'done');
    assert.deepStrictEqual(done2.metadata.final_outputs, outputs1, 'final_outputs must not be overwritten on idempotent complete');

    console.log('[Test] testDoneTicketNotReLeasedAndCompleteNotOverwritten: PASS ✓');
    return true;
  } catch (err) {
    console.error('[Test] testDoneTicketNotReLeasedAndCompleteNotOverwritten: FAIL ✗');
    console.error(err);
    return false;
  } finally {
    cleanup();
  }
}

module.exports = {
  testLeaseMutualExclusionAndLeaseProof,
  testDoneTicketNotReLeasedAndCompleteNotOverwritten
};
