/**
 * Stage 2: Canonical tool verdict helpers (M2-C.2)
 */

const assert = require('assert');
const {
  VALID_STATUSES,
  normalizeToolVerdict,
  readToolVerdict,
  isProceed
} = require('../../lib/toolVerdict');

async function testValidStatusesStable() {
  assert.deepStrictEqual(VALID_STATUSES, ['PROCEED', 'DEFER', 'BLOCK']);
  console.log('✅ testValidStatusesStable');
}

async function testNormalizeToolVerdictStringAndObject() {
  assert.deepStrictEqual(normalizeToolVerdict('proceed'), { status: 'PROCEED' });
  assert.deepStrictEqual(normalizeToolVerdict({ status: 'DEFER' }), { status: 'DEFER' });
  assert.deepStrictEqual(
    normalizeToolVerdict({ status: 'BLOCK', reason: 'nope' }),
    { status: 'BLOCK', reason: 'nope' }
  );
  assert.strictEqual(normalizeToolVerdict(null), null);

  const invalid = normalizeToolVerdict('INVALID');
  assert.strictEqual(invalid.status, null);
  assert.ok(invalid.invalid_status, 'invalid_status should be present');

  console.log('✅ testNormalizeToolVerdictStringAndObject');
}

async function testReadToolVerdictPrecedence() {
  const ticket = { tool_verdict: { status: 'DEFER' } };
  const outputs = { tool_verdict: 'PROCEED' };
  const v = readToolVerdict(outputs, ticket);
  assert.strictEqual(v.status, 'PROCEED');
  assert.strictEqual(v.source, 'outputs.tool_verdict');
  assert.strictEqual(isProceed(v), true);

  const v2 = readToolVerdict({}, ticket);
  assert.strictEqual(v2.status, 'DEFER');
  assert.strictEqual(v2.source, 'ticket.tool_verdict');
  assert.strictEqual(isProceed(v2), false);

  console.log('✅ testReadToolVerdictPrecedence');
}

module.exports = {
  testValidStatusesStable,
  testNormalizeToolVerdictStringAndObject,
  testReadToolVerdictPrecedence
};
