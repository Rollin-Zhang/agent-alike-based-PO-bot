/**
 * Phase F2B-1(2): tool_fail (unknown_tool) fill-path system-level test
 *
 * Contract:
 * - Real HTTP pipeline: create TRIAGE → derive TOOL → lease TOOL → fill TOOL (triggers unknown_tool gate AFTER lease)
 * - Test strategy: Mock TOOL_ARGS_ALLOWLIST to exclude 'memory' tool, making derived tool 'unknown'
 * - Tool validation gate enabled for TOOL fill (test-only env: ENABLE_TOOL_VALIDATION_GATE=1)
 * - Evidence chain: run_report_v1 + evidence_manifest_v1 + manifest_self_hash_v1 + tool_debug_v1
 * - Manifest checks[] must contain: reason_code='unknown_tool' + details_ref→tool_debug_v1
 * - HTTP rejection: 409 + error_code='unknown_tool' + evidence_run_id
 * - Gate order: lease gate FIRST (prevents allowlist probing), then tool validation
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { startServerWithEnv } = require('./helpers/server');
const { httpPostJson, httpGetJson } = require('./helpers/http');
const { EVIDENCE_REASON_RUNTIME } = require('../../lib/evidence/ssot');

async function testToolFailUnknownTool() {
  console.log('[Test] testToolFailUnknownTool: START');

  const testLogsDir = process.env.LOGS_DIR || path.join(require('os').tmpdir(), `f2b_tool_fail_${Date.now()}`);
  fs.mkdirSync(testLogsDir, { recursive: true });

  const testDbPath = path.join(testLogsDir, 'test_tickets.db');

  // Test strategy: Use TEST_EXCLUDE_TOOLS_FROM_ALLOWLIST env var to exclude 'memory' tool
  // This makes the normally-derived 'memory' tool become 'unknown' for validation purposes
  const { baseUrl, stop } = await startServerWithEnv({
    NODE_ENV: 'test',
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_GUARD_REJECTION_EVIDENCE: '1',
    ENABLE_TOOL_VALIDATION_GATE: '1',
    LOGS_DIR: testLogsDir,
    TICKETSTORE_PATH: testDbPath,
    TEST_EXCLUDE_TOOLS_FROM_ALLOWLIST: 'memory'  // Exclude memory tool for this test
  });

  try {
    // Step 1: Create TRIAGE ticket via normal HTTP pipeline
    const triageEvent = {
      type: 'thread_post',
      source: 'test-f2b-tool-fail',
      event_id: `f2b_tool_fail_${Date.now()}`,
      content: 'Test unknown_tool validation',
      features: {
        engagement: { likes: 150, comments: 50 }
      }
    };

    const eventResp = await httpPostJson(baseUrl, '/events', triageEvent);
    assert.strictEqual(eventResp.status, 200, `POST /events failed: ${eventResp.status}`);
    const triageTicketId = eventResp.data.ticket_id;

    // Step 2: Lease TRIAGE ticket
    const triageLeaseResp = await httpPostJson(baseUrl, `/v1/tickets/lease`, {
      kind: 'TRIAGE',
      limit: 10,
      lease_sec: 60
    });
    assert.strictEqual(triageLeaseResp.status, 200);

    const leasedTriage = triageLeaseResp.data.tickets.find(t => t.id === triageTicketId);
    assert.ok(leasedTriage);

    // Step 3: Fill TRIAGE to trigger TOOL derivation
    const triageFillResp = await httpPostJson(baseUrl, `/v1/tickets/${triageTicketId}/fill`, {
      outputs: {
        decision: 'APPROVE',
        short_reason: 'Test unknown tool',
        reply_strategy: 'test'
      },
      by: 'test_fill_triage',
      lease_owner: leasedTriage.metadata.lease_owner,
      lease_token: leasedTriage.metadata.lease_token
    });
    assert.strictEqual(triageFillResp.status, 200);

    await sleep(1000);  // Wait for derivation

    // Step 4: Find derived TOOL ticket
    const allTicketsResp = await httpGetJson(baseUrl, '/v1/tickets');
    const toolTickets = allTicketsResp.data.filter(t => t.type === 'ToolTicket' && t.metadata.parent_ticket_id === triageTicketId);
    assert.ok(toolTickets.length > 0, 'No TOOL ticket derived');
    
    const toolTicket = toolTickets[0];
    console.log(`[Test] Found derived TOOL ticket: ${toolTicket.id}, tool_name should be 'memory'`);

    // Step 5: Lease the TOOL ticket (memory tool, now considered unknown due to mocked allowlist)
    const leaseResp = await httpPostJson(baseUrl, `/v1/tickets/lease`, {
      kind: 'TOOL',
      limit: 10,
      lease_sec: 60
    });
    assert.strictEqual(leaseResp.status, 200, `Lease TOOL failed: ${leaseResp.status}`);

    const leasedTool = leaseResp.data.tickets.find(t => t.id === toolTicket.id);
    assert.ok(leasedTool, 'Tool ticket not in leased batch');
    assert.ok(leasedTool.metadata.lease_owner, 'Missing lease_owner');
    assert.ok(leasedTool.metadata.lease_token, 'Missing lease_token');

    // Step 6: Attempt to fill TOOL with correct lease (should be blocked by tool validation gate)
    // Tool will be rejected as 'unknown' because 'memory' was removed from mocked allowlist
    const fillResp = await httpPostJson(baseUrl, `/v1/tickets/${toolTicket.id}/fill`, {
      outputs: { result: 'should-be-blocked' },
      by: leasedTool.metadata.lease_owner,
      lease_owner: leasedTool.metadata.lease_owner,
      lease_token: leasedTool.metadata.lease_token
    });

    // Validate HTTP rejection
    assert.strictEqual(fillResp.status, 409, `Expected 409, got ${fillResp.status}`);
    console.log(`[Test] Fill response body:`, JSON.stringify(fillResp.data, null, 2));
    assert.strictEqual(fillResp.data.error_code, 'unknown_tool', `Expected unknown_tool, got ${fillResp.data.error_code}`);

    assert.ok(!fillResp.data.evidence_error, `Unexpected evidence_error: ${fillResp.data.evidence_error}`);
    assert.ok(fillResp.data.evidence_run_id, 'Missing evidence_run_id');

    const evidenceRunId = fillResp.data.evidence_run_id;
    const runDirPath = path.join(testLogsDir, evidenceRunId);
    await sleep(200);  // Wait for evidence write
    assert.ok(fs.existsSync(runDirPath), `Evidence run dir not found: ${runDirPath}`);

    // Step 7: Validate required artifacts (guardrail baseline)
    const requiredFiles = [
      'run_report_v1.json',
      'evidence_manifest_v1.json',
      'manifest_self_hash_v1.json',
      'tool_debug_v1.json'
    ];
    for (const f of requiredFiles) {
      const p = path.join(runDirPath, f);
      assert.ok(fs.existsSync(p), `Missing required artifact: ${f}`);
    }

    // Step 8: Validate manifest checks
    const manifest = JSON.parse(fs.readFileSync(path.join(runDirPath, 'evidence_manifest_v1.json'), 'utf8'));

    const check = (manifest.checks || []).find(c => c && c.name === 'system_rejection_evidence_ok');
    assert.ok(check, 'Missing system_rejection_evidence_ok check');
    assert.ok(Array.isArray(check.reason_codes) && check.reason_codes.includes(EVIDENCE_REASON_RUNTIME.UNKNOWN_TOOL), 'Missing unknown_tool reason code');
    assert.strictEqual(check.details_ref, 'tool_debug_v1.json', 'details_ref should point to tool_debug_v1.json');

    // Step 9: Validate tool_debug payload
    const toolDebug = JSON.parse(fs.readFileSync(path.join(runDirPath, 'tool_debug_v1.json'), 'utf8'));
    assert.strictEqual(toolDebug.version, 'v1');
    assert.strictEqual(toolDebug.ticket_id, toolTicket.id);
    // Tool name should be 'memory' (the derived tool), rejected because not in mocked allowlist
    assert.ok(toolDebug.tool_name, 'Missing tool_name');
    assert.strictEqual(toolDebug.error_type, 'unknown_tool');
    assert.ok(toolDebug.message && toolDebug.message.includes('Unknown tool'), 'tool_debug.message should contain "Unknown tool"');
    assert.strictEqual(toolDebug.gateway_phase, 'fill_validation');
    assert.strictEqual(toolDebug.source, 'metadata.tool_input.tool_steps', 'tool_debug.source should track data lineage');

    // Optional: validate args_shape if present (memory tool has operation/entities/relations/etc)
    if (toolDebug.args_shape) {
      assert.strictEqual(typeof toolDebug.args_shape, 'object');
    }

    // Step 10: Validate manifest self-integrity
    const manifestSelfHash = JSON.parse(fs.readFileSync(path.join(runDirPath, 'manifest_self_hash_v1.json'), 'utf8'));
    assert.ok(manifestSelfHash.value, 'Missing manifest_self_hash value');
    assert.ok(manifestSelfHash.value.length === 64, 'Invalid manifest_self_hash value length');

    // Step 11: Validate run_report
    const runReport = JSON.parse(fs.readFileSync(path.join(runDirPath, 'run_report_v1.json'), 'utf8'));
    assert.strictEqual(runReport.version, 'v1');
    assert.ok(runReport.run_id, 'Missing run_report run_id');
    assert.strictEqual(runReport.terminal_status, 'failed');
    assert.ok(runReport.as_of);

    console.log('[Test] testToolFailUnknownTool: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { testToolFailUnknownTool };
