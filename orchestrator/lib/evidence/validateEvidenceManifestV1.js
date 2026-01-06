'use strict';

const { isEvidenceReason, EVIDENCE_REASON_INTEGRITY } = require('./ssot');

function validateEvidenceManifestV1(manifest) {
  const errors = [];

  const m = manifest && typeof manifest === 'object' ? manifest : null;
  if (!m) {
    return {
      ok: false,
      errors: ['manifest_not_object'],
      reason_codes: [EVIDENCE_REASON_INTEGRITY.MANIFEST_SCHEMA_INVALID]
    };
  }

  const artifacts = Array.isArray(m.artifacts) ? m.artifacts : [];
  const checks = Array.isArray(m.checks) ? m.checks : [];

  const artifactsByPath = new Map();
  for (const a of artifacts) {
    const p = a && typeof a.path === 'string' ? a.path : '';
    if (!p) continue;
    if (artifactsByPath.has(p)) {
      errors.push(`duplicate_artifact_path:${p}`);
    } else {
      artifactsByPath.set(p, a);
    }
  }

  const modeRef = typeof m.mode_snapshot_ref === 'string' ? m.mode_snapshot_ref : '';
  if (!modeRef || !artifactsByPath.has(modeRef)) {
    errors.push('mode_snapshot_ref_not_listed');
  } else {
    const a = artifactsByPath.get(modeRef);
    if (!a || a.kind !== 'run_report_v1') {
      errors.push('mode_snapshot_ref_not_run_report_v1');
    }
  }

  const checkNames = new Set();
  for (const c of checks) {
    const name = c && typeof c.name === 'string' ? c.name : '';
    if (!name) continue;
    if (checkNames.has(name)) {
      errors.push(`duplicate_check_name:${name}`);
    }
    checkNames.add(name);

    const detailsRef = c && typeof c.details_ref === 'string' ? c.details_ref : null;
    if (detailsRef && !artifactsByPath.has(detailsRef)) {
      errors.push(`details_ref_not_listed:${name}`);
    }

    const reasons = Array.isArray(c?.reason_codes) ? c.reason_codes : [];
    for (const r of reasons) {
      if (!isEvidenceReason(r)) {
        errors.push(`unknown_reason_code:${name}:${String(r)}`);
      }
    }
  }

  for (const a of artifacts) {
    const kind = a && typeof a.kind === 'string' ? a.kind : '';
    const sha = a ? a.sha256 : undefined;

    if (kind === 'evidence_manifest_v1') {
      if (sha !== null) {
        errors.push('evidence_manifest_sha256_must_be_null');
      }
      continue;
    }

    // Business rule: only evidence_manifest_v1 may be null.
    if (sha === null) {
      errors.push(`artifact_sha256_null_not_allowed:${kind}`);
      continue;
    }

    // Schema already pattern-locks, but keep a guard here.
    if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha)) {
      errors.push(`artifact_sha256_invalid:${kind}`);
    }
  }

  const reason_codes = [];
  for (const e of errors) {
    if (e.startsWith('duplicate_artifact_path')) reason_codes.push(EVIDENCE_REASON_INTEGRITY.DUPLICATE_ARTIFACT_PATH);
    else if (e.startsWith('duplicate_check_name')) reason_codes.push(EVIDENCE_REASON_INTEGRITY.DUPLICATE_CHECK_NAME);
    else if (e.startsWith('mode_snapshot_ref_not_listed')) reason_codes.push(EVIDENCE_REASON_INTEGRITY.MODE_SNAPSHOT_REF_NOT_LISTED);
    else if (e.startsWith('details_ref_not_listed')) reason_codes.push(EVIDENCE_REASON_INTEGRITY.DETAILS_REF_NOT_LISTED);
    else reason_codes.push(EVIDENCE_REASON_INTEGRITY.MANIFEST_SCHEMA_INVALID);
  }

  return {
    ok: errors.length === 0,
    errors,
    reason_codes: Array.from(new Set(reason_codes)).sort()
  };
}

module.exports = {
  validateEvidenceManifestV1
};

