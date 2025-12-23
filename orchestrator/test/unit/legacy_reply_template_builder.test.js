/**
 * test/unit/legacy_reply_template_builder.test.js
 * 
 * Unit tests for buildLegacyReplyTicketTemplate
 * Commit 6B.1: Pure function extraction for REPLY ticket creation
 */

const assert = require('assert');
const { buildLegacyReplyTicketTemplate } = require('../../lib/buildLegacyReplyTicketTemplate');

function testBuildLegacyReplyTicketTemplate() {
  console.log('[Test] testBuildLegacyReplyTicketTemplate: START');

  const triageTicket = Object.freeze({
    id: 'triage-123',
    event: { post_id: 'post-456', thread_id: 'thread-789' },
    metadata: {
      candidate_id: 'candidate-abc',
      kind: 'TRIAGE'
    }
  });

  const replyTicketId = 'reply-xyz';
  const outputs = {
    reply_strategy: 'empathetic',
    target_prompt_id: 'reply.empathetic'
  };
  const fetchedContext = 'Context line 1\nContext line 2';

  const result = buildLegacyReplyTicketTemplate(triageTicket, replyTicketId, outputs, fetchedContext);

  // DoD: 回傳物件包含所需欄位
  assert.strictEqual(result.id, replyTicketId, 'Should have correct id');
  assert.strictEqual(result.ticket_id, replyTicketId, 'Should have correct ticket_id');
  assert.strictEqual(result.type, 'DraftTicket', 'Should have type=DraftTicket');
  assert.strictEqual(result.status, 'pending', 'Should have status=pending');
  assert.strictEqual(result.flow_id, 'reply_zh_hant_v1', 'Should have correct flow_id');
  assert.deepStrictEqual(result.event, triageTicket.event, 'Should copy event from triageTicket');

  // DoD: metadata.kind === "REPLY"
  assert.strictEqual(result.metadata.kind, 'REPLY', 'metadata.kind should be REPLY');
  assert.strictEqual(result.metadata.triage_reference_id, triageTicket.id, 'Should reference triage ticket');
  assert.strictEqual(result.metadata.candidate_id, triageTicket.metadata.candidate_id, 'Should copy candidate_id');
  assert.strictEqual(result.metadata.prompt_id, 'reply.empathetic', 'Should use target_prompt_id from outputs');
  assert.strictEqual(result.metadata.reply_input.strategy, 'empathetic', 'Should include reply_strategy');
  assert.strictEqual(result.metadata.reply_input.context_notes, fetchedContext, 'Should include context_notes');

  // DoD: 不修改 triageTicket (immutable) - Object.freeze 會阻止修改
  assert.strictEqual(triageTicket.id, 'triage-123', 'triageTicket should remain unchanged');
  assert.strictEqual(triageTicket.metadata.kind, 'TRIAGE', 'triageTicket metadata should remain unchanged');

  console.log('[Test] testBuildLegacyReplyTicketTemplate: PASS ✓');
  return true;
}

function testBuildLegacyReplyTicketTemplateDefaultPromptId() {
  console.log('[Test] testBuildLegacyReplyTicketTemplateDefaultPromptId: START');

  const triageTicket = {
    id: 'triage-999',
    event: { post_id: 'post-111' },
    metadata: { candidate_id: 'cand-222', kind: 'TRIAGE' }
  };

  const replyTicketId = 'reply-888';
  const outputs = { reply_strategy: 'standard' }; // No target_prompt_id

  const result = buildLegacyReplyTicketTemplate(triageTicket, replyTicketId, outputs, '');

  assert.strictEqual(result.metadata.prompt_id, 'reply.standard', 'Should default to reply.standard');
  assert.strictEqual(result.metadata.reply_input.context_notes, '', 'Should handle empty context_notes');

  console.log('[Test] testBuildLegacyReplyTicketTemplateDefaultPromptId: PASS ✓');
  return true;
}

function testBuildLegacyReplyTicketTemplateValidation() {
  console.log('[Test] testBuildLegacyReplyTicketTemplateValidation: START');

  // Should throw on missing triageTicket
  try {
    buildLegacyReplyTicketTemplate(null, 'id', {}, '');
    assert.fail('Should throw on missing triageTicket');
  } catch (e) {
    assert.ok(e.message.includes('triageTicket is required'), 'Should validate triageTicket');
  }

  // Should throw on missing replyTicketId
  try {
    buildLegacyReplyTicketTemplate({ id: 't1', event: {}, metadata: {} }, null, {}, '');
    assert.fail('Should throw on missing replyTicketId');
  } catch (e) {
    assert.ok(e.message.includes('replyTicketId is required'), 'Should validate replyTicketId');
  }

  // Should throw on missing outputs
  try {
    buildLegacyReplyTicketTemplate({ id: 't1', event: {}, metadata: {} }, 'r1', null, '');
    assert.fail('Should throw on missing outputs');
  } catch (e) {
    assert.ok(e.message.includes('outputs is required'), 'Should validate outputs');
  }

  console.log('[Test] testBuildLegacyReplyTicketTemplateValidation: PASS ✓');
  return true;
}

module.exports = { 
  testBuildLegacyReplyTicketTemplate,
  testBuildLegacyReplyTicketTemplateDefaultPromptId,
  testBuildLegacyReplyTicketTemplateValidation
};

if (require.main === module) {
  testBuildLegacyReplyTicketTemplate();
  testBuildLegacyReplyTicketTemplateDefaultPromptId();
  testBuildLegacyReplyTicketTemplateValidation();
  console.log('✅ All legacy_reply_template_builder tests passed');
}
