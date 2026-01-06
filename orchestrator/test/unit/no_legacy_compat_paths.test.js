/**
 * Repo-guard (M2-C.2): forbid legacy compat modules and legacy field paths in production code.
 *
 * Production rule:
 * - No derivedCompat / toolVerdictCompat imports
 * - No legacy derived mirror: ticket.metadata.derived
 * - No legacy tool verdict reads: *.final_outputs.tool_verdict (any nesting)
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function isSkippableDir(p) {
  return (
    p.includes(`${path.sep}test${path.sep}`) ||
    p.includes(`${path.sep}docs${path.sep}`) ||
    p.includes(`${path.sep}logs${path.sep}`) ||
    p.includes(`${path.sep}evidence_store${path.sep}`) ||
    p.includes(`${path.sep}backups${path.sep}`) ||
    p.includes(`${path.sep}data${path.sep}`)
  );
}

function walkJsFiles(rootDir) {
  const out = [];

  function walk(dir) {
    if (isSkippableDir(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && full.endsWith('.js')) out.push(full);
    }
  }

  walk(rootDir);
  return out;
}

function stripComments(line) {
  // best-effort: drop whole-line comments; keep inline code before //
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  const idx = line.indexOf('//');
  if (idx >= 0) return line.slice(0, idx);
  return line;
}

async function testNoLegacyCompatPaths() {
  console.log('[Guard] testNoLegacyCompatPaths: START');

  const root = path.resolve(__dirname, '../..'); // orchestrator/
  const files = walkJsFiles(root);

  const violations = [];

  const forbiddenSubstrings = [
    "require('./lib/derivedCompat')",
    'require("./lib/derivedCompat")',
    "require('../lib/derivedCompat')",
    'require("../lib/derivedCompat")',
    "require('./lib/toolVerdictCompat')",
    'require("./lib/toolVerdictCompat")',
    "require('../lib/toolVerdictCompat')",
    'require("../lib/toolVerdictCompat")'
  ];

  const forbiddenRegexes = [
    { re: /\bmetadata\s*\.\s*derived\b/, reason: 'legacy metadata.derived' },
    { re: /\bfinal_outputs\s*\.\s*tool_verdict\b/, reason: 'legacy final_outputs.tool_verdict read' }
  ];

  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const code = stripComments(lines[i]);
      if (!code) continue;

      for (const s of forbiddenSubstrings) {
        if (code.includes(s)) {
          violations.push({ file: f, line: i + 1, reason: `forbidden import: ${s}` });
        }
      }

      for (const { re, reason } of forbiddenRegexes) {
        if (re.test(code)) {
          violations.push({ file: f, line: i + 1, reason });
        }
      }
    }
  }

  if (violations.length > 0) {
    for (const v of violations.slice(0, 20)) {
      console.error(`[Guard] ${v.reason} at ${v.file}:${v.line}`);
    }
  }

  assert.strictEqual(violations.length, 0, `Found ${violations.length} legacy compat violations`);
  console.log('[Guard] testNoLegacyCompatPaths: PASS ✓');
  return true;
}

module.exports = {
  testNoLegacyCompatPaths
};
