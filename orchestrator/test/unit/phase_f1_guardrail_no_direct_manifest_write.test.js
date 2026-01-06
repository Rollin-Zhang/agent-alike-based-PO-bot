/**
 * Phase F1 guardrail:
 * - No scripts should write evidence_manifest_v1.json directly.
 * - Scripts may rely on writeRunReportV1 (which emits the manifest).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function listJsFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...listJsFiles(p));
    else if (st.isFile() && name.endsWith('.js')) out.push(p);
  }
  return out;
}

async function testPhaseF1GuardrailNoDirectManifestWrite() {
  const scriptsDir = path.resolve(__dirname, '../../scripts');
  const files = listJsFiles(scriptsDir);

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const mentionsManifest = text.includes('evidence_manifest_v1.json');
    if (!mentionsManifest) continue;

    const okViaWriter = /writeRunReportV1/.test(text) || /writeEvidenceManifestV1/.test(text);
    assert.ok(okViaWriter, `Script mentions evidence_manifest_v1.json but does not use writer: ${f}`);

    const directWrite = /writeFileSync\([^\n]*evidence_manifest_v1\.json/.test(text);
    assert.ok(!directWrite, `Script directly writes evidence_manifest_v1.json (forbidden): ${f}`);
  }

  console.log('[Test] testPhaseF1GuardrailNoDirectManifestWrite: PASS ✓');
  return true;
}

module.exports = {
  testPhaseF1GuardrailNoDirectManifestWrite
};
