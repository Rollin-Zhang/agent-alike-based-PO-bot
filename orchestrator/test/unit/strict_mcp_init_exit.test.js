/**
 * M2-A.1 STRICT_MCP_INIT Exit Test
 * 
 * 驗證 STRICT_MCP_INIT=true 時，required 不可用會 exit(1) 並輸出最後 snapshot
 */

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { parseStrictInitFailOutput } = require('../../lib/readiness/ssot');

async function testStrictInitExitWithNOMCP() {
  return new Promise((resolve, reject) => {
    const orchestratorRoot = path.join(__dirname, '../..');
    
    const serverProc = spawn('node', ['index.js'], {
      cwd: orchestratorRoot,
      env: {
        ...process.env,
        STRICT_MCP_INIT: 'true',
        NO_MCP: 'true',
        ORCHESTRATOR_PORT: '19999' // Avoid port conflict
      },
      stdio: 'pipe'
    });

    let stderrData = '';
    let stdoutData = '';

    serverProc.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    serverProc.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    serverProc.on('close', (code) => {
      try {
        // Debug output
        const allOutput = stderrData + stdoutData;
        
        // Assert: exit code = 1
        assert.strictEqual(code, 1, `Should exit with code 1 when required deps unavailable, got code ${code}\nOutput: ${allOutput}`);

        // Assert: stderr/stdout contains [readiness][strict_init_fail] prefix
        const hasPrefix = allOutput.includes('[readiness][strict_init_fail]');
        assert.strictEqual(hasPrefix, true, `Should output strict init fail prefix. Output:\n${allOutput}`);

        // Assert: JSON is parseable and valid
        const lines = allOutput.split('\n');
        const failLine = lines.find(line => line.includes('[readiness][strict_init_fail]'));
        assert.notStrictEqual(failLine, undefined, `Should find fail line in output. Lines:\n${lines.join('\n')}`);

        const snapshot = parseStrictInitFailOutput(failLine);
        assert.notStrictEqual(snapshot, null, `Should parse valid snapshot JSON from line: ${failLine}`);
        assert.strictEqual(snapshot.degraded, true, 'Snapshot should show degraded=true');
        assert.strictEqual(snapshot.required.memory.ready, false, 'memory should not be ready');
        assert.strictEqual(snapshot.required.web_search.ready, false, 'web_search should not be ready');

        resolve();
      } catch (e) {
        reject(e);
      }
    });

    // Timeout after 10s
    setTimeout(() => {
      serverProc.kill();
      reject(new Error('Test timeout: server did not exit within 10s'));
    }, 10000);
  });
}

// --- Run Test ---

async function runStrictInitExitTests() {
  console.log('=== M2-A.1 STRICT_MCP_INIT Exit Tests ===');
  
  try {
    await testStrictInitExitWithNOMCP();
    console.log('✓ STRICT_MCP_INIT=true + NO_MCP=true => exit(1) with snapshot');
    console.log('\nPassed: 1, Failed: 0, Total: 1');
    return true;
  } catch (e) {
    console.error(`✗ Test failed: ${e.message}`);
    console.log('\nPassed: 0, Failed: 1, Total: 1');
    return false;
  }
}

if (require.main === module) {
  runStrictInitExitTests().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = { runAll: runStrictInitExitTests };
