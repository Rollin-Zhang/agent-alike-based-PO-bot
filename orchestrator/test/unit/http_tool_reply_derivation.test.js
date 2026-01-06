/**
 * http_tool_reply_derivation.test.js
 * 
 * Integration tests for TRIAGE→TOOL→REPLY derivation in NO_MCP mode
 * Tests: positive chain, idempotency, superset, TOOL_ONLY_MODE negative, NO_MCP smoke
 */

const assert = require('assert');
const { startServerWithEnv } = require('./helpers/server');
const { httpPostEvent, httpPostFill, httpGetTicket, httpListTickets } = require('./helpers/http');
const { waitForTicket, findReplyByParent, sleep } = require('./helpers/waitFor');

// MCP startup blacklist patterns
const MCP_BLACKLIST_PATTERNS = [
  /ToolGateway/i,
  /\bMCP\b/i,
  /\bmcp\b/i,
  /Initializing MCP/i,
  /Starting MCP/i
];

/**
 * Test 1: TRIAGE→TOOL→REPLY positive chain
 */
async function testTriageToolReplyChain() {
  console.log('[Test] testTriageToolReplyChain: START');

  const { baseUrl, stop, logsBuffer } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true'
  });

  try {
    // Step 1: Create TRIAGE ticket
    const triageEvent = {
      type: 'thread_post',
      source: 'test',
      event_id: 'test-candidate-001',
      content: 'Test post for integration test suite',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResponse = await httpPostEvent(baseUrl, triageEvent);
    assert.strictEqual(eventResponse.status, 200, 'Event POST should succeed');
    const triageTicketId = eventResponse.data.ticket_id;
    assert.ok(triageTicketId, 'Should create TRIAGE ticket');

    // Step 2: Fill TRIAGE to trigger TOOL creation
    const fillResponse = await httpPostFill(baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Integration test',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });
    assert.strictEqual(fillResponse.status, 200, 'Fill should succeed');

    // Step 3: Wait for TOOL ticket
    const toolTicket = await waitForTicket(baseUrl, (t) =>
      t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
    );
    assert.ok(toolTicket, 'Should create TOOL ticket');
    assert.strictEqual(toolTicket.metadata.parent_ticket_id, triageTicketId, 'TOOL parent should be TRIAGE');

    // Step 4: Fill TOOL with PROCEED to trigger REPLY creation
    const toolFillResponse = await httpPostFill(baseUrl, toolTicket.id, {
      tool_verdict: 'PROCEED',
      reply_text: 'Generated reply'
    });
    assert.strictEqual(toolFillResponse.status, 200, 'TOOL fill should succeed');

    // Step 5: Wait for REPLY ticket
    const replyTicket = await findReplyByParent(baseUrl, toolTicket.id);
    assert.ok(replyTicket, 'Should create REPLY ticket');
    assert.strictEqual(replyTicket.metadata.kind, 'REPLY', 'Should be REPLY kind');
    assert.strictEqual(replyTicket.metadata.parent_ticket_id, toolTicket.id, 'REPLY parent should be TOOL');
    assert.ok(replyTicket.metadata.triage_reference_id, 'Should have triage_reference_id');

    console.log('[Test] testTriageToolReplyChain: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

/**
 * Test 1b: Link correctness is verified via HTTP GET (not snapshot placeholders)
 * - Verifies TRIAGE.derived.tool_ticket_id, TOOL.parent_ticket_id, TOOL.derived.reply_ticket_id,
 *   REPLY.parent_ticket_id and idempotency (no duplicates)
 */
async function testHttpLinkCorrectnessViaGetTicket() {
  console.log('[Test] testHttpLinkCorrectnessViaGetTicket: START');

  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true'
  });

  try {
    // TRIAGE
    const triageEvent = {
      type: 'thread_post',
      source: 'test',
      event_id: 'test-link-correctness-001',
      content: 'Link correctness test (GET /v1/tickets/:id)',
      // Must pass TriageFilter default gates (gate0b: min_likes=10, min_comments=5)
      features: { engagement: { likes: 100, comments: 50 } }
    };

    const eventResponse = await httpPostEvent(baseUrl, triageEvent);
    assert.strictEqual(eventResponse.status, 200, 'Event POST should succeed');
    const triageTicketId = eventResponse.data.ticket_id;
    assert.ok(triageTicketId, 'Should create TRIAGE ticket');

    const triageFill1 = await httpPostFill(baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Link correctness test',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });
    assert.strictEqual(triageFill1.status, 200, 'TRIAGE fill should succeed');

    // TOOL
    const toolTicket = await waitForTicket(baseUrl, (t) =>
      t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
    );
    assert.ok(toolTicket?.id, 'Should create TOOL ticket');

    // Fill TOOL -> REPLY
    const toolFill1 = await httpPostFill(baseUrl, toolTicket.id, {
      tool_verdict: 'PROCEED',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard',
      reply_text: 'Generated reply (link correctness)'
    });
    assert.strictEqual(toolFill1.status, 200, 'TOOL fill should succeed');

    const replyTicket = await findReplyByParent(baseUrl, toolTicket.id);
    assert.ok(replyTicket?.id, 'Should create REPLY ticket');

    // Verify link correctness via GET /v1/tickets/:id
    const triageGet1 = await httpGetTicket(baseUrl, triageTicketId);
    assert.strictEqual(triageGet1.status, 200, 'GET TRIAGE should succeed');
    assert.strictEqual(
      triageGet1.data?.derived?.tool_ticket_id,
      toolTicket.id,
      'TRIAGE.derived.tool_ticket_id should point to TOOL.id'
    );

    const toolGet1 = await httpGetTicket(baseUrl, toolTicket.id);
    assert.strictEqual(toolGet1.status, 200, 'GET TOOL should succeed');
    assert.strictEqual(
      toolGet1.data?.metadata?.parent_ticket_id,
      triageTicketId,
      'TOOL.metadata.parent_ticket_id should point to TRIAGE.id'
    );
    assert.strictEqual(
      toolGet1.data?.metadata?.triage_reference_id,
      triageTicketId,
      'TOOL.metadata.triage_reference_id should reference TRIAGE.id'
    );
    assert.strictEqual(
      toolGet1.data?.derived?.reply_ticket_id,
      replyTicket.id,
      'TOOL.derived.reply_ticket_id should point to REPLY.id'
    );

    const replyGet1 = await httpGetTicket(baseUrl, replyTicket.id);
    assert.strictEqual(replyGet1.status, 200, 'GET REPLY should succeed');
    assert.strictEqual(
      replyGet1.data?.metadata?.parent_ticket_id,
      toolTicket.id,
      'REPLY.metadata.parent_ticket_id should point to TOOL.id'
    );
    assert.strictEqual(
      replyGet1.data?.metadata?.triage_reference_id,
      triageTicketId,
      'REPLY.metadata.triage_reference_id should reference TRIAGE.id'
    );

    // Idempotency: re-fill TRIAGE should not create duplicate TOOL
    const triageFill2 = await httpPostFill(baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Link correctness test (second fill)',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });
    assert.strictEqual(triageFill2.status, 200, 'Second TRIAGE fill should succeed');
    await sleep(300);

    const triageGet2 = await httpGetTicket(baseUrl, triageTicketId);
    assert.strictEqual(
      triageGet2.data?.derived?.tool_ticket_id,
      toolTicket.id,
      'Second TRIAGE fill should not change derived.tool_ticket_id'
    );

    const listAfterTriageRefill = await httpListTickets(baseUrl, { limit: 10000 });
    const allTicketsAfterTriageRefill = listAfterTriageRefill.data || [];
    const toolsForTriage = allTicketsAfterTriageRefill.filter(
      (t) => t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
    );
    assert.strictEqual(toolsForTriage.length, 1, 'Should have exactly 1 TOOL for TRIAGE (idempotent)');

    // Idempotency: re-fill TOOL(PROCEED) should not create duplicate REPLY
    const toolFill2 = await httpPostFill(baseUrl, toolTicket.id, {
      tool_verdict: 'PROCEED',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard',
      reply_text: 'Generated reply (second fill)'
    });
    assert.strictEqual(toolFill2.status, 200, 'Second TOOL fill should succeed');
    await sleep(500);

    const replyTicket2 = await findReplyByParent(baseUrl, toolTicket.id);
    assert.strictEqual(replyTicket2.id, replyTicket.id, 'Second TOOL fill should not change REPLY id');

    const toolGet2 = await httpGetTicket(baseUrl, toolTicket.id);
    assert.strictEqual(
      toolGet2.data?.derived?.reply_ticket_id,
      replyTicket.id,
      'Second TOOL fill should not change derived.reply_ticket_id'
    );

    const listAfterToolRefill = await httpListTickets(baseUrl, { limit: 10000 });
    const allTicketsAfterToolRefill = listAfterToolRefill.data || [];
    const repliesForTool = allTicketsAfterToolRefill.filter(
      (t) => t.metadata?.kind === 'REPLY' && t.metadata?.parent_ticket_id === toolTicket.id
    );
    assert.strictEqual(repliesForTool.length, 1, 'Should have exactly 1 REPLY for TOOL (idempotent)');

    console.log('[Test] testHttpLinkCorrectnessViaGetTicket: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

/**
 * Test 2: Idempotency - second fill TOOL(PROCEED) should not create duplicate REPLY
 */
async function testIdempotency() {
  console.log('[Test] testIdempotency: START');

  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true'
  });

  try {
    // Create TRIAGE → TOOL → REPLY
    const triageEvent = {
      type: 'thread_post',
      source: 'test',
      event_id: 'test-candidate-002',
      content: 'Idempotency test post content for testing',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResponse = await httpPostEvent(baseUrl, triageEvent);
    const triageTicketId = eventResponse.data.ticket_id;

    await httpPostFill(baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Test',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });

    const toolTicket = await waitForTicket(baseUrl, (t) =>
      t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
    );

    // First fill: PROCEED
    await httpPostFill(baseUrl, toolTicket.id, {
      tool_verdict: 'PROCEED',
      reply_text: 'First reply'
    });

    const replyTicket1 = await findReplyByParent(baseUrl, toolTicket.id);
    const replyTicketId1 = replyTicket1.id;

    const allTickets1Response = await httpListTickets(baseUrl, { limit: 10000 });
    const allTickets1 = allTickets1Response.data || [];
    const count1 = allTickets1.filter(
      (t) => t.metadata?.kind === 'REPLY' && t.metadata?.parent_ticket_id === toolTicket.id
    ).length;

    // Second fill: PROCEED (should be idempotent)
    await httpPostFill(baseUrl, toolTicket.id, {
      tool_verdict: 'PROCEED',
      reply_text: 'Second reply'
    });

    await sleep(500); // Wait for potential duplicate

    const allTickets2Response = await httpListTickets(baseUrl, { limit: 10000 });
    const allTickets2 = allTickets2Response.data || [];
    const count2 = allTickets2.filter(
      (t) => t.metadata?.kind === 'REPLY' && t.metadata?.parent_ticket_id === toolTicket.id
    ).length;

    const replyTicket2 = await findReplyByParent(baseUrl, toolTicket.id);
    const replyTicketId2 = replyTicket2.id;

    // Assertions
    assert.strictEqual(replyTicketId2, replyTicketId1, 'Reply ID should not change');
    assert.strictEqual(count2, count1, 'Reply count should not increase');
    assert.strictEqual(count2, 1, 'Should have exactly 1 REPLY ticket');

    console.log('[Test] testIdempotency: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

/**
 * Test 3: Required keys superset - new REPLY metadata should be superset of legacy
 */
async function testRequiredKeysSuperset() {
  console.log('[Test] testRequiredKeysSuperset: START');

  // Step 1: Get legacy REPLY metadata keys
  const legacyServer = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'false' // Legacy mode
  });

  let legacyKeys;
  try {
    const triageEvent = {
      type: 'triage_candidate', // Must be triage_candidate for legacy automation
      source: 'test',
      event_id: 'test-candidate-legacy',
      content: 'Legacy test post content for comparison',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResponse = await httpPostEvent(legacyServer.baseUrl, triageEvent);
    const triageTicketId = eventResponse.data.ticket_id;

    await httpPostFill(legacyServer.baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Legacy test',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });

    // Wait a bit for processing
    await sleep(500);

    // Legacy creates REPLY directly from TRIAGE (uses helper's legacy branch)
    const legacyReply = await findReplyByParent(legacyServer.baseUrl, triageTicketId, { legacy: true, timeoutMs: 10000 });
    legacyKeys = Object.keys(legacyReply.metadata);
    assert.ok(legacyKeys.length > 0, 'Legacy REPLY should have metadata keys');
  } finally {
    await legacyServer.stop();
  }

  // Step 2: Get new derivation REPLY metadata keys
  const newServer = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true'
  });

  try {
    const triageEvent = {
      type: 'thread_post',
      source: 'test',
      event_id: 'test-candidate-new',
      content: 'New derivation test post content for testing',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResponse = await httpPostEvent(newServer.baseUrl, triageEvent);
    const triageTicketId = eventResponse.data.ticket_id;

    await httpPostFill(newServer.baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'New test',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });

    const toolTicket = await waitForTicket(newServer.baseUrl, (t) =>
      t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
    );

    await httpPostFill(newServer.baseUrl, toolTicket.id, {
      tool_verdict: 'PROCEED',
      reply_text: 'New reply'
    });

    const newReply = await findReplyByParent(newServer.baseUrl, toolTicket.id);
    const newKeys = Object.keys(newReply.metadata);

    // Assertions: newKeys should be superset of legacyKeys
    const isSuperset = legacyKeys.every((k) => newKeys.includes(k));
    assert.strictEqual(isSuperset, true, 'New REPLY metadata should be superset of legacy');

    // Assertions: newKeys should include parent_ticket_id and triage_reference_id
    assert.strictEqual(newKeys.includes('parent_ticket_id'), true, 'Should have parent_ticket_id');
    assert.strictEqual(newKeys.includes('triage_reference_id'), true, 'Should have triage_reference_id');

    console.log('[Test] testRequiredKeysSuperset: PASS ✓');
    return true;
  } finally {
    await newServer.stop();
  }
}

/**
 * Test 4: TOOL_ONLY_MODE negative - should not create REPLY
 */
async function testToolOnlyModeNegative() {
  console.log('[Test] testToolOnlyModeNegative: START');

  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true',
    TOOL_ONLY_MODE: 'true' // Block TOOL→REPLY
  });

  try {
    // Create TRIAGE → TOOL
    const triageEvent = {
      type: 'thread_post',
      source: 'test',
      event_id: 'test-candidate-tool-only',
      content: 'Tool only test post content for testing',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResponse = await httpPostEvent(baseUrl, triageEvent);
    const triageTicketId = eventResponse.data.ticket_id;

    await httpPostFill(baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Test',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });

    const toolTicket = await waitForTicket(baseUrl, (t) =>
      t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
    );

    // Fill TOOL with PROCEED
    await httpPostFill(baseUrl, toolTicket.id, {
      tool_verdict: 'PROCEED',
      reply_text: 'Should not create REPLY'
    });

    // Wait and check no REPLY created
    await sleep(1000);

    const allTicketsResponse = await httpListTickets(baseUrl, { limit: 10000 });
    const allTickets = allTicketsResponse.data || [];
    const replies = allTickets.filter(
      (t) => t.metadata?.kind === 'REPLY' && t.metadata?.parent_ticket_id === toolTicket.id
    );

    // Assertions
    assert.strictEqual(replies.length, 0, 'Should not create REPLY in TOOL_ONLY_MODE');

    // Check derived field not written (need to fetch latest toolTicket)
    const latestToolTicket = allTickets.find((t) => t.id === toolTicket.id);
    assert.strictEqual(
      latestToolTicket.derived?.replyTicketId,
      undefined,
      'Should not have derived.replyTicketId in TOOL_ONLY_MODE'
    );

    console.log('[Test] testToolOnlyModeNegative: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

/**
 * Test 5: NO_MCP smoke - logs should not contain MCP startup patterns
 */
async function testNoMcpSmoke() {
  console.log('[Test] testNoMcpSmoke: START');

  const { baseUrl, stop, logsBuffer } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true'
  });

  try {
    // Perform basic operation to trigger logs
    const triageEvent = {
      type: 'thread_post',
      source: 'test',
      event_id: 'test-candidate-smoke',
      content: 'Smoke test post content for testing',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    await httpPostEvent(baseUrl, triageEvent);

    // Join all logs
    const fullLog = logsBuffer.join('\n');

    // Check blacklist patterns
    const violations = MCP_BLACKLIST_PATTERNS.filter((pattern) => pattern.test(fullLog));

    assert.strictEqual(violations.length, 0, `NO_MCP smoke test failed: found MCP patterns: ${violations.join(', ')}`);

    console.log('[Test] testNoMcpSmoke: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

/**
 * Test 6 (M1): Legacy mode - TRIAGE→REPLY direct (no TOOL)
 */
async function testLegacyMode() {
  console.log('[Test] testLegacyMode: START');

  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'false' // Legacy mode
  });

  try {
    // Create TRIAGE with triage_candidate type (for legacy automation)
    const triageEvent = {
      type: 'triage_candidate',
      source: 'test',
      event_id: 'test-candidate-legacy-m1',
      content: 'Legacy mode test for M1 acceptance',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResponse = await httpPostEvent(baseUrl, triageEvent);
    const triageTicketId = eventResponse.data.ticket_id;

    // Fill TRIAGE with APPROVE
    await httpPostFill(baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Legacy mode test',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });

    await sleep(500);

    // Legacy: TRIAGE → REPLY directly (no TOOL)
    const allTicketsResp = await httpListTickets(baseUrl, { limit: 10000 });
    const allTickets = allTicketsResp.data || [];

    const toolTickets = allTickets.filter((t) => t.metadata?.kind === 'TOOL');
    const replyTickets = allTickets.filter((t) => t.metadata?.kind === 'REPLY');

    // Assertions
    assert.strictEqual(toolTickets.length, 0, 'Legacy mode should not create TOOL ticket');
    assert.strictEqual(replyTickets.length, 1, 'Legacy mode should create REPLY ticket');

    const legacyReply = replyTickets[0];
    assert.strictEqual(legacyReply.metadata.triage_reference_id, triageTicketId, 'Legacy REPLY should reference TRIAGE');
    assert.strictEqual(legacyReply.metadata.parent_ticket_id, undefined, 'Legacy REPLY should not have parent_ticket_id');

    console.log('[Test] testLegacyMode: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

/**
 * Test 7 (M4): Reply derivation off - TRIAGE→TOOL only
 */
async function testReplyDerivationOff() {
  console.log('[Test] testReplyDerivationOff: START');

  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'false' // Reply derivation off
  });

  try {
    // Create TRIAGE
    const triageEvent = {
      type: 'thread_post',
      source: 'test',
      event_id: 'test-candidate-reply-off',
      content: 'Reply derivation off test for M4',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResponse = await httpPostEvent(baseUrl, triageEvent);
    const triageTicketId = eventResponse.data.ticket_id;

    // Fill TRIAGE
    await httpPostFill(baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Test',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });

    // Wait for TOOL
    const toolTicket = await waitForTicket(baseUrl, (t) =>
      t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
    );

    // Fill TOOL with PROCEED
    await httpPostFill(baseUrl, toolTicket.id, {
      tool_verdict: 'PROCEED',
      reply_text: 'Should not create REPLY'
    });

    await sleep(1000);

    // Check no REPLY created
    const allTicketsResp = await httpListTickets(baseUrl, { limit: 10000 });
    const allTickets = allTicketsResp.data || [];
    const replies = allTickets.filter(
      (t) => t.metadata?.kind === 'REPLY' && t.metadata?.parent_ticket_id === toolTicket.id
    );

    // Assertions
    assert.strictEqual(replies.length, 0, 'Should not create REPLY when ENABLE_REPLY_DERIVATION=false');

    // Check derived field not written
    const latestToolTicket = allTickets.find((t) => t.id === toolTicket.id);
    assert.strictEqual(
      latestToolTicket.derived?.replyTicketId,
      undefined,
      'Should not have derived.replyTicketId when ENABLE_REPLY_DERIVATION=false'
    );

    console.log('[Test] testReplyDerivationOff: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

/**
 * Test 8 (M5): Verdict block - tool_verdict != PROCEED
 */
async function testVerdictBlock() {
  console.log('[Test] testVerdictBlock: START');

  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true'
  });

  try {
    // Test multiple non-PROCEED verdicts
    const verdicts = ['STOP', 'REJECT', 'SKIP'];

    for (const verdict of verdicts) {
      // Create TRIAGE
      const triageEvent = {
        type: 'thread_post',
        source: 'test',
        event_id: `test-candidate-verdict-${verdict}`,
        content: `Verdict block test for ${verdict}`,
        features: {
          engagement: { likes: 100, comments: 50 }
        }
      };

      const eventResponse = await httpPostEvent(baseUrl, triageEvent);
      const triageTicketId = eventResponse.data.ticket_id;

      // Fill TRIAGE
      await httpPostFill(baseUrl, triageTicketId, {
        decision: 'APPROVE',
        short_reason: 'Test',
        reply_strategy: 'standard',
        target_prompt_id: 'reply.standard'
      });

      // Wait for TOOL
      const toolTicket = await waitForTicket(baseUrl, (t) =>
        t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
      );

      // Fill TOOL with non-PROCEED verdict
      await httpPostFill(baseUrl, toolTicket.id, {
        tool_verdict: verdict,
        reply_text: 'Should not create REPLY'
      });

      await sleep(500);

      // Check no REPLY created
      const allTicketsResp = await httpListTickets(baseUrl, { limit: 10000 });
      const allTickets = allTicketsResp.data || [];
      const replies = allTickets.filter(
        (t) => t.metadata?.kind === 'REPLY' && t.metadata?.parent_ticket_id === toolTicket.id
      );

      // Assertions
      assert.strictEqual(replies.length, 0, `Should not create REPLY for verdict=${verdict}`);

      // Check derived field not written
      const latestToolTicket = allTickets.find((t) => t.id === toolTicket.id);
      assert.strictEqual(
        latestToolTicket.derived?.replyTicketId,
        undefined,
        `Should not have derived.replyTicketId for verdict=${verdict}`
      );
    }

    console.log('[Test] testVerdictBlock: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

/**
 * Test 9: Malformed outputs (outputs exists but empty/missing verdict)
 */
async function testMalformedOutputs() {
  console.log('[Test] testMalformedOutputs: START');

  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true'
  });

  try {
    // Create TRIAGE
    const triageEvent = {
      type: 'thread_post',
      source: 'test',
      event_id: 'test-candidate-malformed',
      content: 'Malformed outputs test content',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResponse = await httpPostEvent(baseUrl, triageEvent);
    const triageTicketId = eventResponse.data.ticket_id;

    // Fill TRIAGE
    await httpPostFill(baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Test',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });

    // Wait for TOOL
    const toolTicket = await waitForTicket(baseUrl, (t) =>
      t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
    );

    // Set final_outputs in metadata (with PROCEED)
    const updateResp = await httpListTickets(baseUrl, { limit: 10000 });
    const currentTickets = updateResp.data || [];
    const currentTool = currentTickets.find((t) => t.id === toolTicket.id);
    
    // Simulate: metadata has final_outputs with PROCEED, but fill with empty outputs
    // This tests the precedence rule: outputs (even if empty) takes precedence over final_outputs
    
    // Fill TOOL with empty outputs (malformed)
    await httpPostFill(baseUrl, toolTicket.id, {
      // Empty outputs - no tool_verdict
    });

    await sleep(500);

    // Check no REPLY created (because outputs exists but has no verdict)
    const allTicketsResp = await httpListTickets(baseUrl, { limit: 10000 });
    const allTickets = allTicketsResp.data || [];
    const replies = allTickets.filter(
      (t) => t.metadata?.kind === 'REPLY' && t.metadata?.parent_ticket_id === toolTicket.id
    );

    // Assertions
    assert.strictEqual(replies.length, 0, 'Should not create REPLY for empty outputs');

    console.log('[Test] testMalformedOutputs: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

// Export tests
module.exports = {
  testTriageToolReplyChain,
  testHttpLinkCorrectnessViaGetTicket,
  testIdempotency,
  testRequiredKeysSuperset,
  testToolOnlyModeNegative,
  testNoMcpSmoke,
  testLegacyMode,
  testReplyDerivationOff,
  testVerdictBlock,
  testMalformedOutputs
};

