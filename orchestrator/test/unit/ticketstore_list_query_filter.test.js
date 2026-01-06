/**
 * test/unit/ticketstore_list_query_filter.test.js
 *
 * Regression tests for TicketStore.list query filtering behavior.
 * Focus:
 * - No filter keys: behavior matches legacy (status/limit/offset only)
 * - Dotted path missing: does not throw; treated as non-match
 * - Friendly aliases: kind / parent_ticket_id supported at root level
 */

const assert = require('assert');
const TicketStore = require('../../store/TicketStore');

async function testListNoFilterKeysEquivalentLegacy() {
  console.log('[Test] testListNoFilterKeysEquivalentLegacy: START');

  const store = new TicketStore();

  await store.create({
    id: 't1',
    ticket_id: 't1',
    type: 'DraftTicket',
    status: 'pending',
    flow_id: 'triage_zh_hant_v1',
    metadata: { created_at: '2020-01-01T00:00:00.000Z', kind: 'TRIAGE' }
  });

  await store.create({
    id: 't2',
    ticket_id: 't2',
    type: 'DraftTicket',
    status: 'pending',
    flow_id: 'reply_zh_hant_v1',
    metadata: { created_at: '2020-01-02T00:00:00.000Z', kind: 'REPLY' }
  });

  const first = await store.list({ limit: 1 });
  assert.strictEqual(first.length, 1, 'Should return one ticket');
  assert.strictEqual(first[0].id, 't1', 'Should return oldest ticket first (FIFO)');

  const pending = await store.list({ status: 'pending', limit: 10, offset: 0 });
  assert.strictEqual(pending.length, 2, 'Should return all pending tickets');

  console.log('[Test] testListNoFilterKeysEquivalentLegacy: PASS ✓');
  return true;
}

async function testListDottedPathMissingDoesNotThrowAndDoesNotMatch() {
  console.log('[Test] testListDottedPathMissingDoesNotThrowAndDoesNotMatch: START');

  const store = new TicketStore();

  await store.create({
    id: 't1',
    ticket_id: 't1',
    type: 'DraftTicket',
    status: 'pending',
    flow_id: 'triage_zh_hant_v1',
    metadata: { created_at: '2020-01-01T00:00:00.000Z', kind: 'TRIAGE' }
  });

  // Dotted path points into a missing subtree; should not throw.
  const result = await store.list({ 'metadata.reply_input.strategy': 'standard' });
  assert.deepStrictEqual(result, [], 'Missing dotted path should be treated as non-match');

  console.log('[Test] testListDottedPathMissingDoesNotThrowAndDoesNotMatch: PASS ✓');
  return true;
}

async function testListAliasKindAndParentTicketId() {
  console.log('[Test] testListAliasKindAndParentTicketId: START');

  const store = new TicketStore();

  await store.create({
    id: 'tool1',
    ticket_id: 'tool1',
    type: 'ToolTicket',
    status: 'pending',
    flow_id: 'tool_execution_v1',
    metadata: {
      created_at: '2020-01-01T00:00:00.000Z',
      kind: 'TOOL',
      parent_ticket_id: 'triage1'
    }
  });

  await store.create({
    id: 'reply1',
    ticket_id: 'reply1',
    type: 'DraftTicket',
    status: 'pending',
    flow_id: 'reply_zh_hant_v1',
    metadata: {
      created_at: '2020-01-02T00:00:00.000Z',
      kind: 'REPLY',
      parent_ticket_id: 'tool1'
    }
  });

  const byKindAlias = await store.list({ kind: 'REPLY' });
  assert.strictEqual(byKindAlias.length, 1, 'kind alias should filter');
  assert.strictEqual(byKindAlias[0].id, 'reply1', 'kind alias should return REPLY ticket');

  const byParentAlias = await store.list({ parent_ticket_id: 'triage1' });
  assert.strictEqual(byParentAlias.length, 1, 'parent_ticket_id alias should filter');
  assert.strictEqual(byParentAlias[0].id, 'tool1', 'parent_ticket_id alias should return TOOL ticket');

  console.log('[Test] testListAliasKindAndParentTicketId: PASS ✓');
  return true;
}

module.exports = {
  testListNoFilterKeysEquivalentLegacy,
  testListDottedPathMissingDoesNotThrowAndDoesNotMatch,
  testListAliasKindAndParentTicketId
};
