const fs = require('fs');
const path = require('path');

const {
  EVIDENCE_STORE_ROOT,
  EVIDENCE_ERROR_CODES,
  buildRawPointer,
  rawPointerToRelativePathUnderStore,
  validateRawPointer,
  getEvidenceStoreAbsRoot
} = require('./ssot');

function defaultEvidenceStoreAbsRoot() {
  // Resolve to orchestrator/evidence_store/, independent of process.cwd().
  return getEvidenceStoreAbsRoot();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileAtomic(absPath, bytes) {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.tmp_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, absPath);
}

function isUnderRoot(absRoot, absTarget) {
  const rel = path.relative(absRoot, absTarget);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

class EvidenceStore {
  constructor({ absRoot } = {}) {
    // Decision #3: root is fixed; do not derive from cwd.
    // (absRoot is ignored intentionally to avoid write location drift.)
    this.absRoot = defaultEvidenceStoreAbsRoot();
  }

  /**
   * Writes bytes and returns a raw_pointer under evidence_store/.
   * @returns {{ok:true, raw_pointer:string, stored_bytes:number} | {ok:false, code:string}}
   */
  write({ kind, source, retrieved_at, hash, bytes, ext = 'bin' }) {
    try {
      if (!Buffer.isBuffer(bytes)) {
        return { ok: false, code: EVIDENCE_ERROR_CODES.WRITE_FAILED };
      }

      void source;
      void hash;
      void ext;
      const raw_pointer = buildRawPointer({ retrieved_at, kind });
      return this.writeAtRawPointer(raw_pointer, bytes);
    } catch (e) {
      return { ok: false, code: EVIDENCE_ERROR_CODES.WRITE_FAILED };
    }
  }

  /**
   * Minimal IO primitive with explicit pointer.
   * Primarily for guardrail testing; production callers should prefer write().
   * @returns {{ok:true, raw_pointer:string, stored_bytes:number} | {ok:false, code:string}}
   */
  writeAtRawPointer(raw_pointer, bytes) {
    const v = validateRawPointer(raw_pointer);
    if (!v.ok) return { ok: false, code: v.code };

    const rel = rawPointerToRelativePathUnderStore(raw_pointer);
    if (!rel.ok) return { ok: false, code: rel.code };

    try {
      const absDir = this.absRoot;
      const absTarget = path.resolve(absDir, rel.rel);

      // Realpath/root containment guard (best-effort).
      ensureDir(path.dirname(absTarget));
      const absRootReal = fs.existsSync(absDir) ? fs.realpathSync(absDir) : absDir;
      const absTargetRealParent = fs.realpathSync(path.dirname(absTarget));
      const absTargetReal = path.join(absTargetRealParent, path.basename(absTarget));

      if (!isUnderRoot(absRootReal, absTargetReal)) {
        return { ok: false, code: EVIDENCE_ERROR_CODES.PATH_TRAVERSAL };
      }

      writeFileAtomic(absTargetReal, bytes);
      const st = fs.statSync(absTargetReal);
      return { ok: true, raw_pointer, stored_bytes: st.size };
    } catch (e) {
      return { ok: false, code: EVIDENCE_ERROR_CODES.WRITE_FAILED };
    }
  }
}

module.exports = {
  EvidenceStore
};
