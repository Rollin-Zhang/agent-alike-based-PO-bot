'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { writeEvidenceManifestV1, MANIFEST_FILENAME, MANIFEST_SELF_HASH_FILENAME } = require('../evidence/writeEvidenceManifestV1');

function sha256HexFromString(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function fileSha256Hex(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeUnlinkIfLikelyNew(absPath, startedAtMs) {
  try {
    const st = fs.statSync(absPath);
    if (typeof st.mtimeMs === 'number' && st.mtimeMs < startedAtMs) {
      return false;
    }
    fs.unlinkSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single writer helper for run_report_v1.json
 * - Centralizes JSON formatting and ensures a single injection point for run-level fields.
 */
function writeRunReportV1(options = {}) {
  const {
    filePath,
    reportV1,
    mode_snapshot = undefined,
    run_id = undefined,
    emit_manifest = true
  } = options;

  if (!filePath || typeof filePath !== 'string') {
    throw new Error('writeRunReportV1: filePath is required');
  }
  if (!reportV1 || typeof reportV1 !== 'object') {
    throw new Error('writeRunReportV1: reportV1 is required');
  }

  if (mode_snapshot && typeof mode_snapshot === 'object') {
    reportV1.mode_snapshot = mode_snapshot;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const runDir = path.dirname(filePath);
  const runId = typeof run_id === 'string' && run_id ? run_id : path.basename(runDir);
  const runReportFilename = path.basename(filePath);

  // Policy: disallow run_id overwrite unless explicitly allowed (test-only or debug)
  const allowOverwrite = process.env.ALLOW_RUN_ID_OVERWRITE === '1';
  if (!allowOverwrite && fs.existsSync(filePath)) {
    throw new Error(`run_id already exists and overwrite is not allowed: ${runId}`);
  }

  const startedAtMs = Date.now();

  // Atomic write (best-effort): write to a unique temp file in the same dir, then rename.
  // This reduces the chance other readers observe a half-written run_report_v1.json.
  const payload = JSON.stringify(reportV1, null, 2) + '\n';
  const expectedBytes = Buffer.byteLength(payload, 'utf8');
  const expectedSha256 = sha256HexFromString(payload);

  const tmpName = `${runReportFilename}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(runDir, tmpName);

  fs.writeFileSync(tmpPath, payload, 'utf8');

  // Test-only barrier: pause before rename to allow race testing
  if (process.env.NODE_ENV === 'test' && process.env.EVIDENCE_WRITE_BARRIER === 'before_rename') {
    const barrierFile = path.join(runDir, '.barrier_before_rename');
    fs.writeFileSync(barrierFile, Date.now().toString(), 'utf8');
    // Wait for barrier release (polling with timeout)
    const startMs = Date.now();
    while (fs.existsSync(barrierFile) && Date.now() - startMs < 10000) {
      // Sleep briefly to avoid busy wait
      const sleepMs = 50;
      const sleepStart = Date.now();
      while (Date.now() - sleepStart < sleepMs) { /* busy wait */ }
    }
  }

  fs.renameSync(tmpPath, filePath);

  if (!emit_manifest) return;

  try {
    writeEvidenceManifestV1({
      runDir,
      run_id: runId,
      as_of: new Date().toISOString(),
      mode_snapshot_ref: runReportFilename,
      artifacts: [
        { kind: 'run_report_v1', path: runReportFilename, sha256: '0'.repeat(64), bytes: 0 }
      ],
      checks: []
    });
  } catch (err) {
    // Avoid deleting someone else's file in concurrent scenarios:
    // only rollback if the current on-disk run_report still matches what we just wrote.
    try {
      const st = fs.statSync(filePath);
      if (st.isFile() && st.size === expectedBytes) {
        const onDiskSha = fileSha256Hex(filePath);
        if (onDiskSha === expectedSha256) {
          fs.unlinkSync(filePath);
        }
      }
    } catch { /* ignore */ }

    // Best-effort cleanup for manifest artifacts only if they look newly created in this call.
    safeUnlinkIfLikelyNew(path.join(runDir, MANIFEST_FILENAME), startedAtMs);
    safeUnlinkIfLikelyNew(path.join(runDir, MANIFEST_SELF_HASH_FILENAME), startedAtMs);
    throw err;
  }
}

module.exports = {
  writeRunReportV1
};
