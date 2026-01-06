'use strict';

const EVIDENCE_REASON_RUNTIME = Object.freeze({
  // Runtime stable codes (allow-list). Keep low-cardinality.
  LEASE_OWNER_MISMATCH: 'lease_owner_mismatch'
});

const EVIDENCE_REASON_INTEGRITY = Object.freeze({
  ARTIFACT_SHA_MISMATCH: 'artifact_sha_mismatch',
  ARTIFACT_MISSING: 'artifact_missing',
  MANIFEST_SCHEMA_INVALID: 'manifest_schema_invalid',
  MODE_SNAPSHOT_REF_NOT_LISTED: 'mode_snapshot_ref_not_listed',
  DETAILS_REF_NOT_LISTED: 'details_ref_not_listed',
  MANIFEST_SELF_INTEGRITY_FAILED: 'manifest_self_integrity_failed',
  DUPLICATE_ARTIFACT_PATH: 'duplicate_artifact_path',
  DUPLICATE_CHECK_NAME: 'duplicate_check_name'
});

function isEvidenceReason(code) {
  const c = String(code || '');
  if (!c) return false;
  return Object.values(EVIDENCE_REASON_RUNTIME).includes(c) ||
    Object.values(EVIDENCE_REASON_INTEGRITY).includes(c);
}

module.exports = {
  EVIDENCE_REASON_RUNTIME,
  EVIDENCE_REASON_INTEGRITY,
  isEvidenceReason
};
/**
 * Evidence SSOT (Single Source of Truth)
 *
 * Contract:
 * - raw_pointer root MUST be under evidence_store/ (never logs/)
 * - Guardrails must return stable codes (not throw-string matching)
 */

const crypto = require('crypto');
const path = require('path');

const EVIDENCE_STORE_ROOT = 'evidence_store';

// Decision #1: unknown kind defaults to A (semantic, do NOT truncate).
const UNKNOWN_KIND_GROUP = 'A';

// Governance: stable limit dimensions (values are configurable, semantics are fixed).
const DEFAULT_EVIDENCE_LIMITS = Object.freeze({
  inlineLimitBytes: 64,   // conservative for CI; override via ENV for real usage
  rawLimitBytes: 128,     // conservative for CI; override via ENV for real usage
  // Retention / sampling knobs (SSOT only for now; enforcement can be added later)
  maxItemsPerReport: 50,
  // Decision #6: maxItemsPerReport future enforcement strategy is fixed.
  // Ordering semantics note: when applied to probe evidence collection,
  // "first" means probe execution order (currently registry order).
  maxItemsStrategy: 'keep_first_n',
  retentionDays: 7
});

const EVIDENCE_LIMIT_ENV_KEYS = Object.freeze({
  INLINE_LIMIT_BYTES: 'EVIDENCE_INLINE_LIMIT_BYTES',
  RAW_LIMIT_BYTES: 'EVIDENCE_RAW_LIMIT_BYTES',
  MAX_ITEMS_PER_REPORT: 'EVIDENCE_MAX_ITEMS_PER_REPORT',
  RETENTION_DAYS: 'EVIDENCE_RETENTION_DAYS'
});

function clampNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i < 0 ? fallback : i;
}

function getEvidenceLimitsFromEnv(env = process.env) {
  return {
    inlineLimitBytes: clampNonNegativeInt(env[EVIDENCE_LIMIT_ENV_KEYS.INLINE_LIMIT_BYTES], DEFAULT_EVIDENCE_LIMITS.inlineLimitBytes),
    rawLimitBytes: clampNonNegativeInt(env[EVIDENCE_LIMIT_ENV_KEYS.RAW_LIMIT_BYTES], DEFAULT_EVIDENCE_LIMITS.rawLimitBytes),
    maxItemsPerReport: clampNonNegativeInt(env[EVIDENCE_LIMIT_ENV_KEYS.MAX_ITEMS_PER_REPORT], DEFAULT_EVIDENCE_LIMITS.maxItemsPerReport),
    // maxItemsStrategy is SSOT-fixed; do not allow ENV override.
    maxItemsStrategy: DEFAULT_EVIDENCE_LIMITS.maxItemsStrategy,
    retentionDays: clampNonNegativeInt(env[EVIDENCE_LIMIT_ENV_KEYS.RETENTION_DAYS], DEFAULT_EVIDENCE_LIMITS.retentionDays)
  };
}

// Type-driven governance: kind groups drive behavior.
const EVIDENCE_KIND_GROUPS = Object.freeze({
  // A: semantic completeness required (do NOT truncate)
  A: new Set(['llm_output', 'tool_output', 'final_reply', 'structured_result_json']),
  // B: diagnostic/observability (truncate allowed)
  B: new Set(['probe_log', 'stderr', 'http_body_preview', 'trace']),
  // C: sensitive / must not persist
  C: new Set(['secrets', 'credentials', 'pii_raw'])
});

function classifyEvidenceKind(kind) {
  const k = String(kind || '').trim();
  if (EVIDENCE_KIND_GROUPS.C.has(k)) return 'C';
  if (EVIDENCE_KIND_GROUPS.A.has(k)) return 'A';
  if (EVIDENCE_KIND_GROUPS.B.has(k)) return 'B';
  return UNKNOWN_KIND_GROUP;
}

const EVIDENCE_STORAGE = Object.freeze({
  INLINE: 'inline',
  RAW: 'raw',
  OMITTED: 'omitted'
});

const EVIDENCE_CODES = Object.freeze({
  INLINE_TOO_LARGE: 'EVIDENCE_INLINE_TOO_LARGE',
  RAW_TOO_LARGE: 'EVIDENCE_RAW_TOO_LARGE',
  REDACTED: 'EVIDENCE_REDACTED',
  WRITE_FAILED: 'EVIDENCE_WRITE_FAILED'
});

const EVIDENCE_ERROR_CODES = Object.freeze({
  PATH_TRAVERSAL: 'EVIDENCE_PATH_TRAVERSAL',
  INVALID_POINTER: 'EVIDENCE_INVALID_POINTER',
  WRITE_FAILED: 'EVIDENCE_WRITE_FAILED',
  INVALID_ITEM: 'EVIDENCE_INVALID_ITEM',
  INVALID_TRUNCATION: 'EVIDENCE_INVALID_TRUNCATION'
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIso8601(value) {
  if (typeof value !== 'string') return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function sanitizePathSegment(value) {
  const raw = String(value || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'unknown').slice(0, 64);
}

function sanitizeKindForFilename(kind) {
  const raw = String(kind || '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'unknown').slice(0, 64);
}

function getOrchestratorRootAbs() {
  // Fixed orchestrator root; do not derive from process.cwd().
  return path.resolve(__dirname, '..', '..');
}

function getEvidenceStoreAbsRoot() {
  return path.resolve(getOrchestratorRootAbs(), EVIDENCE_STORE_ROOT);
}

function validateRawPointer(raw_pointer) {
  if (typeof raw_pointer !== 'string' || raw_pointer.length === 0) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_POINTER };
  }

  // Must be relative and POSIX-like.
  if (raw_pointer.startsWith('/') || raw_pointer.startsWith('~')) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_POINTER };
  }
  if (raw_pointer.includes('\\') || raw_pointer.includes('\u0000')) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_POINTER };
  }

  // Must be under evidence_store/ and match fixed format.
  const prefix = `${EVIDENCE_STORE_ROOT}/`;
  if (!raw_pointer.startsWith(prefix)) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_POINTER };
  }

  // Format: evidence_store/<yyyy-mm-dd>/<uuid>_<kind>.bin
  const rel = raw_pointer.slice(prefix.length);
  const parts = rel.split('/');
  if (parts.length !== 2) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_POINTER };
  }

  const [datePart, filePart] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_POINTER };
  }

  const fileOk = /^[0-9a-fA-F-]{36}_[a-z0-9_]+\.bin$/.test(filePart);
  if (!fileOk) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_POINTER };
  }

  if (rel.split('/').some(p => p === '..' || p === '.')) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.PATH_TRAVERSAL };
  }

  return { ok: true };
}

function buildRawPointer({ retrieved_at, kind }) {
  const datePart = typeof retrieved_at === 'string' ? retrieved_at.slice(0, 10) : 'unknown-date';
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : 'unknown-date';

  const uuid = (typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  const safeUuid = String(uuid).toLowerCase();
  const safeKind = sanitizeKindForFilename(kind);

  const raw_pointer = `${EVIDENCE_STORE_ROOT}/${safeDate}/${safeUuid}_${safeKind}.bin`;
  const v = validateRawPointer(raw_pointer);
  if (!v.ok) {
    // Should not happen; keep stable fallback.
    return `${EVIDENCE_STORE_ROOT}/${safeDate}/${safeUuid}_unknown.bin`;
  }
  return raw_pointer;
}

function rawPointerToRelativePathUnderStore(raw_pointer) {
  const v = validateRawPointer(raw_pointer);
  if (!v.ok) return { ok: false, code: v.code };

  const prefix = `${EVIDENCE_STORE_ROOT}/`;
  const rel = raw_pointer.slice(prefix.length);

  // Normalize to a safe relative path without allowing escape.
  const normalized = path.posix.normalize(rel);
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.PATH_TRAVERSAL };
  }

  return { ok: true, rel: normalized };
}

const EVIDENCE_HASH_SCOPES = Object.freeze({
  ORIGINAL: 'original',
  STORED: 'stored',
  PREFIX: 'prefix',
  UNKNOWN: 'unknown'
});

function validateEvidenceItemDetailed(item) {
  if (!isPlainObject(item)) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };

  // Required keys (bytes may be null but must exist)
  const requiredKeys = [
    'kind',
    'source',
    'retrieved_at',
    'storage',
    'bytes',
    'stored_bytes',
    'truncated',
    'hash',
    'hash_scope',
    'metadata',
    'inline',
    'raw_pointer'
  ];
  for (const k of requiredKeys) {
    if (!(k in item)) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  if (typeof item.kind !== 'string' || item.kind.length === 0) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  if (typeof item.source !== 'string' || item.source.length === 0) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  if (!isIso8601(item.retrieved_at)) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };

  if (item.storage !== EVIDENCE_STORAGE.INLINE && item.storage !== EVIDENCE_STORAGE.RAW && item.storage !== EVIDENCE_STORAGE.OMITTED) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  // bytes: original content size (nullable)
  if (!(item.bytes === null || (Number.isInteger(item.bytes) && item.bytes >= 0))) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  // stored_bytes: actual stored size
  if (!(Number.isInteger(item.stored_bytes) && item.stored_bytes >= 0)) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  if (item.bytes !== null && item.stored_bytes > item.bytes) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  if (typeof item.truncated !== 'boolean') return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  if (item.truncated === true && item.storage !== EVIDENCE_STORAGE.RAW) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  if (item.truncated === true && classifyEvidenceKind(item.kind) !== 'B') {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_TRUNCATION };
  }

  if (!(item.hash === null || (typeof item.hash === 'string' && item.hash.length > 0))) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  if (!Object.values(EVIDENCE_HASH_SCOPES).includes(item.hash_scope)) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  if (!isPlainObject(item.metadata)) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };

  if (!(item.inline === null || typeof item.inline === 'string')) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  if (!(item.raw_pointer === null || typeof item.raw_pointer === 'string')) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }
  if (typeof item.raw_pointer === 'string') {
    const v = validateRawPointer(item.raw_pointer);
    if (!v.ok) return { ok: false, code: v.code };
  }

  // Storage-driven shape invariants
  if (item.storage === EVIDENCE_STORAGE.INLINE) {
    if (typeof item.inline !== 'string' || item.raw_pointer !== null) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
    if (item.hash_scope !== EVIDENCE_HASH_SCOPES.STORED) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  if (item.storage === EVIDENCE_STORAGE.RAW) {
    if (item.inline !== null) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
    if (typeof item.raw_pointer !== 'string' || item.raw_pointer.length === 0) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
    if (item.hash_scope !== EVIDENCE_HASH_SCOPES.STORED) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  if (item.storage === EVIDENCE_STORAGE.OMITTED) {
    if (item.inline !== null) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
    if (item.raw_pointer !== null) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
    if (item.stored_bytes !== 0) return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  // code optional but if present must be string
  if (!(item.code === undefined || item.code === null || (typeof item.code === 'string' && item.code.length > 0))) {
    return { ok: false, code: EVIDENCE_ERROR_CODES.INVALID_ITEM };
  }

  return { ok: true };
}

function validateEvidenceItem(item) {
  return validateEvidenceItemDetailed(item).ok;
}

function assertEvidenceItem(item) {
  const v = validateEvidenceItemDetailed(item);
  if (!v.ok) {
    throw new Error(v.code || 'Invalid EvidenceItem');
  }
}

module.exports = {
  EVIDENCE_STORE_ROOT,
  UNKNOWN_KIND_GROUP,
  DEFAULT_EVIDENCE_LIMITS,
  EVIDENCE_LIMIT_ENV_KEYS,
  getEvidenceLimitsFromEnv,
  EVIDENCE_KIND_GROUPS,
  classifyEvidenceKind,
  EVIDENCE_STORAGE,
  EVIDENCE_CODES,
  EVIDENCE_ERROR_CODES,
  EVIDENCE_HASH_SCOPES,
  sanitizePathSegment,
  sanitizeKindForFilename,
  getOrchestratorRootAbs,
  getEvidenceStoreAbsRoot,
  validateRawPointer,
  buildRawPointer,
  rawPointerToRelativePathUnderStore,
  validateEvidenceItemDetailed,
  validateEvidenceItem,
  assertEvidenceItem
};
