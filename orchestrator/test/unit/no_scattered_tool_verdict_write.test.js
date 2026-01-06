/**
 * Guard Test: No Scattered tool_verdict Writes
 *
 * Ensures canonical tool_verdict is written ONLY via TicketStore.
 *
 * Scans production code:
 * - orchestrator/index.js
 * - orchestrator/lib/ (all .js)
 * - orchestrator/scripts/ (all .js)
 * - orchestrator/store/ (all .js)
 * - orchestrator/tool_gateway/ (all .js)
 *
 * Excludes:
 * - orchestrator/store/TicketStore.js (single write entrypoint)
 * - orchestrator/test/ (tests allowed)
 * - node_modules/
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function findJSFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      findJSFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function stripComments(code) {
  code = code.replace(/\/\/.*$/gm, '');
  code = code.replace(/\/\*[\s\S]*?\*\//g, '');
  return code;
}

function indexToLine(code, index) {
  if (index <= 0) return 1;
  return code.slice(0, index).split('\n').length;
}

function scanFile(filePath) {
  const content = stripComments(fs.readFileSync(filePath, 'utf-8'));
  const lines = content.split('\n');
  const violations = [];

  // Tier 1 (strict, low false-positive): forbid writing tool_verdict on `ticket`.
  // This catches common bypasses:
  // - ticket.tool_verdict = ...
  // - ticket.tool_verdict.status = ...
  // - ticket['tool_verdict'] = ...
  // - Object.assign(ticket, { tool_verdict: ... })
  // - Object.defineProperty(ticket, 'tool_verdict', ...)
  // - Reflect.set(ticket, 'tool_verdict', ...)
  const linePatterns = [
    { regex: /\bticket\s*\.\s*tool_verdict\s*=/g, pattern: 'ticket.tool_verdict =' },
    { regex: /\bticket\s*\.\s*tool_verdict\s*\.\s*\w+\s*=/g, pattern: 'ticket.tool_verdict.<field> =' },
    { regex: /\bticket\s*\[\s*'tool_verdict'\s*\]\s*=/g, pattern: "ticket['tool_verdict'] =" },
    { regex: /\bticket\s*\[\s*"tool_verdict"\s*\]\s*=/g, pattern: 'ticket["tool_verdict"] =' }
  ];

  const wholeFilePatterns = [
    { regex: /Object\.assign\s*\(\s*ticket\s*,[\s\S]*?\btool_verdict\b/g, pattern: 'Object.assign(ticket, …tool_verdict…)' },
    { regex: /Object\.defineProperty\s*\(\s*ticket\s*,\s*['"]tool_verdict['"]/g, pattern: 'Object.defineProperty(ticket, "tool_verdict", …)' },
    { regex: /Reflect\.set\s*\(\s*ticket\s*,\s*['"]tool_verdict['"]/g, pattern: 'Reflect.set(ticket, "tool_verdict", …)' }
  ];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    for (const p of linePatterns) {
      if (p.regex.test(line)) {
        violations.push({
          file: filePath,
          line: index + 1,
          content: trimmed,
          pattern: p.pattern
        });
        break;
      }
    }
  });

  for (const p of wholeFilePatterns) {
    const m = p.regex.exec(content);
    if (m && typeof m.index === 'number') {
      const line = indexToLine(content, m.index);
      const preview = content.split('\n')[line - 1]?.trim() || '(match spans multiple lines)';
      violations.push({
        file: filePath,
        line,
        content: preview,
        pattern: p.pattern
      });
    }
  }

  return violations;
}

async function testNoScatteredToolVerdictWrites() {
  console.log('[Test] testNoScatteredToolVerdictWrites: START');
  console.log('[Guard] Scanning production code for scattered tool_verdict writes...');

  const orchRoot = path.resolve(__dirname, '../..');
  const allowFile = path.join(orchRoot, 'store', 'TicketStore.js');

  const filesToScan = [];

  const indexPath = path.join(orchRoot, 'index.js');
  if (fs.existsSync(indexPath)) filesToScan.push(indexPath);

  for (const dirName of ['lib', 'scripts', 'store', 'tool_gateway']) {
    const dir = path.join(orchRoot, dirName);
    filesToScan.push(...findJSFiles(dir));
  }

  const filtered = filesToScan.filter((f) => path.resolve(f) !== path.resolve(allowFile));

  let allViolations = [];
  for (const file of filtered) {
    allViolations.push(...scanFile(file));
  }

  if (allViolations.length > 0) {
    const byFile = {};
    for (const v of allViolations) {
      const rel = path.relative(orchRoot, v.file);
      if (!byFile[rel]) byFile[rel] = [];
      byFile[rel].push(v);
    }

    console.error('[Guard] ❌ Scattered tool_verdict writes detected:');
    for (const [rel, entries] of Object.entries(byFile)) {
      console.error(`\nFile: ${rel}`);
      for (const e of entries) {
        console.error(`  Line ${e.line}: ${e.pattern}`);
        console.error(`    ${e.content}`);
      }
    }

    assert.fail(`Found ${allViolations.length} scattered tool_verdict write(s). Only TicketStore.js may write.`);
  }

  console.log('[Guard] ✓ No violations found in production code');
  console.log('[Test] testNoScatteredToolVerdictWrites: PASS ✓');
  return true;
}

module.exports = {
  testNoScatteredToolVerdictWrites
};
