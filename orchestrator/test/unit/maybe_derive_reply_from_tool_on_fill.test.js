/**
 * test/unit/maybe_derive_reply_from_tool_on_fill.test.js
 *
 * Unit tests for the /fill TOOL→REPLY wiring helper.
 * Focus: missing parent TRIAGE is handled safely (log + skip), not via crash.
 */

const assert = require('assert');
const { maybeDeriveReplyFromToolOnFill } = require('../../lib/maybeDeriveReplyFromToolOnFill');
const TicketStore = require('../../store/TicketStore');

function makeLoggerStub() {
  const calls = { warn: [] };
  return {
    calls,
    warn: (msg, meta) => calls.warn.push({ msg, meta })
  };
}

async function testSkipWhenNotTool() {
  console.log('[Test] testSkipWhenNotTool: START');

  const logger = makeLoggerStub();
  const store = { get: async () => { throw new Error('should not call get'); } };

  const result = await maybeDeriveReplyFromToolOnFill(
    { id: 't1', metadata: { kind: 'TRIAGE' } },
    { tool_verdict: 'PROCEED' },
    store,
    logger
  );

  assert.strictEqual(result.attempted, false);
  assert.strictEqual(result.reason, 'not_tool');
  assert.strictEqual(logger.calls.warn.length, 0);

  console.log('[Test] testSkipWhenNotTool: PASS ✓');
  return true;
}

async function testSkipWhenMissingParentTicketId() {
  console.log('[Test] testSkipWhenMissingParentTicketId: START');

  const logger = makeLoggerStub();
  const store = { get: async () => { throw new Error('should not call get'); } };

  const result = await maybeDeriveReplyFromToolOnFill(
    { id: 'tool1', metadata: { kind: 'TOOL' } },
    { tool_verdict: 'PROCEED' },
    store,
    logger
  );

  assert.strictEqual(result.attempted, false);
  assert.strictEqual(result.reason, 'missing_parent_ticket_id');
  assert.strictEqual(logger.calls.warn.length, 1);
  assert.strictEqual(logger.calls.warn[0].msg, '[derive] TOOL -> REPLY skipped: missing parent TRIAGE');

  console.log('[Test] testSkipWhenMissingParentTicketId: PASS ✓');
  return true;
}

async function testSkipWhenParentTriageMissingInStore() {
  console.log('[Test] testSkipWhenParentTriageMissingInStore: START');

  const logger = makeLoggerStub();
  const store = { get: async () => null };

  const result = await maybeDeriveReplyFromToolOnFill(
    { id: 'tool1', metadata: { kind: 'TOOL', parent_ticket_id: 'triage-missing' } },
    { tool_verdict: 'PROCEED' },
    store,
    logger
  );

  assert.strictEqual(result.attempted, false);
  assert.strictEqual(result.reason, 'missing_parent_triage_ticket');
  assert.strictEqual(logger.calls.warn.length, 1);
  assert.strictEqual(logger.calls.warn[0].msg, '[derive] TOOL -> REPLY skipped: missing parent TRIAGE');

  console.log('[Test] testSkipWhenParentTriageMissingInStore: PASS ✓');
  return true;
}

async function testIdempotencyDoubleCallDoesNotCreateDuplicateReply() {
  console.log('[Test] testIdempotencyDoubleCallDoesNotCreateDuplicateReply: START');

  const originalEnable = process.env.ENABLE_REPLY_DERIVATION;
  const originalToolOnly = process.env.TOOL_ONLY_MODE;
  process.env.ENABLE_REPLY_DERIVATION = 'true';
  process.env.TOOL_ONLY_MODE = 'false';

  try {
    const logger = { warn: () => {}, info: () => {}, error: () => {} };
    const store = new TicketStore();

    const triageTicket = {
      id: 'triage-1',
      ticket_id: 'triage-1',
      type: 'DraftTicket',
      status: 'pending',
      event: {},
      metadata: { kind: 'TRIAGE' }
    };

    const toolTicket = {
      id: 'tool-1',
      ticket_id: 'tool-1',
      type: 'DraftTicket',
      status: 'done',
      event: {},
      metadata: { kind: 'TOOL', parent_ticket_id: triageTicket.id }
    };

    await store.create(triageTicket);
    await store.create(toolTicket);

    const outputs = { tool_verdict: 'PROCEED', tool_context: { evidence: [] } };

    const r1 = await maybeDeriveReplyFromToolOnFill(toolTicket, outputs, store, logger);
    assert.strictEqual(r1.attempted, true);
    assert.strictEqual(r1.created, true);
    assert.ok(r1.reply_ticket_id);

    const repliesAfterFirst = await store.list({
      type: 'DraftTicket',
      'metadata.kind': 'REPLY',
      'metadata.parent_ticket_id': toolTicket.id
    });
    assert.strictEqual(repliesAfterFirst.length, 1, 'Should have exactly 1 REPLY after first call');

    const r2 = await maybeDeriveReplyFromToolOnFill(toolTicket, outputs, store, logger);
    assert.strictEqual(r2.attempted, true);
    assert.strictEqual(r2.reason, 'idempotent');

    const repliesAfterSecond = await store.list({
      type: 'DraftTicket',
      'metadata.kind': 'REPLY',
      'metadata.parent_ticket_id': toolTicket.id
    });
    assert.strictEqual(repliesAfterSecond.length, 1, 'Should still have exactly 1 REPLY after second call');
  } finally {
    process.env.ENABLE_REPLY_DERIVATION = originalEnable;
    process.env.TOOL_ONLY_MODE = originalToolOnly;
  }

  console.log('[Test] testIdempotencyDoubleCallDoesNotCreateDuplicateReply: PASS ✓');
  return true;
}

module.exports = {
  testSkipWhenNotTool,
  testSkipWhenMissingParentTicketId,
  testSkipWhenParentTriageMissingInStore,
  testIdempotencyDoubleCallDoesNotCreateDuplicateReply
};
