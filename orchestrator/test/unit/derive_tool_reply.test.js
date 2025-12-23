/**
 * test/unit/derive_tool_reply.test.js
 * 
 * Unit tests for deriveReplyTicketFromTool
 * Commit 6B.2: Comprehensive coverage of gates, idempotency, duplicate recovery, template rules
 */

const assert = require('assert');
const deriveReplyTicketFromTool = require('../../lib/deriveReplyTicketFromTool');

// --- FIXTURE: Stub TicketStore ---
function createStubTicketStore(options = {}) {
  const {
    listResults = [],
    createShouldThrow = false,
    getResults = {}
  } = options;

  const stub = {
    create: async (ticket) => {
      if (createShouldThrow) {
        throw new Error('TicketStore.create failed');
      }
      // Store for verification
      stub._lastCreated = ticket;
    },
    list: async (query) => {
      stub._lastListQuery = query;
      return listResults;
    },
    get: async (id) => {
      return getResults[id] || null;
    },
    _lastCreated: undefined,
    _lastListQuery: undefined
  };

  return stub;
}

// --- TEST 1: GATES - kind not TOOL ---
async function testGateKindNotTool() {
  console.log('[Test] testGateKindNotTool: START');

  const toolTicket = { id: 't1', metadata: { kind: 'TRIAGE' } }; // Wrong kind
  const outputs = { tool_verdict: 'PROCEED' };
  const triageTicket = { id: 'triage1', event: {}, metadata: {} };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, '', store);

  assert.strictEqual(result.created, false, 'Should not create');
  assert.strictEqual(result.reason, 'gate_kind_not_tool', 'Should fail gate: kind not TOOL');

  console.log('[Test] testGateKindNotTool: PASS ✓');
  return true;
}

// --- TEST 2: GATES - ENABLE_REPLY_DERIVATION disabled ---
async function testGateReplyDerivationDisabled() {
  console.log('[Test] testGateReplyDerivationDisabled: START');

  const toolTicket = { id: 't1', metadata: { kind: 'TOOL' } };
  const outputs = { tool_verdict: 'PROCEED' };
  const triageTicket = { id: 'triage1', event: {}, metadata: {} };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'false'; // Disabled
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, '', store);

  assert.strictEqual(result.created, false, 'Should not create');
  assert.strictEqual(result.reason, 'gate_reply_derivation_disabled', 'Should fail gate: disabled');

  console.log('[Test] testGateReplyDerivationDisabled: PASS ✓');
  return true;
}

// --- TEST 3: GATES - TOOL_ONLY_MODE enabled ---
async function testGateToolOnlyMode() {
  console.log('[Test] testGateToolOnlyMode: START');

  const toolTicket = { id: 't1', metadata: { kind: 'TOOL' } };
  const outputs = { tool_verdict: 'PROCEED' };
  const triageTicket = { id: 'triage1', event: {}, metadata: {} };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'true'; // Tool only mode

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, '', store);

  assert.strictEqual(result.created, false, 'Should not create');
  assert.strictEqual(result.reason, 'gate_tool_only_mode', 'Should fail gate: tool only mode');

  console.log('[Test] testGateToolOnlyMode: PASS ✓');
  return true;
}

// --- TEST 4: GATES - tool_verdict not PROCEED ---
async function testGateToolVerdictNotProceed() {
  console.log('[Test] testGateToolVerdictNotProceed: START');

  const toolTicket = { id: 't1', metadata: { kind: 'TOOL' } };
  const outputs = { tool_verdict: 'REJECT' }; // Not PROCEED
  const triageTicket = { id: 'triage1', event: {}, metadata: {} };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, '', store);

  assert.strictEqual(result.created, false, 'Should not create');
  assert.strictEqual(result.reason, 'gate_tool_verdict_not_proceed', 'Should fail gate: verdict not PROCEED');

  console.log('[Test] testGateToolVerdictNotProceed: PASS ✓');
  return true;
}

// --- TEST 5: tool_verdict source - outputs takes precedence ---
async function testToolVerdictSourceOutputsPrecedence() {
  console.log('[Test] testToolVerdictSourceOutputsPrecedence: START');

  const toolTicket = {
    id: 't1',
    metadata: { kind: 'TOOL' },
    final_outputs: { tool_verdict: 'REJECT' } // Should be ignored
  };
  const outputs = { tool_verdict: 'PROCEED', reply_strategy: 'test' }; // outputs takes precedence
  const triageTicket = { id: 'triage1', event: { post_id: 'p1' }, metadata: { candidate_id: 'c1' } };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, 'ctx', store);

  assert.strictEqual(result.created, true, 'Should create (outputs PROCEED wins)');
  assert.ok(result.reply_ticket_id, 'Should have reply_ticket_id');

  console.log('[Test] testToolVerdictSourceOutputsPrecedence: PASS ✓');
  return true;
}

// --- TEST 6: tool_verdict source - fallback to final_outputs ---
async function testToolVerdictSourceFallbackFinalOutputs() {
  console.log('[Test] testToolVerdictSourceFallbackFinalOutputs: START');

  const toolTicket = {
    id: 't2',
    metadata: { kind: 'TOOL' },
    final_outputs: { tool_verdict: 'PROCEED' } // Should be used
  };
  const outputs = null; // null, so fallback
  const triageTicket = { id: 'triage2', event: { post_id: 'p2' }, metadata: { candidate_id: 'c2' } };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, 'ctx', store);

  assert.strictEqual(result.created, true, 'Should create (final_outputs fallback works)');
  assert.ok(result.reply_ticket_id, 'Should have reply_ticket_id');

  console.log('[Test] testToolVerdictSourceFallbackFinalOutputs: PASS ✓');
  return true;
}

// --- TEST 7: tool_verdict source - malformed outputs (no crash) ---
async function testToolVerdictSourceMalformedOutputs() {
  console.log('[Test] testToolVerdictSourceMalformedOutputs: START');

  const toolTicket = {
    id: 't3',
    metadata: { kind: 'TOOL' },
    final_outputs: { tool_verdict: 'PROCEED' }
  };
  const outputs = {}; // Malformed (no tool_verdict)
  const triageTicket = { id: 'triage3', event: {}, metadata: {} };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, '', store);

  assert.strictEqual(result.created, false, 'Should not create (malformed outputs)');
  assert.strictEqual(result.reason, 'missing_tool_verdict', 'Should report missing_tool_verdict');

  console.log('[Test] testToolVerdictSourceMalformedOutputs: PASS ✓');
  return true;
}

// --- TEST 8: Idempotency - existing reply_ticket_id ---
async function testIdempotencyExistingReplyTicketId() {
  console.log('[Test] testIdempotencyExistingReplyTicketId: START');

  const toolTicket = {
    id: 't4',
    metadata: { kind: 'TOOL' },
    derived: { reply_ticket_id: 'existing-reply-123' } // Already has reply_ticket_id
  };
  const outputs = { tool_verdict: 'PROCEED', reply_strategy: 'test' };
  const triageTicket = { id: 'triage4', event: {}, metadata: {} };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, '', store);

  assert.strictEqual(result.created, false, 'Should not create (idempotent)');
  assert.strictEqual(result.reason, 'idempotent', 'Should report idempotent');
  assert.strictEqual(result.reply_ticket_id, 'existing-reply-123', 'Should return existing id');
  assert.strictEqual(store._lastCreated, undefined, 'Should not call ticketStore.create');

  console.log('[Test] testIdempotencyExistingReplyTicketId: PASS ✓');
  return true;
}

// --- TEST 9: Duplicate recovery - orphan found ---
async function testDuplicateRecoveryOrphanFound() {
  console.log('[Test] testDuplicateRecoveryOrphanFound: START');

  const toolTicket = {
    id: 't5',
    metadata: { kind: 'TOOL' }
    // No derived.reply_ticket_id yet
  };
  const outputs = { tool_verdict: 'PROCEED', reply_strategy: 'test' };
  const triageTicket = { id: 'triage5', event: {}, metadata: {} };

  // Stub store with orphan REPLY ticket
  const orphanReply = {
    id: 'orphan-reply-999',
    type: 'DraftTicket',
    metadata: {
      kind: 'REPLY',
      parent_ticket_id: 't5'
    }
  };
  const store = createStubTicketStore({ listResults: [orphanReply] });

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, '', store);

  assert.strictEqual(result.created, false, 'Should not create new (recovered)');
  assert.strictEqual(result.recovered, true, 'Should mark as recovered');
  assert.strictEqual(result.reply_ticket_id, 'orphan-reply-999', 'Should return orphan id');
  assert.strictEqual(result.reason, 'recovered_orphan', 'Should report recovered_orphan');
  
  // Verify list query
  assert.deepStrictEqual(store._lastListQuery, {
    type: 'DraftTicket',
    'metadata.kind': 'REPLY',
    'metadata.parent_ticket_id': 't5'
  }, 'Should query for orphan REPLY tickets');

  // Verify writeDerived called (toolTicket should have derived now)
  assert.strictEqual(toolTicket.derived.reply_ticket_id, 'orphan-reply-999', 'Should write back-reference');

  console.log('[Test] testDuplicateRecoveryOrphanFound: PASS ✓');
  return true;
}

// --- TEST 10: Duplicate recovery - no orphan found (creates new) ---
async function testDuplicateRecoveryNoOrphanFound() {
  console.log('[Test] testDuplicateRecoveryNoOrphanFound: START');

  const toolTicket = {
    id: 't6',
    metadata: { kind: 'TOOL' }
  };
  const outputs = { tool_verdict: 'PROCEED', reply_strategy: 'empathetic', target_prompt_id: 'reply.empathetic' };
  const triageTicket = { 
    id: 'triage6', 
    event: { post_id: 'p6', thread_id: 'th6' }, 
    metadata: { candidate_id: 'c6' } 
  };
  const store = createStubTicketStore({ listResults: [] }); // No orphan

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, 'context notes', store);

  assert.strictEqual(result.created, true, 'Should create new ticket');
  assert.strictEqual(result.recovered, false, 'Should not mark as recovered');
  assert.ok(result.reply_ticket_id, 'Should have new reply_ticket_id');
  assert.strictEqual(result.reason, 'created', 'Should report created');

  console.log('[Test] testDuplicateRecoveryNoOrphanFound: PASS ✓');
  return true;
}

// --- TEST 11: Template override rules - preserve & override ---
async function testTemplateOverrideRules() {
  console.log('[Test] testTemplateOverrideRules: START');

  const toolTicket = {
    id: 'tool-override-test',
    metadata: { kind: 'TOOL' }
  };
  const outputs = { 
    tool_verdict: 'PROCEED', 
    reply_strategy: 'diplomatic', 
    target_prompt_id: 'reply.diplomatic' 
  };
  const triageTicket = { 
    id: 'triage-override-test', 
    event: { post_id: 'post-override', thread_id: 'thread-override' }, 
    metadata: { candidate_id: 'candidate-override' } 
  };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  const result = await deriveReplyTicketFromTool(toolTicket, outputs, triageTicket, 'override context', store);

  assert.strictEqual(result.created, true, 'Should create');

  const createdTicket = store._lastCreated;
  assert.ok(createdTicket, 'Should have created ticket');

  // PRESERVE from template
  assert.strictEqual(createdTicket.type, 'DraftTicket', 'Should preserve type');
  assert.strictEqual(createdTicket.status, 'pending', 'Should preserve status');
  assert.strictEqual(createdTicket.flow_id, 'reply_zh_hant_v1', 'Should preserve flow_id');
  assert.deepStrictEqual(createdTicket.event, triageTicket.event, 'Should preserve event from template');

  // OVERRIDE
  assert.strictEqual(createdTicket.id, result.reply_ticket_id, 'Should override id');
  assert.strictEqual(createdTicket.ticket_id, result.reply_ticket_id, 'Should override ticket_id');
  assert.strictEqual(createdTicket.metadata.kind, 'REPLY', 'Should override kind to REPLY');
  assert.strictEqual(createdTicket.metadata.parent_ticket_id, 'tool-override-test', 'Should override parent_ticket_id');
  assert.strictEqual(createdTicket.metadata.triage_reference_id, 'triage-override-test', 'Should override triage_reference_id');
  assert.ok(createdTicket.metadata.created_at, 'Should have created_at');
  assert.ok(createdTicket.metadata.updated_at, 'Should have updated_at');

  // Template fields preserved
  assert.strictEqual(createdTicket.metadata.prompt_id, 'reply.diplomatic', 'Should have prompt_id from template');
  assert.strictEqual(createdTicket.metadata.candidate_id, 'candidate-override', 'Should have candidate_id from template');
  assert.strictEqual(createdTicket.metadata.reply_input.strategy, 'diplomatic', 'Should have strategy from template');
  assert.strictEqual(createdTicket.metadata.reply_input.context_notes, 'override context', 'Should have context_notes from template');

  // Verify writeDerived called
  assert.strictEqual(toolTicket.derived.reply_ticket_id, result.reply_ticket_id, 'Should write back-reference');

  console.log('[Test] testTemplateOverrideRules: PASS ✓');
  return true;
}

// --- TEST 12: fail-fast - writeDerived throws ---
async function testFailFastWriteDerivedThrows() {
  console.log('[Test] testFailFastWriteDerivedThrows: START');

  // Use a Proxy to intercept writeDerived and throw
  const { writeDerived: originalWriteDerived } = require('../../lib/derivedCompat');
  const derivedCompatModule = require.cache[require.resolve('../../lib/derivedCompat')];
  const originalExports = { ...derivedCompatModule.exports };

  // Mock writeDerived to throw
  derivedCompatModule.exports.writeDerived = () => {
    throw new Error('writeDerived intentionally failed');
  };

  const toolTicket = {
    id: 't-fail',
    metadata: { kind: 'TOOL' }
  };
  const outputs = { tool_verdict: 'PROCEED', reply_strategy: 'test' };
  const triageTicket = { id: 'triage-fail', event: {}, metadata: { candidate_id: 'c-fail' } };
  const store = createStubTicketStore();

  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  try {
    // Need to reload the module to pick up the mocked writeDerived
    delete require.cache[require.resolve('../../lib/deriveReplyTicketFromTool')];
    const deriveReplyTicketFromToolMocked = require('../../lib/deriveReplyTicketFromTool');
    
    await deriveReplyTicketFromToolMocked(toolTicket, outputs, triageTicket, '', store);
    assert.fail('Should throw when writeDerived fails');
  } catch (e) {
    assert.ok(e.message.includes('writeDerived intentionally failed'), 'Should propagate writeDerived error');
  } finally {
    // Restore original writeDerived
    derivedCompatModule.exports = originalExports;
    // Reload the module to restore normal behavior
    delete require.cache[require.resolve('../../lib/deriveReplyTicketFromTool')];
    require('../../lib/deriveReplyTicketFromTool');
  }

  console.log('[Test] testFailFastWriteDerivedThrows: PASS ✓');
  return true;
}

// --- EXPORT ALL TESTS ---
module.exports = {
  testGateKindNotTool,
  testGateReplyDerivationDisabled,
  testGateToolOnlyMode,
  testGateToolVerdictNotProceed,
  testToolVerdictSourceOutputsPrecedence,
  testToolVerdictSourceFallbackFinalOutputs,
  testToolVerdictSourceMalformedOutputs,
  testIdempotencyExistingReplyTicketId,
  testDuplicateRecoveryOrphanFound,
  testDuplicateRecoveryNoOrphanFound,
  testTemplateOverrideRules,
  testFailFastWriteDerivedThrows
};

if (require.main === module) {
  (async () => {
    await testGateKindNotTool();
    await testGateReplyDerivationDisabled();
    await testGateToolOnlyMode();
    await testGateToolVerdictNotProceed();
    await testToolVerdictSourceOutputsPrecedence();
    await testToolVerdictSourceFallbackFinalOutputs();
    await testToolVerdictSourceMalformedOutputs();
    await testIdempotencyExistingReplyTicketId();
    await testDuplicateRecoveryOrphanFound();
    await testDuplicateRecoveryNoOrphanFound();
    await testTemplateOverrideRules();
    await testFailFastWriteDerivedThrows();
    console.log('✅ All derive_tool_reply tests passed');
  })();
}
