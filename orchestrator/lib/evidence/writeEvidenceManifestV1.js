'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { canonicalJsonStringify, CANONICALIZER_ID } = require('./canonicalJsonStringify');
const { validateEvidenceManifestV1 } = require('./validateEvidenceManifestV1');
const { EVIDENCE_REASON_INTEGRITY } = require('./ssot');

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const MANIFEST_FILENAME = 'evidence_manifest_v1.json';
const MANIFEST_SELF_HASH_FILENAME = 'manifest_self_hash_v1.json';

function loadJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function getAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

function validateAgainstSchemaOrThrow({ data, schemaAbsPath, label }) {
  const schema = loadJson(schemaAbsPath);
  const ajv = getAjv();
  const validate = ajv.compile(schema);
  const ok = validate(data);
  if (!ok) {
    const errors = (validate.errors || []).map((e) => `${e.instancePath || '/'}:${e.keyword}`);
    throw new Error(`${label}_schema_invalid:${errors.join('|')}`);
  }
}

function sha256HexFromBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readFileInfo(absPath) {
  const buf = fs.readFileSync(absPath);
  return {
    bytes: buf.length,
    sha256: sha256HexFromBuffer(buf)
  };
}

function computeManifestSelfHashV1(manifest) {
  // Avoid circularity:
  // - evidence_manifest_v1.sha256 is always null
  // - exclude manifest_self_hash_v1 artifact entirely from hashed material
  const canonicalManifest = JSON.parse(JSON.stringify(manifest));
  canonicalManifest.artifacts = Array.isArray(canonicalManifest.artifacts)
    ? canonicalManifest.artifacts.filter((a) => a && a.kind !== 'manifest_self_hash_v1')
    : [];

  for (const a of canonicalManifest.artifacts) {
    if (a && a.kind === 'evidence_manifest_v1') {
      a.sha256 = null;
    }
  }

  const canonicalString = canonicalJsonStringify(canonicalManifest);
  return sha256HexFromBuffer(Buffer.from(canonicalString, 'utf8'));
}

function normalizeArtifacts(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];

  // De-dupe by path (first wins), then sort.
  const byPath = new Map();
  for (const a of list) {
    const kind = a && typeof a.kind === 'string' ? a.kind : '';
    const p = a && typeof a.path === 'string' ? a.path : '';
    if (!kind || !p) continue;
    if (!byPath.has(p)) byPath.set(p, { ...a, kind, path: p });
  }

  const out = Array.from(byPath.values());
  out.sort((x, y) => {
    const k = String(x.kind).localeCompare(String(y.kind));
    if (k !== 0) return k;
    return String(x.path).localeCompare(String(y.path));
  });

  return out;
}

function normalizeChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];

  const byName = new Map();
  for (const c of list) {
    const name = c && typeof c.name === 'string' ? c.name : '';
    if (!name) continue;

    const reasons = Array.isArray(c.reason_codes) ? c.reason_codes.map((r) => String(r)).filter(Boolean) : [];
    const uniqReasons = Array.from(new Set(reasons)).sort();

    const entry = {
      name,
      ok: Boolean(c.ok),
      reason_codes: uniqReasons
    };

    if (c.details_ref && typeof c.details_ref === 'string') {
      entry.details_ref = c.details_ref;
    }

    if (!byName.has(name)) byName.set(name, entry);
  }

  const out = Array.from(byName.values());
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

function defaultRunDirFromEnvAndRunId({ run_id }) {
  const logsDir = process.env.LOGS_DIR ? String(process.env.LOGS_DIR) : null;
  if (!logsDir) return null;
  return path.resolve(logsDir, String(run_id));
}

/**
 * writeEvidenceManifestV1
 *
 * Contract:
 * - Computes sha256/bytes for all artifacts except evidence_manifest_v1 (sha256 must be null).
 * - Writes manifest to <runDir>/evidence_manifest_v1.json
 * - Writes manifest self-hash debug artifact to <runDir>/manifest_self_hash.json
 * - Deterministic ordering:
 *   - artifacts sorted by (kind, path)
 *   - checks sorted by name
 *   - reason_codes sorted & deduped
 */
function writeEvidenceManifestV1(options = {}) {
  const {
    runDir,
    run_id,
    as_of = new Date().toISOString(),
    mode_snapshot_ref,
    artifacts = [],
    checks = []
  } = options;

  const effectiveRunDir = runDir
    ? path.resolve(String(runDir))
    : defaultRunDirFromEnvAndRunId({ run_id });

  if (!effectiveRunDir) {
    throw new Error('writeEvidenceManifestV1: runDir is required (or set LOGS_DIR)');
  }

  if (!run_id || typeof run_id !== 'string' || run_id.length < 8) {
    throw new Error('writeEvidenceManifestV1: run_id is required (minLength 8)');
  }

  fs.mkdirSync(effectiveRunDir, { recursive: true });

  const normalizedArtifacts = normalizeArtifacts(artifacts);
  const normalizedChecks = normalizeChecks(checks);

  // Ensure manifest self artifact entry is present (sha256=null per spec).
  const hasSelf = normalizedArtifacts.some((a) => a.kind === 'evidence_manifest_v1' && a.path === MANIFEST_FILENAME);
  if (!hasSelf) {
    normalizedArtifacts.push({ kind: 'evidence_manifest_v1', path: MANIFEST_FILENAME, sha256: null, bytes: 0 });
  }

  // Ensure self-hash artifact entry is present (sha256/bytes filled after file write).
  const hasSelfHash = normalizedArtifacts.some((a) => a.kind === 'manifest_self_hash_v1' && a.path === MANIFEST_SELF_HASH_FILENAME);
  if (!hasSelfHash) {
    normalizedArtifacts.push({ kind: 'manifest_self_hash_v1', path: MANIFEST_SELF_HASH_FILENAME, sha256: '0'.repeat(64), bytes: 0 });
  }

  // Ensure mode_snapshot_ref is set.
  const modeRef = typeof mode_snapshot_ref === 'string' && mode_snapshot_ref ? mode_snapshot_ref : 'run_report_v1.json';

  // Build the manifest object (bytes/sha filled later)
  const manifest = {
    run_id: String(run_id),
    as_of: String(as_of),
    mode_snapshot_ref: modeRef,
    artifacts: normalizeArtifacts(normalizedArtifacts),
    checks: normalizeChecks(normalizedChecks)
  };

  // Fill sha/bytes for non-self artifacts
  for (const a of manifest.artifacts) {
    if (a.kind === 'evidence_manifest_v1') {
      a.sha256 = null;
      continue;
    }

    if (a.kind === 'manifest_self_hash_v1') {
      // Filled after we write the self-hash file.
      continue;
    }

    const abs = path.resolve(effectiveRunDir, a.path);
    if (!fs.existsSync(abs)) {
      throw new Error(`writeEvidenceManifestV1:artifact_missing:${a.kind}:${a.path}`);
    }

    const info = readFileInfo(abs);
    a.bytes = info.bytes;
    a.sha256 = info.sha256;
  }

  // Add/refresh stable checks BEFORE hashing.
  const integrityCheckName = 'manifest_self_integrity_ok';
  const schemaCheckName = 'manifest_schema_valid';

  const baseChecks = (manifest.checks || []).filter(
    (c) => c && c.name !== integrityCheckName && c.name !== schemaCheckName
  );

  baseChecks.push({
    name: integrityCheckName,
    ok: true,
    reason_codes: [],
    details_ref: MANIFEST_SELF_HASH_FILENAME
  });
  baseChecks.push({ name: schemaCheckName, ok: true, reason_codes: [] });

  manifest.checks = normalizeChecks(baseChecks);
  manifest.artifacts = normalizeArtifacts(manifest.artifacts);

  // Validate schema + cross-field invariants.
  const manifestSchemaAbs = path.resolve(__dirname, '../../schemas/evidence_manifest.v1.schema.json');
  try {
    validateAgainstSchemaOrThrow({ data: manifest, schemaAbsPath: manifestSchemaAbs, label: 'evidence_manifest_v1' });
  } catch (err) {
    const reason_codes = [EVIDENCE_REASON_INTEGRITY.MANIFEST_SCHEMA_INVALID];
    manifest.checks = normalizeChecks(
      (manifest.checks || []).filter((c) => c && c.name !== schemaCheckName).concat([
        { name: schemaCheckName, ok: false, reason_codes }
      ])
    );
    const manifestPath = path.resolve(effectiveRunDir, MANIFEST_FILENAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    throw err;
  }

  const v = validateEvidenceManifestV1(manifest);
  if (!v.ok) {
    const reason_codes = Array.from(new Set([...(v.reason_codes || []), EVIDENCE_REASON_INTEGRITY.MANIFEST_SCHEMA_INVALID])).sort();
    manifest.checks = normalizeChecks(
      (manifest.checks || []).filter((c) => c && c.name !== schemaCheckName).concat([
        { name: schemaCheckName, ok: false, reason_codes }
      ])
    );
    const manifestPath = path.resolve(effectiveRunDir, MANIFEST_FILENAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    throw new Error(`evidence_manifest_invalid:${(v.errors || []).join('|')}`);
  }

  // Compute and write self-hash artifact using the FINAL manifest shape.
  const selfHash = computeManifestSelfHashV1(manifest);
  const selfHashObj = {
    algo: 'sha256',
    canonicalizer: CANONICALIZER_ID,
    value: selfHash
  };

  const selfHashSchemaAbs = path.resolve(__dirname, '../../schemas/manifest_self_hash.v1.schema.json');
  validateAgainstSchemaOrThrow({ data: selfHashObj, schemaAbsPath: selfHashSchemaAbs, label: 'manifest_self_hash_v1' });

  const selfHashPath = path.resolve(effectiveRunDir, MANIFEST_SELF_HASH_FILENAME);
  fs.writeFileSync(selfHashPath, JSON.stringify(selfHashObj, null, 2) + '\n', 'utf8');

  const selfHashInfo = readFileInfo(selfHashPath);
  for (const a of manifest.artifacts) {
    if (a.kind === 'manifest_self_hash_v1' && a.path === MANIFEST_SELF_HASH_FILENAME) {
      a.bytes = selfHashInfo.bytes;
      a.sha256 = selfHashInfo.sha256;
    }
  }

  // Persist final manifest. (Self-hash artifact is excluded from the hashed material by design.)
  const manifestPath = path.resolve(effectiveRunDir, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return {
    runDir: effectiveRunDir,
    manifestPath,
    manifest
  };
}

module.exports = {
  writeEvidenceManifestV1,
  MANIFEST_FILENAME,
  MANIFEST_SELF_HASH_FILENAME
};

