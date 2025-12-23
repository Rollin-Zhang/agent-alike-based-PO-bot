/**
 * Guard Test: No Scattered Derived Access
 * 
 * Ensures production code uses lib/derivedCompat.js helpers
 * instead of directly accessing ticket.derived or ticket.metadata.derived
 * 
 * Scans:
 * - orchestrator/index.js
 * - orchestrator/lib/ (all .js files except derivedCompat.js)
 * - orchestrator/store/ (all .js files)
 * - orchestrator/tool_gateway/ (all .js files)
 * 
 * Excludes:
 * - orchestrator/lib/derivedCompat.js (allowed to access derived)
 * - orchestrator/test/ (tests allowed to verify mirror)
 * - node_modules/
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/**
 * Create a temporary violation file for regression testing
 * @param {string} orchRoot - Orchestrator root directory
 * @returns {string} - Path to the created temp file
 */
function createTempViolationFile(orchRoot) {
  const tempFilePath = path.join(orchRoot, 'lib', '__tmp_guard_violation__.js');
  const violationCode = `// TEMPORARY FILE FOR GUARD TEST REGRESSION
// This file is auto-generated and auto-deleted by the test
function testFunction(ticket) {
  const derived = ticket.derived;
  return derived;
}
module.exports = { testFunction };
`;
  fs.writeFileSync(tempFilePath, violationCode, 'utf-8');
  return tempFilePath;
}

/**
 * Clean up temporary violation file
 * @param {string} tempFilePath - Path to the temp file
 */
function cleanupTempViolationFile(tempFilePath) {
  if (fs.existsSync(tempFilePath)) {
    fs.unlinkSync(tempFilePath);
  }
}

/**
 * Recursively find all .js files in a directory
 */
function findJSFiles(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Skip node_modules and test directories
      if (entry.name === 'node_modules' || entry.name === 'test') {
        continue;
      }
      findJSFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

/**
 * Strip single-line comments from code (simple approach)
 */
function stripComments(code) {
  // Remove single-line comments (// ...)
  code = code.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments (/* ... */)
  code = code.replace(/\/\*[\s\S]*?\*\//g, '');
  return code;
}

/**
 * Check if a line contains allowlisted patterns
 */
function isAllowlisted(line) {
  // Allow require statements for derivedCompat
  if (line.includes("require('./lib/derivedCompat')") || 
      line.includes('require("./lib/derivedCompat")') ||
      line.includes("require('../lib/derivedCompat')") ||
      line.includes('require("../lib/derivedCompat")')) {
    return true;
  }
  
  // Allow readDerived/writeDerived function calls
  if (line.includes('readDerived(') || line.includes('writeDerived(')) {
    return true;
  }
  
  return false;
}

/**
 * Scan a file for violations
 */
function scanFile(filePath) {
  const violations = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const cleanedContent = stripComments(content);
  const lines = cleanedContent.split('\n');
  
  // Patterns to detect violations
  const patterns = [
    // Read patterns
    { regex: /\.derived\b/g, type: 'read', pattern: '.derived' },
    { regex: /metadata\s*\.\s*derived\b/g, type: 'read', pattern: 'metadata.derived' },
    { regex: /metadata\?\.\s*derived\b/g, type: 'read', pattern: 'metadata?.derived' },
    // Write patterns
    { regex: /\.derived\s*=/g, type: 'write', pattern: '.derived =' },
    { regex: /metadata\s*\.\s*derived\s*=/g, type: 'write', pattern: 'metadata.derived =' }
  ];
  
  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmedLine = line.trim();
    
    // Skip empty lines
    if (!trimmedLine) return;
    
    // Skip allowlisted lines
    if (isAllowlisted(line)) return;
    
    // Check each pattern
    for (const { regex, type, pattern } of patterns) {
      if (regex.test(line)) {
        violations.push({
          file: filePath,
          line: lineNum,
          content: trimmedLine,
          type: type,
          pattern: pattern
        });
        break; // One violation per line is enough
      }
    }
  });
  
  return violations;
}

/**
 * Main guard test
 */
async function testNoScatteredDerivedAccess() {
  console.log('[Test] testNoScatteredDerivedAccess: START');
  console.log('[Guard] Scanning production code for scattered derived access...');
  
  try {
    const orchRoot = path.resolve(__dirname, '../..');
    let allViolations = [];
    
    // Files to scan
    let filesToScan = [];
    
    // 1. index.js
    const indexPath = path.join(orchRoot, 'index.js');
    if (fs.existsSync(indexPath)) {
      filesToScan.push(indexPath);
    }
    
    // 2. lib/ (except derivedCompat.js)
    const libDir = path.join(orchRoot, 'lib');
    const libFiles = findJSFiles(libDir);
    for (const file of libFiles) {
      // Exclude derivedCompat.js and temp violation file
      const basename = path.basename(file);
      if (basename !== 'derivedCompat.js' && basename !== '__tmp_guard_violation__.js') {
        filesToScan.push(file);
      }
    }
    
    // 3. store/
    const storeDir = path.join(orchRoot, 'store');
    const storeFiles = findJSFiles(storeDir);
    filesToScan.push(...storeFiles);
    
    // 4. tool_gateway/
    const toolGatewayDir = path.join(orchRoot, 'tool_gateway');
    const toolGatewayFiles = findJSFiles(toolGatewayDir);
    filesToScan.push(...toolGatewayFiles);
    
    console.log(`[Guard] Scanning ${filesToScan.length} production files...`);
    
    // Scan each file
    for (const file of filesToScan) {
      const violations = scanFile(file);
      allViolations.push(...violations);
    }
    
    // Report results
    if (allViolations.length > 0) {
      console.error('[Guard] ❌ Scattered derived access detected:');
      console.error('');
      
      // Group by file
      const byFile = {};
      for (const v of allViolations) {
        const relPath = path.relative(orchRoot, v.file);
        if (!byFile[relPath]) {
          byFile[relPath] = [];
        }
        byFile[relPath].push(v);
      }
      
      // Print violations
      for (const [file, violations] of Object.entries(byFile)) {
        console.error(`  📁 ${file}:`);
        for (const v of violations) {
          console.error(`    Line ${v.line} (${v.type}): ${v.content}`);
          console.error(`      Pattern: ${v.pattern}`);
        }
        console.error('');
      }
      
      console.error('[Guard] Fix: Use readDerived(ticket) or writeDerived(ticket, obj) from lib/derivedCompat.js');
      console.error('');
      
      throw new Error(`Found ${allViolations.length} scattered derived access violations`);
    }
    
    console.log('[Guard] ✓ No violations found in production code');
    
    // === REGRESSION TEST: Verify guard can detect violations ===
    console.log('[Guard] Running regression test...');
    
    let tempFilePath = null;
    try {
      // Create temporary violation file
      tempFilePath = createTempViolationFile(orchRoot);
      console.log('[Guard] Created temporary violation file for testing');
      
      // Re-scan with temp file included
      const regressionFilesToScan = [...filesToScan, tempFilePath];
      let regressionViolations = [];
      
      for (const file of regressionFilesToScan) {
        const violations = scanFile(file);
        regressionViolations.push(...violations);
      }
      
      // Verify violations were detected
      if (regressionViolations.length === 0) {
        throw new Error('Regression test FAILED: Guard did not detect intentional violation');
      }
      
      // Verify the violation is from our temp file
      const tempViolations = regressionViolations.filter(v => v.file === tempFilePath);
      if (tempViolations.length === 0) {
        throw new Error('Regression test FAILED: Violation not detected in temp file');
      }
      
      console.log(`[Guard] ✓ Regression test passed: detected ${tempViolations.length} violation(s) in temp file`);
      
    } finally {
      // Always clean up temp file
      if (tempFilePath) {
        cleanupTempViolationFile(tempFilePath);
        console.log('[Guard] Cleaned up temporary violation file');
      }
    }
    
    console.log('[Test] testNoScatteredDerivedAccess: PASS ✓');
    return true;
    
  } catch (err) {
    console.error('[Test] testNoScatteredDerivedAccess: FAIL ✗');
    console.error(err.message);
    return false;
  }
}

module.exports = {
  testNoScatteredDerivedAccess
};
