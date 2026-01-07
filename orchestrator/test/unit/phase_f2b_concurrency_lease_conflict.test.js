/**
 * Phase F2B: concurrency=3 lease mutual exclusion (system-level HTTP pipeline)
 *
 * Goal (MVP): stabilize contract first, without evidence emission.
 *
 * Steps:
 * 1) POST /events → TRIAGE ticket
 * 2) lease TRIAGE (batch) → fill TRIAGE → derive TOOL
 * 3) For the same TOOL ticket, run 3 concurrent lease attempts with different owners
 *    - exactly 1 should succeed (200)
 *    - remaining 2 should be 409 with stable_code/error_code = lease_conflict
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { startServerWithEnv } = require('./helpers/server');
const { httpPostJson, httpGetJson } = require('./helpers/http');

async function testConcurrencyLeaseConflict3() {
  console.log('[Test] testConcurrencyLeaseConflict3: START');

  const testLogsDir = process.env.LOGS_DIR || path.join(require('os').tmpdir(), `f2b_concurrency_${Date.now()}`);
  fs.mkdirSync(testLogsDir, { recursive: true });

  const testDbPath = path.join(testLogsDir, 'test_tickets.db');

  const { baseUrl, stop } = await startServerWithEnv({
    NODE_ENV: 'test',
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    // Concurrency contract test: do NOT enable guard evidence by default
    ENABLE_GUARD_REJECTION_EVIDENCE: '0',
    LOGS_DIR: testLogsDir,
    TICKETSTORE_PATH: testDbPath
  });

  try {
    // Step 1: Create TRIAGE ticket
    const triageEvent = {
      type: 'thread_post',
      source: 'test-f2b-concurrency',
      event_id: `f2b_concurrency_${Date.now()}`,
      content: 'Test concurrency lease mutual exclusion',
      // Must pass ingest threshold to actually create TRIAGE ticket
      features: { engagement: { likes: 150, comments: 50 } }
    };

    const eventResp = await httpPostJson(baseUrl, '/events', triageEvent);
    assert.strictEqual(eventResp.status, 200, `POST /events failed: ${eventResp.status}`);
    const parsed = typeof eventResp.data === 'string' ? safeJsonParse(eventResp.data) : eventResp.data;
    const triageTicketId = parsed && typeof parsed === 'object'
      ? (parsed.ticket_id || parsed.ticketId || parsed.id)
      : undefined;
    if (!triageTicketId) {
      console.log('[Test] /events unexpected body:', eventResp.data);
    }
    assert.ok(triageTicketId, 'Missing triage ticket_id');

    // Step 2: Lease TRIAGE (batch)
    const triageLeaseResp = await httpPostJson(baseUrl, '/v1/tickets/lease', {
      kind: 'TRIAGE',
      limit: 10,
      lease_sec: 60
    });
    assert.strictEqual(triageLeaseResp.status, 200);

    const leasedTriage = (triageLeaseResp.data.tickets || []).find(t => t.id === triageTicketId);
    assert.ok(leasedTriage, 'TRIAGE ticket not found in leased batch');

    // Step 3: Fill TRIAGE to derive TOOL
    const triageFillResp = await httpPostJson(baseUrl, `/v1/tickets/${triageTicketId}/fill`, {
      outputs: {
        decision: 'APPROVE',
        short_reason: 'Test concurrency lease',
        reply_strategy: 'test'
      },
      by: 'test_fill_triage',
      lease_owner: leasedTriage.metadata.lease_owner,
      lease_token: leasedTriage.metadata.lease_token
    });
    assert.strictEqual(triageFillResp.status, 200);

    await sleep(1000);

    // Step 4: Find derived TOOL ticket
    const allTicketsResp = await httpGetJson(baseUrl, '/v1/tickets');
    assert.strictEqual(allTicketsResp.status, 200);

    const toolTickets = (allTicketsResp.data || []).filter(t => t.type === 'ToolTicket' && t.metadata?.parent_ticket_id === triageTicketId);
    assert.ok(toolTickets.length > 0, 'No TOOL ticket derived');
    const toolTicket = toolTickets[0];

    // Step 5: Concurrency=3 targeted lease attempts
    const owners = ['lease_owner_A', 'lease_owner_B', 'lease_owner_C'];

    const attempts = owners.map((owner) => httpPostJson(baseUrl, `/v1/tickets/${toolTicket.id}/lease`, {
      lease_sec: 60,
      lease_owner: owner
    }));

    const results = await Promise.all(attempts);

    const ok = results.filter(r => r.status === 200);
    const conflicts = results.filter(r => r.status === 409);

    assert.strictEqual(ok.length, 1, `Expected exactly 1 successful lease, got ${ok.length}`);
    assert.strictEqual(conflicts.length, 2, `Expected exactly 2 conflicts, got ${conflicts.length}`);

    // Success payload contract
    assert.ok(ok[0].data && ok[0].data.status === 'leased', '200 payload.status should be leased');
    assert.ok(ok[0].data.ticket && ok[0].data.ticket.metadata, '200 payload.ticket missing');
    assert.ok(ok[0].data.ticket.metadata.lease_owner, 'leased ticket missing lease_owner');
    assert.ok(ok[0].data.ticket.metadata.lease_token, 'leased ticket missing lease_token');

    // Conflict payload contract
    for (const c of conflicts) {
      assert.ok(c.data && c.data.status === 'rejected', '409 payload.status should be rejected');
      assert.strictEqual(c.data.error_code, 'lease_conflict');
      assert.strictEqual(c.data.stable_code, 'lease_conflict');
    }

    // Sanity: ensure stored lease_owner equals the winner
    const ticketAfter = await httpGetJson(baseUrl, `/v1/tickets/${toolTicket.id}`);
    assert.strictEqual(ticketAfter.status, 200);
    const winnerOwner = ok[0].data.ticket.metadata.lease_owner;
    assert.strictEqual(ticketAfter.data.metadata.lease_owner, winnerOwner);

    console.log('[Test] testConcurrencyLeaseConflict3: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = { testConcurrencyLeaseConflict3 };
