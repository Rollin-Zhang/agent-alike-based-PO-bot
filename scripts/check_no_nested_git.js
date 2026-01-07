#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

function walk(dir, onDir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    // Skip huge / irrelevant dirs
    if (ent.name === 'node_modules' || ent.name === '.vscode' || ent.name === '.idea') continue;

    const full = path.join(dir, ent.name);
    onDir(full, ent.name);
    walk(full, onDir);
  }
}

function main() {
  const argRoot = process.argv.find(a => a.startsWith('--root='));
  const repoRoot = path.resolve(argRoot ? argRoot.slice('--root='.length) : process.cwd());
  const rootGit = path.join(repoRoot, '.git');

  if (!fs.existsSync(rootGit) || !fs.statSync(rootGit).isDirectory()) {
    console.error(`[check_no_nested_git] Expected .git at repo root: ${rootGit}`);
    process.exit(2);
  }

  const nested = [];

  walk(repoRoot, (full, name) => {
    if (name !== '.git') return;
    if (path.resolve(full) === path.resolve(rootGit)) return;
    nested.push(full);
  });

  if (nested.length > 0) {
    console.error('[check_no_nested_git] Nested .git directories found (this is a long-term landmine):');
    for (const p of nested) console.error(`- ${path.relative(repoRoot, p)}`);
    process.exit(1);
  }

  console.log('[check_no_nested_git] OK (no nested .git found)');
  process.exit(0);
}

main();
