/**
 * M2-C.1: CutoverPolicy + cutoverMetrics unit tests
 */

const assert = require('assert');
const { createCutoverPolicy } = require('../../lib/compat/CutoverPolicy');
const { createCutoverMetrics } = require('../../lib/compat/cutoverMetrics');

async function testCutoverPolicyModePrePost() {
  const cutoff = 1000;
  const policy = createCutoverPolicy({ cutover_until_ms: cutoff, nowFn: () => 0 });

  assert.strictEqual(policy.mode(0), 'pre_cutover');
  assert.strictEqual(policy.mode(1000), 'pre_cutover');
  assert.strictEqual(policy.mode(1001), 'post_cutover');
  assert.strictEqual(policy.isLegacyWriteAllowed(), false);

  console.log('✅ testCutoverPolicyModePrePost');
}

async function testCutoverMetricsSnapshotStable() {
  const m = createCutoverMetrics();
  m.inc('legacy_read', 'tool_verdict');
  m.inc('legacy_read', 'tool_verdict');
  m.inc('canonical_missing', 'tool_verdict', { source: 'store' });

  const snap = m.snapshot();
  assert.ok(Array.isArray(snap.counters), 'snapshot.counters should be array');

  const legacy = snap.counters.find((r) => r.event_type === 'legacy_read' && r.field === 'tool_verdict');
  const miss = snap.counters.find((r) => r.event_type === 'canonical_missing' && r.field === 'tool_verdict');

  assert.strictEqual(legacy.count, 2);
  assert.strictEqual(miss.count, 1);

  console.log('✅ testCutoverMetricsSnapshotStable');
}
async function runAll() {
  await testCutoverPolicyModePrePost();
  await testCutoverMetricsSnapshotStable();
}

module.exports = {
  runAll
};
