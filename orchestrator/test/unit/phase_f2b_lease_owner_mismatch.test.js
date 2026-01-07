/**
 * Phase F2B-1(1): lease_owner_mismatch system-level test
 * 
 * Contract:
 * - Real HTTP pipeline: event→ticket→lease→fill (wrong lease_owner)→complete
 * - Evidence chain: run_report_v1 + evidence_manifest_v1 + manifest_self_hash_v1
 * - Manifest checks[] must contain: reason_code='lease_owner_mismatch' + details_ref→lease_debug_v1
 * - Deterministic failure via test-only env injection
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { startServerWithEnv } = require('./helpers/server');
const { httpPostJson, httpGetJson } = require('./helpers/http');
const { EVIDENCE_REASON_RUNTIME } = require('../../lib/evidence/ssot');

/**
 * Test 1: lease_owner_mismatch via HTTP pipeline with evidence chain verification
 */
async function testLeaseOwnerMismatchEvidence() {
  console.log('[Test] testLeaseOwnerMismatchEvidence: START');

  const testLogsDir = process.env.LOGS_DIR || path.join(require('os').tmpdir(), `f2b_lease_${Date.now()}`);
  fs.mkdirSync(testLogsDir, { recursive: true });

  const { baseUrl, stop } = await startServerWithEnv({
    NODE_ENV: 'test',
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_GUARD_REJECTION_EVIDENCE: '1',
    LOGS_DIR: testLogsDir
  });

  try {
    // Step 1: Create TOOL ticket directly (skip TRIAGE derivation for simplicity)
    // POST /events creates TRIAGE ticket, then we fill it to derive TOOL ticket
    const triageEvent = {
      type: 'thread_post',
      source: 'test-f2b-lease',
      event_id: `f2b_lease_${Date.now()}`,
      content: 'Test lease_owner_mismatch evidence chain',
      features: {
        engagement: { likes: 150, comments: 50 }  // High enough to pass filter (>= 100)
      }
    };

    const eventResp = await httpPostJson(baseUrl, '/events', triageEvent);
    console.log(`[Test] POST /events response: status=${eventResp.status}, data=${JSON.stringify(eventResp.data, null, 2)}`);
    assert.strictEqual(eventResp.status, 200, `POST /events failed: ${eventResp.status}`);
    assert.ok(eventResp.data.ticket_id, `Missing ticket_id from /events. Full response: ${JSON.stringify(eventResp.data)}`);
    const triageTicketId = eventResp.data.ticket_id;

    console.log(`[Test] Created triage ticket: ${triageTicketId}`);

    // Step 2: Lease TRIAGE ticket first
    const triageLeaseResp = await httpPostJson(baseUrl, `/v1/tickets/lease`, {
      kind: 'TRIAGE',
      limit: 10,
      lease_sec: 60
    });
    assert.strictEqual(triageLeaseResp.status, 200, `Lease TRIAGE failed: ${triageLeaseResp.status}`);
    
    const leasedTriage = triageLeaseResp.data.tickets.find(t => t.id === triageTicketId);
    assert.ok(leasedTriage, `TRIAGE ticket ${triageTicketId} not in leased batch`);

    console.log(`[Test] Leased TRIAGE ticket: ${triageTicketId}, lease_owner=${leasedTriage.metadata.lease_owner}`);

    // Step 3: Fill TRIAGE ticket to trigger TOOL derivation
    const triageFillPayload = {
      outputs: {
        decision: 'APPROVE',
        short_reason: 'Test reason for F2B',
        reply_strategy: 'test_strategy'
      },
      by: 'test_fill_triage',
      lease_owner: leasedTriage.metadata.lease_owner,
      lease_token: leasedTriage.metadata.lease_token
    };

    const triageFillResp = await httpPostJson(baseUrl, `/v1/tickets/${triageTicketId}/fill`, triageFillPayload);
    assert.strictEqual(triageFillResp.status, 200, `Fill TRIAGE failed: ${triageFillResp.status}. Response: ${JSON.stringify(triageFillResp.data)}`);

    console.log(`[Test] Filled TRIAGE ticket, should trigger TOOL derivation`);

    // Step 4: Wait for tool derivation to complete (should be synchronous in fill endpoint)
    await sleep(1000);  // Give it a moment to persist

    // Debug: List ALL tickets to see what's available
    const allTicketsResp = await httpGetJson(baseUrl, '/v1/tickets');
    console.log(`[Test] All tickets count: ${allTicketsResp.data?.length || 0}`);
    if (allTicketsResp.data && allTicketsResp.data.length > 0) {
      allTicketsResp.data.forEach((t, idx) => {
        console.log(`[Test] Ticket[${idx}]: id=${t.id}, type=${t.type}, status=${t.status}, parent=${t.metadata?.parent_ticket_id}`);
      });
    }

    // Step 5: Find derived TOOL ticket (parent_ticket_id is in metadata)
    // Note: status is lowercase 'pending' not 'PENDING'
    let toolTicket = null;
    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
      await sleep(200);
      
      const listResp = await httpGetJson(baseUrl, '/v1/tickets?status=pending');
      if (listResp.status !== 200) {
        console.log(`[Test] GET /tickets attempt ${i+1}: status=${listResp.status}`);
        continue;
      }
      
      if (!Array.isArray(listResp.data)) {
        console.log(`[Test] GET /tickets attempt ${i+1}: data not array`);
        continue;
      }
      
      console.log(`[Test] Attempt ${i+1}: found ${listResp.data.length} pending tickets`);
      toolTicket = listResp.data.find(t => t.metadata?.parent_ticket_id === triageTicketId && t.type === 'ToolTicket');
      if (toolTicket) {
        console.log(`[Test] Found derived tool ticket after ${(i+1)*200}ms: ${toolTicket.id}`);
        break;
      }
    }
    
    assert.ok(toolTicket, `No tool ticket derived from ${triageTicketId} after ${maxRetries*200}ms. Check ENABLE_TOOL_DERIVATION env var`);
    const toolTicketId = toolTicket.id;

    console.log(`[Test] Using tool ticket: ${toolTicketId}`);

    // Step 4: Additional wait to ensure ticket is ready for lease
    await sleep(500);

    // Step 4: Lease ticket (Client A) - use batch lease API with kind filter
    const leaseReqPayload = {
      kind: 'TOOL',
      limit: 10,
      lease_sec: 60
    };
    const leaseResp = await httpPostJson(baseUrl, `/v1/tickets/lease`, leaseReqPayload);
    assert.strictEqual(leaseResp.status, 200, `POST /v1/tickets/lease failed: ${leaseResp.status}`);
    assert.ok(leaseResp.data.tickets, 'Missing tickets array');
    assert.ok(leaseResp.data.tickets.length > 0, 'No tickets leased');

    // Find our tool ticket in the leased batch
    const leasedTicket = leaseResp.data.tickets.find(t => t.id === toolTicketId);
    assert.ok(leasedTicket, `Our tool ticket ${toolTicketId} was not in leased batch`);
    assert.ok(leasedTicket.metadata.lease_owner, 'Missing lease_owner');
    assert.ok(leasedTicket.metadata.lease_token, 'Missing lease_token');

    const leaseOwner = leasedTicket.metadata.lease_owner;
    const leaseToken = leasedTicket.metadata.lease_token;

    console.log(`[Test] Leased ticket: owner=${leaseOwner}, token=${leaseToken.slice(0, 8)}...`);

    // Step 5: Attempt to fill with WRONG lease_owner (Client B)
    // Note: fill internally calls complete() - this is the HTTP API for completing tickets
    const wrongOwner = 'test-runner-B-WRONG';
    const fillPayload = {
      outputs: { result: 'should-fail' },
      by: wrongOwner,
      lease_owner: wrongOwner,  // WRONG owner
      lease_token: leaseToken   // Correct token but wrong owner
    };

    const completeResp = await httpPostJson(baseUrl, `/v1/tickets/${toolTicketId}/fill`, fillPayload);
    
    console.log(`[Test] Complete response: status=${completeResp.status}, data=${JSON.stringify(completeResp.data, null, 2)}`);
    
    // Expect rejection (4xx status)
    assert.ok(completeResp.status >= 400, `Expected error status, got ${completeResp.status}`);
    assert.ok(completeResp.data.error_code === 'lease_owner_mismatch', `Expected lease_owner_mismatch code, got ${completeResp.data.error_code}`);

    // Should not surface evidence_error when emission succeeds
    assert.ok(!completeResp.data.evidence_error, `Unexpected evidence_error: ${completeResp.data.evidence_error}`);

    // Evidence reference should be returned for guard rejection
    assert.ok(completeResp.data.evidence_run_id, 'Missing evidence_run_id in guard rejection response');
    const evidenceRunId = completeResp.data.evidence_run_id;

    console.log(`[Test] Complete rejected with status=${completeResp.status}, code=${completeResp.data.code}`);

    // Step 6: Verify evidence chain exists under LOGS_DIR/<evidence_run_id>/
    const runDirPath = path.join(testLogsDir, evidenceRunId);
    assert.ok(fs.existsSync(runDirPath), `Evidence run dir not found: ${runDirPath}`);

    console.log(`[Test] Checking evidence in: ${evidenceRunId}`);

    // Step 7: Verify run_report_v1.json exists
    const runReportPath = path.join(runDirPath, 'run_report_v1.json');
    assert.ok(fs.existsSync(runReportPath), `Missing run_report_v1.json: ${runReportPath}`);
    const runReport = JSON.parse(fs.readFileSync(runReportPath, 'utf8'));
    assert.strictEqual(runReport.version, 'v1', 'Invalid run_report version');

    console.log(`[Test] run_report_v1: terminal_status=${runReport.terminal_status}, run_id=${runReport.run_id}`);

    // Step 8: Verify evidence_manifest_v1.json exists
    const manifestPath = path.join(runDirPath, 'evidence_manifest_v1.json');
    assert.ok(fs.existsSync(manifestPath), `Missing evidence_manifest_v1.json: ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(typeof manifest.run_id === 'string' && manifest.run_id.length >= 8, 'Invalid manifest.run_id');

    console.log(`[Test] evidence_manifest_v1: ${manifest.checks.length} checks, ${manifest.artifacts.length} artifacts`);

    // Step 9: Verify manifest_self_hash_v1.json exists
    const selfHashPath = path.join(runDirPath, 'manifest_self_hash_v1.json');
    assert.ok(fs.existsSync(selfHashPath), `Missing manifest_self_hash_v1.json: ${selfHashPath}`);
    const selfHash = JSON.parse(fs.readFileSync(selfHashPath, 'utf8'));
    assert.strictEqual(selfHash.algo, 'sha256', 'Invalid self_hash algo');
    assert.ok(typeof selfHash.value === 'string' && selfHash.value.length === 64, 'Missing/invalid self_hash value');

    console.log(`[Test] manifest_self_hash_v1: value=${selfHash.value.slice(0, 16)}...`);

    // Step 10: Verify checks[] contains lease_owner_mismatch reason_codes + details_ref
    const leaseCheck = (manifest.checks || []).find((c) => c && c.name === 'guard_rejection_evidence_ok');
    assert.ok(leaseCheck, `No check with name=guard_rejection_evidence_ok. checks=${JSON.stringify(manifest.checks, null, 2)}`);
    assert.ok(Array.isArray(leaseCheck.reason_codes) && leaseCheck.reason_codes.includes(EVIDENCE_REASON_RUNTIME.LEASE_OWNER_MISMATCH), 'guard_rejection_evidence_ok missing lease_owner_mismatch reason code');
    assert.ok(leaseCheck.details_ref, 'Missing details_ref in lease_owner_mismatch check');

    console.log(`[Test] Found lease_owner_mismatch check: name=${leaseCheck.name}, details_ref=${leaseCheck.details_ref}`);

    // Step 11: Verify details_ref points to existing artifact
    const detailsArtifact = (manifest.artifacts || []).find((a) => a && a.path === leaseCheck.details_ref);
    assert.ok(detailsArtifact, `details_ref artifact not found: ${leaseCheck.details_ref}`);
    
    const detailsPath = path.join(runDirPath, leaseCheck.details_ref);
    assert.ok(fs.existsSync(detailsPath), `Details artifact file not found: ${detailsPath}`);

    console.log(`[Test] Details artifact found: ${leaseCheck.details_ref}, sha256=${detailsArtifact.sha256.slice(0, 16)}...`);

    // Step 11b: Verify lease_debug does not contain raw token and has correct hash
    const leaseDebugRaw = fs.readFileSync(detailsPath, 'utf8');
    assert.ok(!leaseDebugRaw.includes(leaseToken), 'lease_debug_v1 must not contain raw lease_token');
    const leaseDebug = JSON.parse(leaseDebugRaw);
    const expectedTokenHash = crypto.createHash('sha256').update(String(leaseToken), 'utf8').digest('hex');
    assert.strictEqual(leaseDebug.lease_token_hash, expectedTokenHash, 'lease_token_hash mismatch');
    assert.strictEqual(leaseDebug.ticket_id, toolTicketId, 'lease_debug ticket_id mismatch');
    assert.strictEqual(leaseDebug.lease_owner_provided, wrongOwner, 'lease_owner_provided mismatch');

    // Step 12: Verify mode_snapshot_ref exists and points to run_report_v1.json
    assert.ok(manifest.mode_snapshot_ref, 'Missing mode_snapshot_ref');
    assert.strictEqual(manifest.mode_snapshot_ref, 'run_report_v1.json', 'mode_snapshot_ref should be run_report_v1.json');

    console.log(`[Test] mode_snapshot_ref: ${manifest.mode_snapshot_ref}`);

    console.log('[Test] testLeaseOwnerMismatchEvidence: PASS ✓');
    return true;

  } finally {
    await stop();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  testLeaseOwnerMismatchEvidence
};
