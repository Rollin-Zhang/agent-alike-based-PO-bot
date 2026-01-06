/**
 * Phase E guardrail:
 * - Enforce a single injection/writer entry point for run_report_v1.json.
 * - Scripts must not directly write run_report_v1.json via writeJson/fs.writeFileSync.
 * - Scripts that emit run_report_v1.json must import and call writeRunReportV1.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ORCHESTRATOR_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ORCHESTRATOR_ROOT, 'scripts');

function listJsFilesRecursive(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listJsFilesRecursive(full));
      continue;
    }
    if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }

  return out;
}

function rel(p) {
  return path.relative(ORCHESTRATOR_ROOT, p).replace(/\\/g, '/');
}

async function testPhaseEWriterSingleEntryGuardrail() {
  console.log('[Test] testPhaseEWriterSingleEntryGuardrail: START');

  assert.ok(fs.existsSync(SCRIPTS_DIR), 'scripts dir should exist');

  const files = listJsFilesRecursive(SCRIPTS_DIR);
  assert.ok(files.length > 0, 'should find scripts/*.js');

  const violations = [];

  for (const filePath of files) {
    const text = fs.readFileSync(filePath, 'utf8');

    const mentionsRunReport = /run_report_v1\.json/.test(text);
    if (!mentionsRunReport) continue;

    // Disallow direct writes to run_report_v1.json
    const directWritePatterns = [
      /writeJson\([^\)]*run_report_v1\.json/,
      /fs\.writeFileSync\([^\)]*run_report_v1\.json/,
      /writeFileSync\([^\)]*run_report_v1\.json/
    ];

    for (const re of directWritePatterns) {
      if (re.test(text)) {
        violations.push(`${rel(filePath)}:direct_write_detected:${re}`);
        break;
      }
    }

    // If the script mentions run_report_v1.json, it must use writeRunReportV1.
    const hasWriterImport = /writeRunReportV1/.test(text);
    const hasWriterCall = /writeRunReportV1\s*\(/.test(text);

    if (!hasWriterImport || !hasWriterCall) {
      violations.push(`${rel(filePath)}:missing_writeRunReportV1_usage`);
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    `run_report_v1 writer bypass detected:\n- ${violations.join('\n- ')}`
  );

  console.log('[Test] testPhaseEWriterSingleEntryGuardrail: PASS ✓');
  return true;
}

module.exports = {
  testPhaseEWriterSingleEntryGuardrail
};
