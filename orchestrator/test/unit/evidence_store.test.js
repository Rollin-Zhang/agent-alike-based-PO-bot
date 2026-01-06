const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceStore } = require('../../lib/evidence/EvidenceStore');
const { EVIDENCE_ERROR_CODES, getEvidenceStoreAbsRoot } = require('../../lib/evidence/ssot');

async function runEvidenceStoreTests() {
  console.log('=== M2-A.2 EvidenceStore Tests ===');

  const prevCwd = process.cwd();
  process.chdir(os.tmpdir());
  const store = new EvidenceStore();

  // write() returns raw_pointer under evidence_store/
  {
    const result = store.write({
      kind: 'probe_log',
      source: 'unit_test',
      retrieved_at: new Date().toISOString(),
      hash: 'sha256:deadbeef',
      bytes: Buffer.from('hello'),
      ext: 'txt'
    });

    assert.strictEqual(result.ok, true);
    assert.ok(result.raw_pointer.startsWith('evidence_store/'), 'raw_pointer must start with evidence_store/');

    assert.ok(/^evidence_store\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}_[a-z0-9_]+\.bin$/.test(result.raw_pointer), 'raw_pointer must match fixed format');

    const rel = result.raw_pointer.slice('evidence_store/'.length);
    const abs = path.resolve(getEvidenceStoreAbsRoot(), rel);
    assert.ok(fs.existsSync(abs), 'Evidence file should exist on disk');

    // cleanup (leave directories)
    fs.unlinkSync(abs);
  }

  // Path traversal attempt should return stable reject code
  {
    const result = store.writeAtRawPointer('evidence_store/../pwned.bin', Buffer.from('x'));
    assert.strictEqual(result.ok, false);
    assert.ok(
      result.code === EVIDENCE_ERROR_CODES.PATH_TRAVERSAL || result.code === EVIDENCE_ERROR_CODES.INVALID_POINTER,
      `expected stable reject code, got ${result.code}`
    );
  }

  process.chdir(prevCwd);

  console.log('Passed: 2, Failed: 0, Total: 2');
  return true;
}

if (require.main === module) {
  runEvidenceStoreTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runAll: runEvidenceStoreTests };
