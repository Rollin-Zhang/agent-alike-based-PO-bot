const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function listYamlFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    const p = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      out.push(...listYamlFiles(p));
    } else if (ent.isFile() && (ent.name.endsWith('.yaml') || ent.name.endsWith('.yml'))) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const repoRoot = path.join(__dirname, '..');
  const srcPromptsDir = path.join(repoRoot, 'src', 'prompts');

  if (!fs.existsSync(srcPromptsDir)) {
    console.error(`[copy-prompts] Source prompts directory not found: ${srcPromptsDir}`);
    process.exit(1);
  }

  const yamlFiles = listYamlFiles(srcPromptsDir);
  if (yamlFiles.length === 0) {
    console.warn(`[copy-prompts] No YAML files found under: ${srcPromptsDir}`);
  }

  // Ensure compatibility with PromptBuilder.resolvePromptsDir()
  // - out/prompts
  // - out/src/prompts
  const outDir = path.join(repoRoot, 'out');
  const destA = path.join(outDir, 'prompts');
  const destB = path.join(outDir, 'src', 'prompts');

  ensureDir(destA);
  ensureDir(destB);

  for (const file of yamlFiles) {
    const rel = path.relative(srcPromptsDir, file);
    copyFile(file, path.join(destA, rel));
    copyFile(file, path.join(destB, rel));
  }

  console.log(`[copy-prompts] Copied ${yamlFiles.length} file(s) to:`);
  console.log(`- ${destA}`);
  console.log(`- ${destB}`);
}

main();
