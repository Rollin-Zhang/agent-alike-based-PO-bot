/**
 * S2-D: TicketStore State Machine Tests
 * 
 * 測試 Stage 2 的狀態機:
 *   pending → running → done | failed | blocked
 */
const assert = require('assert');
const TicketStore = require('../../store/TicketStore');
const { TICKET_STATUS, VALID_TRANSITIONS } = require('../../store/TicketStore');
const { cutoverMetrics } = require('../../lib/compat/cutoverMetrics');

// Helper to create test tickets with proper structure
let ticketCounter = 0;
function createTestTicket(kind = 'TOOL', extra = {}) {
  ticketCounter++;
  return {
    id: `test-ticket-${ticketCounter}`,
    metadata: {
      kind,
      source: 'test',
      ...extra.metadata
    },
    inputs: extra.inputs || { prompt: 'test' },
    ...extra
  };
}

// ============================================================
// D-1: TICKET_STATUS enum
// ============================================================
function testTicketStatusEnumValues() {
  assert.strictEqual(TICKET_STATUS.PENDING, 'pending');
  assert.strictEqual(TICKET_STATUS.RUNNING, 'running');
  assert.strictEqual(TICKET_STATUS.DONE, 'done');
  assert.strictEqual(TICKET_STATUS.FAILED, 'failed');
  assert.strictEqual(TICKET_STATUS.BLOCKED, 'blocked');
  // Legacy aliases
  assert.strictEqual(TICKET_STATUS.LEASED, 'running'); // maps to running
  assert.strictEqual(TICKET_STATUS.COMPLETED, 'completed'); // kept for compat
  console.log('✅ testTicketStatusEnumValues');
}

function testValidTransitionsExist() {
  assert(VALID_TRANSITIONS.pending, 'pending should have transitions');
  assert(VALID_TRANSITIONS.running, 'running should have transitions');
  assert(VALID_TRANSITIONS.done, 'done should have transitions');
  assert(VALID_TRANSITIONS.failed, 'failed should have transitions');
  assert(VALID_TRANSITIONS.blocked, 'blocked should have transitions');
  
  // done is terminal
  assert.deepStrictEqual(VALID_TRANSITIONS.done, []);
  console.log('✅ testValidTransitionsExist');
}

// ============================================================
// D-2: lease() transitions pending → running
// ============================================================
async function testLeaseTransitionsPendingToRunning() {
  const store = new TicketStore();
  
  // Create a pending ticket
  const ticket = await store.create(createTestTicket('TOOL'));
  
  assert.strictEqual(ticket.status, TICKET_STATUS.PENDING);
  
  // Lease it
  const leased = await store.lease('TOOL', 1, 60);
  assert.strictEqual(leased.length, 1);
  assert.strictEqual(leased[0].status, TICKET_STATUS.RUNNING); // not 'leased'
  assert.ok(leased[0].metadata.leased_at, 'should have leased_at');
  assert.ok(leased[0].metadata.lease_expires, 'should have lease_expires');
  assert.ok(leased[0].metadata.lease_owner, 'should have lease_owner');
  assert.ok(leased[0].metadata.lease_token, 'should have lease_token');
  
  // lease_expires should be epoch ms (number)
  assert.strictEqual(typeof leased[0].metadata.lease_expires, 'number');
  
  console.log('✅ testLeaseTransitionsPendingToRunning');
}

async function testLeaseOnlyPicksPending() {
  const store = new TicketStore();
  
  // Create and complete a ticket
  const t1 = await store.create(createTestTicket('TOOL'));
  t1.status = TICKET_STATUS.DONE; // manually set to done
  
  // Create a pending ticket
  const t2 = await store.create(createTestTicket('TOOL'));
  
  // Lease should only pick t2
  const leased = await store.lease('TOOL', 10, 60);
  assert.strictEqual(leased.length, 1);
  assert.strictEqual(leased[0].id, t2.id);
  
  console.log('✅ testLeaseOnlyPicksPending');
}

// ============================================================
// D-3: complete() transitions running → done
// ============================================================
async function testCompleteFromPendingAllowed() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  assert.strictEqual(ticket.status, TICKET_STATUS.PENDING);
  
  // Direct fill without lease should work
  const completed = await store.complete(ticket.id, { result: 'direct', tool_verdict: 'PROCEED' }, 'http_fill');
  
  assert.strictEqual(completed.status, TICKET_STATUS.DONE);
  assert.ok(completed.metadata.completed_at);
  assert.ok(completed.tool_verdict && completed.tool_verdict.status === 'PROCEED', 'should write canonical ticket.tool_verdict');
  
  console.log('✅ testCompleteFromPendingAllowed');
}

async function testCompleteEmitsCanonicalMissingWhenAbsent() {
  const store = new TicketStore();
  cutoverMetrics.reset();

  const ticket = await store.create(createTestTicket('TOOL'));
  const completed = await store.complete(ticket.id, { result: 'direct' }, 'http_fill');

  assert.strictEqual(completed.status, TICKET_STATUS.DONE);
  assert.strictEqual(completed.tool_verdict, undefined, 'should not backfill null canonical tool_verdict');

  const snap = cutoverMetrics.snapshot();
  const hit = (snap.counters || []).find((r) => r.event_type === 'canonical_missing' && r.field === 'tool_verdict');
  assert.ok(hit && hit.count >= 1, 'should increment canonical_missing counter');

  console.log('✅ testCompleteEmitsCanonicalMissingWhenAbsent');
}

async function testCompleteFromPendingRejectsMissingBy() {
  const store = new TicketStore();
  const ticket = await store.create(createTestTicket('TOOL'));

  const result = await store.complete(ticket.id, { result: 'direct' }, undefined);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'direct_fill_missing_by');
  assert.strictEqual(ticket.status, TICKET_STATUS.PENDING);

  console.log('✅ testCompleteFromPendingRejectsMissingBy');
}

async function testCompleteFromPendingRejectsNonAllowlistedBy() {
  const store = new TicketStore();
  const ticket = await store.create(createTestTicket('TOOL'));

  const result = await store.complete(ticket.id, { result: 'direct' }, 'api');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'direct_fill_not_allowed');
  assert.strictEqual(ticket.status, TICKET_STATUS.PENDING);

  console.log('✅ testCompleteFromPendingRejectsNonAllowlistedBy');
}

async function testCompleteRunningRejectsLeaseMismatch() {
  const store = new TicketStore();
  const ticket = await store.create(createTestTicket('TOOL'));

  const leased = await store.lease('TOOL', 1, 60);
  const leaseOwner = leased[0].metadata.lease_owner;

  const before = store.getGuardMetrics().ticket_store_guard_reject_total
    .find((m) => m.labels?.code === 'lease_owner_mismatch' && m.labels?.action === 'complete_lease_owner_mismatch')
    ?.value || 0;

  const audit = [];
  TicketStore.setAuditLogger((e) => audit.push(e));

  const result = await store.complete(ticket.id, { result: 'x' }, 'runner', { lease_owner: leaseOwner, lease_token: 'wrong-token' });
  TicketStore.setAuditLogger(null);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'lease_owner_mismatch');
  assert.strictEqual(ticket.status, TICKET_STATUS.RUNNING);

  const after = store.getGuardMetrics().ticket_store_guard_reject_total
    .find((m) => m.labels?.code === 'lease_owner_mismatch' && m.labels?.action === 'complete_lease_owner_mismatch')
    ?.value || 0;
  assert.ok(after >= before + 1, 'should increment lease_owner_mismatch metric');

  assert.ok(
    audit.some((e) => e.action === 'ticket_store_guard_reject' && e.code === 'lease_owner_mismatch'),
    'should emit ticket_store_guard_reject audit'
  );

  console.log('✅ testCompleteRunningRejectsLeaseMismatch');
}

async function testCompleteTransitionsRunningToDone() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  // Lease first
  const leased = await store.lease('TOOL', 1, 60);
  const leaseOwner = leased[0].metadata.lease_owner;
  const leaseToken = leased[0].metadata.lease_token;
  
  // Complete
  const completed = await store.complete(ticket.id, { result: 'success', tool_verdict: { status: 'DEFER', reason: 'x' } }, 'runner', { lease_owner: leaseOwner, lease_token: leaseToken });
  
  assert.strictEqual(completed.status, TICKET_STATUS.DONE); // not 'completed'
  assert.ok(completed.metadata.completed_at);
  assert.strictEqual(completed.metadata.completed_by, 'runner');
  assert.deepStrictEqual(completed.metadata.final_outputs, { result: 'success', tool_verdict: { status: 'DEFER', reason: 'x' } });
  assert.ok(completed.tool_verdict && completed.tool_verdict.status === 'DEFER', 'should write canonical ticket.tool_verdict');
  // Lease metadata should be cleaned up
  assert.strictEqual(completed.metadata.lease_expires, undefined);
  assert.strictEqual(completed.metadata.leased_at, undefined);
  assert.strictEqual(completed.metadata.lease_owner, undefined);
  assert.strictEqual(completed.metadata.lease_token, undefined);
  
  console.log('✅ testCompleteTransitionsRunningToDone');
}

async function testCompleteIsIdempotentOnDone() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  // Complete once
  await store.complete(ticket.id, { first: true }, 'http_fill');
  assert.strictEqual(ticket.status, TICKET_STATUS.DONE);
  
  // Complete again (idempotent - should not throw, but won't update)
  const result = await store.complete(ticket.id, { second: true }, 'runner2');
  assert.strictEqual(result.status, TICKET_STATUS.DONE);
  // Original outputs preserved (not overwritten)
  assert.deepStrictEqual(result.metadata.final_outputs, { first: true });
  
  console.log('✅ testCompleteIsIdempotentOnDone');
}

async function testCompleteRejectsFailed() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  // Set to 'failed' state
  const leased = await store.lease('TOOL', 1, 60);
  await store.fail(ticket.id, 'some error', 'runner', {
    lease_owner: leased[0].metadata.lease_owner,
    lease_token: leased[0].metadata.lease_token
  });
  
  // Try to complete a failed ticket - should throw
  try {
    await store.complete(ticket.id, {}, 'runner');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('not running or pending'));
  }
  
  console.log('✅ testCompleteRejectsFailed');
}

// ============================================================
// D-4: fail() transitions running → failed
// ============================================================
async function testFailTransitionsRunningToFailed() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  const leased = await store.lease('TOOL', 1, 60);
  
  const failed = await store.fail(ticket.id, 'MCP connection timeout', 'runner', {
    lease_owner: leased[0].metadata.lease_owner,
    lease_token: leased[0].metadata.lease_token
  });
  
  assert.strictEqual(failed.status, TICKET_STATUS.FAILED);
  assert.ok(failed.metadata.failed_at);
  assert.strictEqual(failed.metadata.failed_by, 'runner');
  assert.strictEqual(failed.metadata.error, 'MCP connection timeout');
  
  console.log('✅ testFailTransitionsRunningToFailed');
}

// ============================================================
// D-5: block() transitions to blocked
// ============================================================
async function testBlockFromPending() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  const blocked = await store.block(ticket.id, {
    code: 'schema_strict_reject',
    reason: 'schemaGate strict rejection',
    source: 'schemaGate.internal.ticket_derive'
  });
  
  assert.strictEqual(blocked.status, TICKET_STATUS.BLOCKED);
  assert.ok(blocked.metadata.blocked_at);
  assert.strictEqual(blocked.metadata.block.code, 'schema_strict_reject');
  assert.strictEqual(blocked.metadata.block.reason, 'schemaGate strict rejection');
  assert.strictEqual(blocked.metadata.block.source, 'schemaGate.internal.ticket_derive');
  
  console.log('✅ testBlockFromPending');
}

async function testBlockFromRunning() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  await store.lease('TOOL', 1, 60);
  
  const blocked = await store.block(ticket.id, {
    code: 'policy_reject',
    reason: 'policy rejection',
    source: 'policyGate'
  });
  
  assert.strictEqual(blocked.status, TICKET_STATUS.BLOCKED);
  assert.strictEqual(blocked.metadata.lease_expires, undefined); // cleaned up
  assert.strictEqual(blocked.metadata.lease_owner, undefined);
  assert.strictEqual(blocked.metadata.lease_token, undefined);
  
  console.log('✅ testBlockFromRunning');
}

// ============================================================
// D-6: unblock() transitions blocked → pending
// ============================================================
async function testUnblockTransitionsBlockedToPending() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  await store.block(ticket.id, {
    code: 'schema_strict_reject',
    reason: 'schema error',
    source: 'schemaGate'
  });
  
  const unblocked = await store.unblock(ticket.id, 'admin');
  
  assert.strictEqual(unblocked.status, TICKET_STATUS.PENDING);
  assert.ok(unblocked.metadata.unblocked_at);
  assert.strictEqual(unblocked.metadata.unblocked_by, 'admin');
  // Block history should be preserved
  assert.strictEqual(unblocked.metadata.block.reason, 'schema error');
  
  console.log('✅ testUnblockTransitionsBlockedToPending');
}

async function testUnblockRejectsNonBlocked() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  try {
    await store.unblock(ticket.id, 'admin');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('not blocked'));
  }
  
  console.log('✅ testUnblockRejectsNonBlocked');
}

// ============================================================
// D-7: retry() transitions failed → pending
// ============================================================
async function testRetryTransitionsFailedToPending() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  let leased = await store.lease('TOOL', 1, 60);
  await store.fail(ticket.id, 'timeout', 'runner', {
    lease_owner: leased[0].metadata.lease_owner,
    lease_token: leased[0].metadata.lease_token
  });
  
  const retried = await store.retry(ticket.id, 'scheduler');
  
  assert.strictEqual(retried.status, TICKET_STATUS.PENDING);
  assert.ok(retried.metadata.retry_at);
  assert.strictEqual(retried.metadata.retry_by, 'scheduler');
  assert.strictEqual(retried.metadata.retry_count, 1);
  assert.strictEqual(retried.metadata.error, undefined); // cleared
  
  // Retry again
  leased = await store.lease('TOOL', 1, 60);
  await store.fail(ticket.id, 'timeout again', 'runner', {
    lease_owner: leased[0].metadata.lease_owner,
    lease_token: leased[0].metadata.lease_token
  });
  const retried2 = await store.retry(ticket.id, 'scheduler');
  assert.strictEqual(retried2.metadata.retry_count, 2);
  
  console.log('✅ testRetryTransitionsFailedToPending');
}

// ============================================================
// D-8: release() transitions running → pending
// ============================================================
async function testReleaseTransitionsRunningToPending() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  const leased = await store.lease('TOOL', 1, 60);
  assert.strictEqual(ticket.status, TICKET_STATUS.RUNNING);
  
  const released = await store.release(ticket.id, {
    lease_owner: leased[0].metadata.lease_owner,
    lease_token: leased[0].metadata.lease_token
  });
  
  assert.strictEqual(released.status, TICKET_STATUS.PENDING);
  assert.strictEqual(released.metadata.lease_expires, undefined);
  assert.strictEqual(released.metadata.leased_at, undefined);
  assert.strictEqual(released.metadata.lease_owner, undefined);
  assert.strictEqual(released.metadata.lease_token, undefined);
  
  console.log('✅ testReleaseTransitionsRunningToPending');
}

// ============================================================
// D-9: releaseExpiredLeases() handles epoch ms
// ============================================================
async function testReleaseExpiredLeasesEpochMs() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  // Manually set an expired lease (epoch ms in the past)
  ticket.status = TICKET_STATUS.RUNNING;
  ticket.metadata.lease_expires = Date.now() - 1000; // 1 second ago
  
  const released = await store.releaseExpiredLeases();
  assert.strictEqual(released, 1);
  assert.strictEqual(ticket.status, TICKET_STATUS.PENDING);
  
  console.log('✅ testReleaseExpiredLeasesEpochMs');
}

async function testReleaseExpiredLeasesLegacyIsoString() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  // Manually set an expired lease (legacy ISO string)
  ticket.status = TICKET_STATUS.RUNNING;
  ticket.metadata.lease_expires = new Date(Date.now() - 1000).toISOString();
  
  const released = await store.releaseExpiredLeases();
  assert.strictEqual(released, 1);
  assert.strictEqual(ticket.status, TICKET_STATUS.PENDING);
  
  console.log('✅ testReleaseExpiredLeasesLegacyIsoString');
}

// ============================================================
// D-10: countByStatus()
// ============================================================
async function testCountByStatus() {
  const store = new TicketStore();
  
  // Create various tickets
  const t1 = await store.create(createTestTicket('TOOL'));
  const t2 = await store.create(createTestTicket('TOOL'));
  const t3 = await store.create(createTestTicket('TOOL'));
  const t4 = await store.create(createTestTicket('TOOL'));
  
  // Set various statuses
  await store.lease('TOOL', 1, 60); // t1 → running
  // Capture lease proof from t1
  const t1LeaseOwner = t1.metadata.lease_owner;
  const t1LeaseToken = t1.metadata.lease_token;
  await store.complete(t1.id, {}, 'runner', { lease_owner: t1LeaseOwner, lease_token: t1LeaseToken }); // t1 → done
  await store.lease('TOOL', 1, 60); // t2 → running
  const t2LeaseOwner = t2.metadata.lease_owner;
  const t2LeaseToken = t2.metadata.lease_token;
  await store.fail(t2.id, 'error', 'runner', { lease_owner: t2LeaseOwner, lease_token: t2LeaseToken }); // t2 → failed
  await store.block(t3.id, { code: 'gate_reject', reason: 'reason', source: 'gate' }); // t3 → blocked
  // t4 stays pending
  
  const counts = await store.countByStatus();
  
  assert.strictEqual(counts[TICKET_STATUS.PENDING], 1);
  assert.strictEqual(counts[TICKET_STATUS.RUNNING], 0);
  assert.strictEqual(counts[TICKET_STATUS.DONE], 1);
  assert.strictEqual(counts[TICKET_STATUS.FAILED], 1);
  assert.strictEqual(counts[TICKET_STATUS.BLOCKED], 1);
  
  console.log('✅ testCountByStatus');
}

// ============================================================
// D-11: Legacy compat - 'leased' status still works
// ============================================================
async function testLegacyLeasedStatusStillWorks() {
  const store = new TicketStore();
  
  const ticket = await store.create(createTestTicket('TOOL'));
  
  // Manually set to legacy 'leased' status
  ticket.status = 'leased';
  
  // complete() should still work
  const completed = await store.complete(ticket.id, { legacy: true }, 'runner');
  assert.strictEqual(completed.status, TICKET_STATUS.DONE);
  
  console.log('✅ testLegacyLeasedStatusStillWorks');
}

// ============================================================
// Run all tests
// ============================================================
async function runAll() {
  console.log('\n🧪 S2-D: TicketStore State Machine Tests\n');
  
  // Enum tests
  testTicketStatusEnumValues();
  testValidTransitionsExist();
  
  // lease tests
  await testLeaseTransitionsPendingToRunning();
  await testLeaseOnlyPicksPending();
  
  // complete tests
  await testCompleteFromPendingAllowed();
  await testCompleteEmitsCanonicalMissingWhenAbsent();
  await testCompleteFromPendingRejectsMissingBy();
  await testCompleteFromPendingRejectsNonAllowlistedBy();
  await testCompleteTransitionsRunningToDone();
  await testCompleteRunningRejectsLeaseMismatch();
  await testCompleteIsIdempotentOnDone();
  await testCompleteRejectsFailed();
  
  // fail tests
  await testFailTransitionsRunningToFailed();
  
  // block tests
  await testBlockFromPending();
  await testBlockFromRunning();
  
  // unblock tests
  await testUnblockTransitionsBlockedToPending();
  await testUnblockRejectsNonBlocked();
  
  // retry tests
  await testRetryTransitionsFailedToPending();
  
  // release tests
  await testReleaseTransitionsRunningToPending();
  
  // TTL tests
  await testReleaseExpiredLeasesEpochMs();
  await testReleaseExpiredLeasesLegacyIsoString();
  
  // count tests
  await testCountByStatus();
  
  // legacy compat tests
  await testLegacyLeasedStatusStillWorks();
  
  console.log('\n✅ All S2-D tests passed! (19 tests)\n');
}

module.exports = { runAll };
