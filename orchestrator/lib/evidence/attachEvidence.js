const { apply: applyPolicy } = require('./EvidencePolicy');
const { validateEvidenceItemDetailed, EVIDENCE_STORAGE, EVIDENCE_CODES } = require('./ssot');

/**
 * Minimal integration helper:
 * - Apply policy (inline vs raw)
 * - If raw needed, persist via store and return EvidenceItem (SSOT) + raw_pointer
 *
 * Returns { item } (EvidenceItem). Inline bytes are deliberately not attached
 * to the item (governance metadata only); callers can decide how/where to surface inline.
 */
async function attachEvidence({
  kind,
  source,
  retrieved_at,
  metadata,
  bytes,
  limits,
  store
}) {
  const applied = applyPolicy({ kind, source, retrieved_at, metadata, bytes, limits });

  let item = {
    kind: applied.kind,
    source: applied.source,
    storage: applied.storage,
    code: applied.code || null,
    bytes: applied.bytes,
    stored_bytes: applied.stored_bytes,
    truncated: applied.truncated,
    hash: applied.hash,
    hash_scope: applied.hash_scope,
    inline: applied.inline,
    raw_pointer: null,
    retrieved_at: applied.retrieved_at,
    metadata: applied.metadata || {}
  };

  if (applied.storage === EVIDENCE_STORAGE.RAW) {
    if (applied.raw_bytes && applied.raw_bytes.length > 0) {
      const result = store.write({
        kind,
        source,
        retrieved_at: applied.retrieved_at,
        hash: applied.hash,
        bytes: applied.raw_bytes,
        ext: 'bin'
      });

      if (result.ok) {
        item.raw_pointer = result.raw_pointer;
        // Decision #D.1: stored_bytes must reflect actual persisted bytes.
        if (Number.isInteger(result.stored_bytes) && result.stored_bytes >= 0) {
          item.stored_bytes = result.stored_bytes;
        }
      } else {
        item = {
          ...item,
          storage: EVIDENCE_STORAGE.OMITTED,
          code: EVIDENCE_CODES.WRITE_FAILED,
          raw_pointer: null,
          inline: null,
          stored_bytes: 0
        };
      }
    } else {
      // RAW storage requested but no bytes provided -> treat as omitted.
      item = {
        ...item,
        storage: EVIDENCE_STORAGE.OMITTED,
        code: EVIDENCE_CODES.WRITE_FAILED,
        raw_pointer: null,
        inline: null,
        stored_bytes: 0
      };
    }
  }

  const v = validateEvidenceItemDetailed(item);
  if (!v.ok) {
    throw new Error(`attachEvidence produced invalid EvidenceItem: ${v.code || 'unknown'}`);
  }

  return { item };
}

module.exports = {
  attachEvidence
};
