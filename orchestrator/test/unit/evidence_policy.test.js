const assert = require('assert');

const { apply } = require('../../lib/evidence/EvidencePolicy');
const {
  validateEvidenceItem,
  validateEvidenceItemDetailed,
  EVIDENCE_STORAGE,
  EVIDENCE_CODES,
  EVIDENCE_ERROR_CODES,
  EVIDENCE_HASH_SCOPES
} = require('../../lib/evidence/ssot');

async function runEvidencePolicyTests() {
  console.log('=== M2-A.2 EvidencePolicy Tests ===');

  const limits = { inlineLimitBytes: 64, rawLimitBytes: 128 };

  // A 類：big > inline 但 < raw => storage=raw, truncated=false
  {
    const out = apply({
      kind: 'llm_output',
      source: 'unit_test',
      retrieved_at: new Date().toISOString(),
      metadata: { a: 1 },
      bytes: Buffer.alloc(100, 1),
      limits
    });

    assert.strictEqual(out.storage, EVIDENCE_STORAGE.RAW);
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.code, EVIDENCE_CODES.INLINE_TOO_LARGE);
    assert.strictEqual(out.inline, null);
    assert.ok(Buffer.isBuffer(out.raw_bytes) && out.raw_bytes.length === 100);
    assert.strictEqual(out.hash_scope, EVIDENCE_HASH_SCOPES.STORED);
    // Note: policy stage does not yet have raw_pointer. EvidenceItem validation happens after store write.
    assert.strictEqual(out.raw_pointer, null);
  }

  // A 類：big > raw => storage=omitted, truncated=false, code=RAW_TOO_LARGE
  {
    const out = apply({
      kind: 'tool_output',
      source: 'unit_test',
      retrieved_at: new Date().toISOString(),
      metadata: { b: 2 },
      bytes: Buffer.alloc(200, 2),
      limits
    });

    assert.strictEqual(out.storage, EVIDENCE_STORAGE.OMITTED);
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.code, EVIDENCE_CODES.RAW_TOO_LARGE);
    assert.strictEqual(out.inline, null);
    assert.strictEqual(out.raw_bytes, null);
    assert.ok(typeof out.hash === 'string' && out.hash.startsWith('sha256:'), 'hash should exist');
    assert.strictEqual(out.hash_scope, EVIDENCE_HASH_SCOPES.ORIGINAL);
    assert.ok(!('preview' in out.metadata), 'must not include preview field');
    assert.ok(validateEvidenceItem({
      kind: out.kind,
      source: out.source,
      storage: out.storage,
      code: out.code,
      bytes: out.bytes,
      stored_bytes: out.stored_bytes,
      truncated: out.truncated,
      hash: out.hash,
      hash_scope: out.hash_scope,
      inline: out.inline,
      raw_pointer: null,
      retrieved_at: out.retrieved_at,
      metadata: out.metadata
    }));
  }

  // unknown kind -> A 群：超 rawLimit => omitted + RAW_TOO_LARGE（不截斷、不留 preview）
  {
    const out = apply({
      kind: 'Totally-New:Kind!@#',
      source: 'unit_test',
      retrieved_at: new Date().toISOString(),
      metadata: { note: 'unknown kind should be treated as A' },
      bytes: Buffer.alloc(200, 9),
      limits
    });

    assert.strictEqual(out.storage, EVIDENCE_STORAGE.OMITTED);
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.code, EVIDENCE_CODES.RAW_TOO_LARGE);
    assert.strictEqual(out.inline, null);
    assert.strictEqual(out.raw_bytes, null);
    assert.ok(!('preview' in out.metadata), 'must not include preview field');
  }

  // B 類：big > raw => storage=raw, truncated=true, stored_bytes==rawLimit
  {
    const out = apply({
      kind: 'probe_log',
      source: 'unit_test',
      retrieved_at: new Date().toISOString(),
      metadata: { c: 3 },
      bytes: Buffer.alloc(200, 3),
      limits
    });

    assert.strictEqual(out.storage, EVIDENCE_STORAGE.RAW);
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.inline, null);
    assert.ok(Buffer.isBuffer(out.raw_bytes) && out.raw_bytes.length === 128);
    assert.strictEqual(out.stored_bytes, 128);
    assert.ok(out.metadata && out.metadata.kept_bytes === 128);
    assert.strictEqual(out.hash_scope, EVIDENCE_HASH_SCOPES.STORED);
    // Note: policy stage does not yet have raw_pointer. EvidenceItem validation happens after store write.
    assert.strictEqual(out.raw_pointer, null);
  }

  // C 類：一律 omitted + REDACTED
  {
    const out = apply({
      kind: 'secrets',
      source: 'unit_test',
      retrieved_at: new Date().toISOString(),
      metadata: { d: 4 },
      bytes: Buffer.from('super-secret'),
      limits
    });

    assert.strictEqual(out.storage, EVIDENCE_STORAGE.OMITTED);
    assert.strictEqual(out.code, EVIDENCE_CODES.REDACTED);
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.inline, null);
    assert.strictEqual(out.raw_bytes, null);
    assert.ok(out.metadata && out.metadata.redacted === true);
    assert.ok(validateEvidenceItem({
      kind: out.kind,
      source: out.source,
      storage: out.storage,
      code: out.code,
      bytes: out.bytes,
      stored_bytes: out.stored_bytes,
      truncated: out.truncated,
      hash: out.hash,
      hash_scope: out.hash_scope,
      inline: out.inline,
      raw_pointer: null,
      retrieved_at: out.retrieved_at,
      metadata: out.metadata
    }));
  }

  // omitted（無完整 hash 能力時）=> hash_scope='unknown'
  {
    const out = apply({
      kind: 'llm_output',
      source: 'unit_test',
      retrieved_at: new Date().toISOString(),
      metadata: { scenario: 'bytes unavailable' },
      bytes: null,
      limits
    });

    assert.strictEqual(out.storage, EVIDENCE_STORAGE.OMITTED);
    assert.strictEqual(out.bytes, null);
    assert.strictEqual(out.stored_bytes, 0);
    assert.strictEqual(out.hash, null);
    assert.strictEqual(out.hash_scope, EVIDENCE_HASH_SCOPES.UNKNOWN);
  }

  // truncated 只允許 B：A 類 + truncated=true => validator reject（stable code）
  {
    const v = validateEvidenceItemDetailed({
      kind: 'llm_output',
      source: 'unit_test',
      retrieved_at: new Date().toISOString(),
      storage: EVIDENCE_STORAGE.RAW,
      bytes: 10,
      stored_bytes: 10,
      truncated: true,
      hash: 'sha256:deadbeef',
      hash_scope: EVIDENCE_HASH_SCOPES.STORED,
      inline: null,
      raw_pointer: 'evidence_store/2026-01-02/00000000-0000-0000-0000-000000000000_llm_output.bin',
      metadata: {}
    });

    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.code, EVIDENCE_ERROR_CODES.INVALID_TRUNCATION);
  }

  console.log('Passed: 7, Failed: 0, Total: 7');
  return true;
}

if (require.main === module) {
  runEvidencePolicyTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runAll: runEvidencePolicyTests };
