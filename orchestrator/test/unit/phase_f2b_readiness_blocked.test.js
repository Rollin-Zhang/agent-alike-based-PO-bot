/**
 * Phase F2B-1(3): readiness_blocked system-level test
 *
 * Contract:
 * - Real HTTP pipeline: event→ticket→lease→fill (TOOL)
 * - Readiness gating enabled for TOOL fill (test-only env)
 * - Evidence chain: run_report_v1 + evidence_manifest_v1 + manifest_self_hash_v1
 * - Extra artifacts: dep_snapshot_v1.json + readiness_debug_v1.json
 * - Manifest checks[] must contain: reason_code='readiness_blocked' + details_ref→readiness_debug_v1
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { startServerWithEnv } = require('./helpers/server');
const { httpPostJson, httpGetJson } = require('./helpers/http');
const { EVIDENCE_REASON_RUNTIME } = require('../../lib/evidence/ssot');

async function testReadinessBlockedEvidence() {
  console.log('[Test] testReadinessBlockedEvidence: START');

  const testLogsDir = process.env.LOGS_DIR || path.join(require('os').tmpdir(), `f2b_ready_${Date.now()}`);
  fs.mkdirSync(testLogsDir, { recursive: true });

  const { baseUrl, stop } = await startServerWithEnv({
    NODE_ENV: 'test',
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_GUARD_REJECTION_EVIDENCE: '1',
    ENABLE_FILL_READINESS_GATE: '1',
    LOGS_DIR: testLogsDir
  });

  try {
    // Step 1: Create TRIAGE ticket
    const triageEvent = {
      type: 'thread_post',
      source: 'test-f2b-readiness',
      event_id: `f2b_ready_${Date.now()}`,
      content: 'Test readiness_blocked evidence chain',
      features: {
        engagement: { likes: 150, comments: 50 }
      }
    };

    const eventResp = await httpPostJson(baseUrl, '/events', triageEvent);
    assert.strictEqual(eventResp.status, 200, `POST /events failed: ${eventResp.status}`);
    assert.ok(eventResp.data.ticket_id, 'Missing ticket_id from /events');
    const triageTicketId = eventResp.data.ticket_id;

    // Step 2: Lease TRIAGE
    const triageLeaseResp = await httpPostJson(baseUrl, `/v1/tickets/lease`, {
      kind: 'TRIAGE',
      limit: 10,
      lease_sec: 60
    });
    assert.strictEqual(triageLeaseResp.status, 200, `Lease TRIAGE failed: ${triageLeaseResp.status}`);

    const leasedTriage = triageLeaseResp.data.tickets.find(t => t.id === triageTicketId);
    assert.ok(leasedTriage, `TRIAGE ticket ${triageTicketId} not in leased batch`);

    // Step 3: Fill TRIAGE to derive TOOL
    const triageFillResp = await httpPostJson(baseUrl, `/v1/tickets/${triageTicketId}/fill`, {
      outputs: {
        decision: 'APPROVE',
        short_reason: 'Test readiness blocked',
        reply_strategy: 'test_strategy'
      },
      by: 'test_fill_triage',
      lease_owner: leasedTriage.metadata.lease_owner,
      lease_token: leasedTriage.metadata.lease_token
    });
    assert.strictEqual(triageFillResp.status, 200, `Fill TRIAGE failed: ${triageFillResp.status}`);

    await sleep(800);

    // Step 4: Find derived TOOL ticket
    let toolTicket = null;
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const listResp = await httpGetJson(baseUrl, '/v1/tickets?status=pending');
      if (listResp.status !== 200 || !Array.isArray(listResp.data)) continue;
      toolTicket = listResp.data.find(t => t.metadata?.parent_ticket_id === triageTicketId && t.type === 'ToolTicket');
      if (toolTicket) break;
    }
    assert.ok(toolTicket, 'No TOOL ticket derived');

    const toolTicketId = toolTicket.id;

    // Step 5: Lease TOOL ticket
    const leaseResp = await httpPostJson(baseUrl, `/v1/tickets/lease`, {
      kind: 'TOOL',
      limit: 10,
      lease_sec: 60
    });
    assert.strictEqual(leaseResp.status, 200, `Lease TOOL failed: ${leaseResp.status}`);

    const leasedTool = leaseResp.data.tickets.find(t => t.id === toolTicketId);
    assert.ok(leasedTool, 'Tool ticket not in leased batch');

    // Step 6: Attempt to fill TOOL with correct lease (should be blocked by readiness gate)
    const fillResp = await httpPostJson(baseUrl, `/v1/tickets/${toolTicketId}/fill`, {
      outputs: { result: 'should-be-blocked' },
      by: leasedTool.metadata.lease_owner,
      lease_owner: leasedTool.metadata.lease_owner,
      lease_token: leasedTool.metadata.lease_token
    });

    assert.strictEqual(fillResp.status, 409, `Expected 409, got ${fillResp.status}`);
    assert.strictEqual(fillResp.data.error_code, 'readiness_blocked', `Expected readiness_blocked, got ${fillResp.data.error_code}`);

    assert.ok(!fillResp.data.evidence_error, `Unexpected evidence_error: ${fillResp.data.evidence_error}`);
    assert.ok(fillResp.data.evidence_run_id, 'Missing evidence_run_id');

    const evidenceRunId = fillResp.data.evidence_run_id;
    const runDirPath = path.join(testLogsDir, evidenceRunId);
    assert.ok(fs.existsSync(runDirPath), `Evidence run dir not found: ${runDirPath}`);

    // Required files (guardrail baseline)
    const requiredFiles = [
      'run_report_v1.json',
      'evidence_manifest_v1.json',
      'manifest_self_hash_v1.json',
      'readiness_debug_v1.json',
      'dep_snapshot_v1.json'
    ];
    for (const f of requiredFiles) {
      const p = path.join(runDirPath, f);
      assert.ok(fs.existsSync(p), `Missing required artifact: ${f}`);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(runDirPath, 'evidence_manifest_v1.json'), 'utf8'));

    const check = (manifest.checks || []).find(c => c && c.name === 'system_rejection_evidence_ok');
    assert.ok(check, 'Missing system_rejection_evidence_ok check');
    assert.ok(Array.isArray(check.reason_codes) && check.reason_codes.includes(EVIDENCE_REASON_RUNTIME.READINESS_BLOCKED), 'Missing readiness_blocked reason code');
    assert.strictEqual(check.details_ref, 'readiness_debug_v1.json', 'details_ref should point to readiness_debug_v1.json');

    // Readiness debug payload sanity
    const readinessDebug = JSON.parse(fs.readFileSync(path.join(runDirPath, 'readiness_debug_v1.json'), 'utf8'));
    assert.strictEqual(readinessDebug.version, 'v1');
    assert.strictEqual(readinessDebug.ticket_id, toolTicketId);
    assert.ok(Array.isArray(readinessDebug.missing_required_dep_keys));

    console.log('[Test] testReadinessBlockedEvidence: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  testReadinessBlockedEvidence
};
