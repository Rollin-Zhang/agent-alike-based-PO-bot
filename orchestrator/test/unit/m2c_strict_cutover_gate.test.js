/**
 * M2-C.1: strictCutoverGate unit tests
 */

const assert = require('assert');
const { createCutoverPolicy } = require('../../lib/compat/CutoverPolicy');
const { createCutoverMetrics } = require('../../lib/compat/cutoverMetrics');
const { canEnableStrict } = require('../../lib/compat/strictCutoverGate');

async function testStrictGateRulesPreAndPost() {
  const m = createCutoverMetrics();

  // pre-cutover: legacy_read can be > 0
  m.inc('legacy_read', 'tool_verdict', { source: 'compat' });
  const pre = canEnableStrict({
    policy: createCutoverPolicy({ cutover_until_ms: 1000, nowFn: () => 0 }),
    nowMs: 0,
    metricsSnapshot: m.snapshot()
  });
  assert.strictEqual(pre.ok, true);

  // post-cutover: legacy_read must be 0
  const post = canEnableStrict({
    policy: createCutoverPolicy({ cutover_until_ms: 1000, nowFn: () => 2000 }),
    nowMs: 2000,
    metricsSnapshot: m.snapshot()
  });
  assert.strictEqual(post.ok, false);
  assert.ok(post.reasons.includes('legacy_read_post_cutover_nonzero'));

  // canonical_missing blocks both modes (this is the primary safety signal)
  const m2 = createCutoverMetrics();
  m2.inc('canonical_missing', 'tool_verdict', { source: 'store' });
  const pre2 = canEnableStrict({
    policy: createCutoverPolicy({ cutover_until_ms: 1000, nowFn: () => 0 }),
    nowMs: 0,
    metricsSnapshot: m2.snapshot()
  });
  assert.strictEqual(pre2.ok, false);
  assert.ok(pre2.reasons.includes('canonical_missing_nonzero'));

  console.log('✅ testStrictGateRulesPreAndPost');
}

async function runAll() {
  await testStrictGateRulesPreAndPost();
}

module.exports = {
  runAll
};
