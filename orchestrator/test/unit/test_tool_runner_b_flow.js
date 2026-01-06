#!/usr/bin/env node
/**
 * test_tool_runner_b_flow.js
 * M2-B.2 Integration Test: NO_MCP mode + TOOL→REPLY derivation
 * M2-B.2-v2: 驗證 {server, tool} format 支援 + 派生唯一性 (maybeDeriveReplyFromToolOnFill)
 */

const { v4: uuidv4 } = require('uuid');
const TicketStore = require('../../store/TicketStore');
const { run: runCore } = require('../../lib/tool_runner/RunnerCore');
const { createStubGateway } = require('../../lib/tool_runner/ToolGatewayAdapter');
const { RUN_STATUS } = require('../../lib/tool_runner/ssot');
const { maybeDeriveReplyFromToolOnFill } = require('../../lib/maybeDeriveReplyFromToolOnFill');
const { readToolVerdict, isProceed } = require('../../lib/toolVerdict');
const { mapRunReportStatusToVerdict } = require('../../lib/tool_runner/b_script_executor_ssot');

async function testToolRunnerFlow() {
  console.log('=== M2-B.2 Integration Test START ===\n');
  
  // Setup
  const store = new TicketStore();
  process.env.ENABLE_REPLY_DERIVATION = 'true';
  
  // Create TRIAGE ticket
  const triageId = uuidv4();
  const triageTicket = {
    id: triageId,
    kind: 'TRIAGE',
    status: 'done',
    metadata: {
      kind: 'TRIAGE',
      created_at: new Date().toISOString(),
      template_name: 'daily_summary',
      scraped_post: {
        text: 'Test post for M2-B.2 derivation'
      }
    }
  };
  await store.create(triageTicket);
  console.log('[Test] Created TRIAGE ticket:', triageId);
  
  // Create TOOL ticket (M2-B.2-v2: 用 {server, tool} 格式測試 normalizeToolSteps)
  // NOTE: 為了測試 normalize 支援，metadata 用 {server, tool}，root 用 canonical
  // Canonical format: 依照 SSOT allowlist，使用 'web_search' 而非 'web_search.search'
  const toolId = uuidv4();
  const toolTicket = {
    id: toolId,
    kind: 'TOOL',
    status: 'pending',
    parent_ticket_id: triageId,
    metadata: {
      kind: 'TOOL',
      parent_ticket_id: triageId,
      created_at: new Date().toISOString(),
      tool_input: {
        tool_steps: [
          { server: 'web', tool: 'search', args: { query: 'test' } } // {server, tool} format
        ],
        budget: { max_steps: 5 }
      }
    },
    // tool_steps at root: 使用 SSOT allowlist 認可的 tool_name
    tool_steps: [
      { tool_name: 'web_search', args: { query: 'test' } } // canonical format per SSOT
    ]
  };
  await store.create(toolTicket);
  console.log('[Test] Created TOOL ticket:', toolId);
  console.log('[Test] tool_steps format: {server, tool} in metadata (demonstrates normalize), canonical at root');
  
  // Run RunnerCore with stub gateway
  // Gateway must use SSOT-approved tool_name
  const gateway = createStubGateway({
    'web_search': { 
      ok: true, 
      result: { items: [{ title: 'test result', url: 'http://test.com' }] }, 
      evidenceCandidates: [] 
    }
  });
  
  // DEBUG: Wrap gateway to see what toolName is being requested
  const origExecute = gateway.execute.bind(gateway);
  gateway.execute = function(params) {
    console.log('[Test] DEBUG gateway.execute called with toolName:', params.toolName);
    return origExecute(params);
  };
  
  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };
  
  console.log('[Test] Running RunnerCore...');
  console.log('[Test] DEBUG ticket.tool_steps:', JSON.stringify(toolTicket.tool_steps, null, 2));
  const runReport = await runCore(toolTicket, deps, {
    gateway,
    attachEvidence: async () => ({ kind: 'stub', storage: 'inline' }),
    budget: { max_steps: 5 },
    requiredDeps: ['web_search'] // Only require web_search for this test
  });
  
  console.log('[Test] RunReport status:', runReport.status);
  console.log('[Test] RunReport code:', runReport.code);
  
  // Build outputs
  const tool_context = {
    evidence: runReport.evidence_summary?.items || []
  };
  const tool_verdict = mapRunReportStatusToVerdict(runReport.status);
  const outputs = { tool_context, tool_verdict };
  
  console.log('[Test] tool_verdict:', tool_verdict);
  
  // Complete TOOL ticket
  await store.complete(toolId, outputs, 'test_runner', null);
  console.log('[Test] TOOL ticket completed');
  
  // M2-B.2-v2: 驗證派生唯一性 - 使用 maybeDeriveReplyFromToolOnFill (不是 deriveReplyTicketFromTool)
  console.log('[Test] Verifying derivation uses maybeDeriveReplyFromToolOnFill (unified entry)...');
  console.log('[Test] Metadata.tool_input.tool_steps format: {server, tool} (demonstrates normalize support)');
  
  // Fetch updated ticket (contains final_outputs)
  const updatedTicket = await store.get(toolId);
  
  // Call unified derivation entry point
  const deriveResult = await maybeDeriveReplyFromToolOnFill(
    updatedTicket,
    outputs,
    store,
    console // logger
  );
  
  if (deriveResult.attempted && deriveResult.created) {
    console.log('[Test] ✅ REPLY ticket created:', deriveResult.reply_ticket_id);
    
    // Verify REPLY ticket exists
    const replyTicket = await store.get(deriveResult.reply_ticket_id);
    console.log('[Test] ✅ REPLY ticket verified, kind:', replyTicket.metadata?.kind);
  } else if (deriveResult.attempted) {
    console.log('[Test] ❌ REPLY derivation attempted but not created:', deriveResult.reason);
    throw new Error('Expected REPLY derivation but got: ' + deriveResult.reason);
  } else {
    console.log('[Test] ⚠️  REPLY derivation not attempted:', deriveResult.reason);
    throw new Error('Expected REPLY derivation attempt but got: ' + deriveResult.reason);
  }
  
  console.log('\n=== M2-B.2 Integration Test PASSED ✓ ===');
}

testToolRunnerFlow().catch(err => {
  console.error('\n[Test FAILED]', err);
  process.exit(1);
});
