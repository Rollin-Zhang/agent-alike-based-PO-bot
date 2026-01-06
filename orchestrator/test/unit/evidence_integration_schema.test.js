const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { EvidenceStore } = require('../../lib/evidence/EvidenceStore');
const { attachEvidence } = require('../../lib/evidence/attachEvidence');
const { validateEvidenceItem, EVIDENCE_STORAGE, EVIDENCE_HASH_SCOPES, getEvidenceStoreAbsRoot } = require('../../lib/evidence/ssot');

async function runEvidenceIntegrationSchemaTests() {
  console.log('=== M2-A.2 Evidence Integration Schema Tests ===');

  const store = new EvidenceStore();

  const limits = { inlineLimitBytes: 64, rawLimitBytes: 128 };

  // Force raw storage path (bytes > inlineMaxBytes)
  const { item } = await attachEvidence({
    kind: 'probe',
    source: 'integration_test',
    retrieved_at: new Date().toISOString(),
    metadata: { scenario: 'raw_pointer' },
    bytes: Buffer.alloc(100, 7),
    limits,
    store
  });

  assert.ok(validateEvidenceItem(item), 'EvidenceItem should validate');
  assert.strictEqual(item.source, 'integration_test');
  assert.strictEqual(item.storage, EVIDENCE_STORAGE.RAW);
  assert.strictEqual(item.truncated, false);
  assert.strictEqual(item.bytes, 100);
  assert.strictEqual(item.hash_scope, EVIDENCE_HASH_SCOPES.STORED);
  assert.ok(typeof item.hash === 'string' && item.hash.startsWith('sha256:'));
  assert.ok(typeof item.raw_pointer === 'string' && item.raw_pointer.startsWith('evidence_store/'));

  const rel = item.raw_pointer.slice('evidence_store/'.length);
  const abs = path.resolve(getEvidenceStoreAbsRoot(), rel);
  assert.ok(fs.existsSync(abs), 'Evidence file should exist for raw_pointer');

  const st = fs.statSync(abs);
  assert.strictEqual(item.stored_bytes, st.size);

  // cleanup (leave directories)
  fs.unlinkSync(abs);

  console.log('Passed: 1, Failed: 0, Total: 1');
  return true;
}

if (require.main === module) {
  runEvidenceIntegrationSchemaTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runAll: runEvidenceIntegrationSchemaTests };
