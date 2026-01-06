const crypto = require('crypto');

const {
  classifyEvidenceKind,
  EVIDENCE_STORAGE,
  EVIDENCE_CODES,
  EVIDENCE_HASH_SCOPES,
  sanitizeKindForFilename
} = require('./ssot');

function toBuffer(input) {
  if (input === null || input === undefined) return null;
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (input instanceof Uint8Array) return Buffer.from(input);
  throw new Error('Unsupported bytes input type');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Tag(buf) {
  return `sha256:${sha256Hex(buf)}`;
}

/**
 * EvidencePolicy.apply(...) -> applied evidence decision (pure function)
 *
 * Output fields include:
 * - inline: base64 string or null
 * - raw_pointer: always null at policy stage (store decides)
 * - raw_bytes: Buffer|null (bytes to persist when inline is null)
 */
function apply({
  kind,
  source,
  bytes,
  retrieved_at,
  metadata = {},
  limits
}) {
  const buf = toBuffer(bytes);
  const hasBytes = Buffer.isBuffer(buf);
  const originalBytes = hasBytes ? buf.length : null;

  const inlineLimitBytes = Number(limits && limits.inlineLimitBytes);
  const rawLimitBytes = Number(limits && limits.rawLimitBytes);

  if (!Number.isFinite(inlineLimitBytes) || inlineLimitBytes < 0) {
    throw new Error('EvidencePolicy: limits.inlineLimitBytes must be a non-negative number');
  }
  if (!Number.isFinite(rawLimitBytes) || rawLimitBytes < 0) {
    throw new Error('EvidencePolicy: limits.rawLimitBytes must be a non-negative number');
  }

  const nowIso = new Date().toISOString();
  const safeKind = String(kind || '');
  const safeSource = String(source || '');
  const safeRetrievedAt = String(retrieved_at || nowIso);
  const safeMetadata = (metadata && typeof metadata === 'object') ? metadata : {};
  const kind_sanitized = sanitizeKindForFilename(safeKind);
  const metadataWithKind = { ...safeMetadata };
  if (metadataWithKind.original_kind === undefined) metadataWithKind.original_kind = safeKind;
  if (metadataWithKind.kind_sanitized === undefined) metadataWithKind.kind_sanitized = kind_sanitized;

  const group = classifyEvidenceKind(safeKind);

  // bytes unavailable (future streaming support): omit and avoid misleading hash.
  if (!hasBytes) {
    return {
      kind: safeKind,
      source: safeSource,
      storage: EVIDENCE_STORAGE.OMITTED,
      code: null,
      bytes: null,
      stored_bytes: 0,
      truncated: false,
      hash: null,
      hash_scope: EVIDENCE_HASH_SCOPES.UNKNOWN,
      inline: null,
      raw_pointer: null,
      raw_bytes: null,
      retrieved_at: safeRetrievedAt,
      metadata: { ...metadataWithKind, bytes_unavailable: true }
    };
  }

  // C: sensitive - must not persist
  if (group === 'C') {
    return {
      kind: safeKind,
      source: safeSource,
      storage: EVIDENCE_STORAGE.OMITTED,
      code: EVIDENCE_CODES.REDACTED,
      bytes: originalBytes,
      stored_bytes: 0,
      truncated: false,
      hash: null,
      hash_scope: EVIDENCE_HASH_SCOPES.UNKNOWN,
      inline: null,
      raw_pointer: null,
      raw_bytes: null,
      retrieved_at: safeRetrievedAt,
      metadata: { ...metadataWithKind, redacted: true }
    };
  }

  // Inline path (applies to both A and B)
  if (originalBytes <= inlineLimitBytes) {
    const hash = sha256Tag(buf);
    return {
      kind: safeKind,
      source: safeSource,
      storage: EVIDENCE_STORAGE.INLINE,
      code: null,
      bytes: originalBytes,
      stored_bytes: originalBytes,
      truncated: false,
      hash,
      hash_scope: EVIDENCE_HASH_SCOPES.STORED,
      inline: buf.toString('base64'),
      raw_pointer: null,
      raw_bytes: null,
      retrieved_at: safeRetrievedAt,
      metadata: metadataWithKind
    };
  }

  // Non-inline: must go raw or omitted.
  // A: do NOT truncate. If too large for raw storage, omit with stable code.
  if (group === 'A') {
    if (originalBytes > rawLimitBytes) {
      // Too large to store raw; do not store partial.
      const hash = sha256Tag(buf);
      return {
        kind: safeKind,
        source: safeSource,
        storage: EVIDENCE_STORAGE.OMITTED,
        code: EVIDENCE_CODES.RAW_TOO_LARGE,
        bytes: originalBytes,
        stored_bytes: 0,
        truncated: false,
        hash,
        hash_scope: EVIDENCE_HASH_SCOPES.ORIGINAL,
        inline: null,
        raw_pointer: null,
        raw_bytes: null,
        retrieved_at: safeRetrievedAt,
        metadata: {
          ...metadataWithKind,
          original_bytes: originalBytes,
          inline_limit_bytes: inlineLimitBytes,
          raw_limit_bytes: rawLimitBytes,
          reason: 'RAW_TOO_LARGE'
        }
      };
    }

    const hash = sha256Tag(buf);
    return {
      kind: safeKind,
      source: safeSource,
      storage: EVIDENCE_STORAGE.RAW,
      code: EVIDENCE_CODES.INLINE_TOO_LARGE,
      bytes: originalBytes,
      stored_bytes: originalBytes,
      truncated: false,
      hash,
      hash_scope: EVIDENCE_HASH_SCOPES.STORED,
      inline: null,
      raw_pointer: null,
      raw_bytes: buf,
      retrieved_at: safeRetrievedAt,
      metadata: {
        ...metadataWithKind,
        original_bytes: originalBytes,
        inline_limit_bytes: inlineLimitBytes,
        raw_limit_bytes: rawLimitBytes,
        reason: 'INLINE_TOO_LARGE'
      }
    };
  }

  // B: diagnostic - truncation allowed when exceeding rawLimitBytes.
  // Simplest truncation policy: head-only.
  let truncated = false;
  let kept = buf;
  if (originalBytes > rawLimitBytes) {
    truncated = true;
    kept = buf.subarray(0, rawLimitBytes);
  }

  const hash = sha256Tag(kept);
  return {
    kind: safeKind,
    source: safeSource,
    storage: EVIDENCE_STORAGE.RAW,
    code: EVIDENCE_CODES.INLINE_TOO_LARGE,
    bytes: originalBytes,
    stored_bytes: kept.length,
    truncated,
    hash,
    hash_scope: EVIDENCE_HASH_SCOPES.STORED,
    inline: null,
    raw_pointer: null,
    raw_bytes: kept,
    retrieved_at: safeRetrievedAt,
    metadata: {
      ...metadataWithKind,
      original_bytes: originalBytes,
      inline_limit_bytes: inlineLimitBytes,
      raw_limit_bytes: rawLimitBytes,
      truncate_policy: truncated ? 'head' : null,
      kept_bytes: kept.length
    }
  };
}

module.exports = {
  apply
};
