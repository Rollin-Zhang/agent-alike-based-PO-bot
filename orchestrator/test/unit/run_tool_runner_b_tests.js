#!/usr/bin/env node
/**
 * run_tool_runner_b_tests.js
 * M2-B.2 Test Runner: NO_MCP 模式 + verdict mapping + exit codes
 * M2-B.2-v2: 新增 normalizeToolSteps + precedence 測試
 * 
 * 注意：這是本地輔助 runner，正式驗收入口是 orchestrator/test/unit/run.js
 */

async function main() {
  console.log('=== M2-B.2 Tool Runner Tests START ===\n');
  
  const tests = require('./tool_runner_b.test');
  
  try {
    // Original tests
    await tests.testExitCodeWorst();
    await tests.testVerdictMapping();
    await tests.testCreateReport();
    await tests.testAddSampleLimit();
    await tests.testExecutorCodesStable();
    
    // M2-B.2-v2 tests
    await tests.testNormalizeServerTool();
    await tests.testNormalizeToolName();
    await tests.testToolStepsPrecedence();
    
    console.log('\n=== ALL TESTS PASSED ✓ ===');
    process.exit(0);
  } catch (err) {
    console.error('\n[TEST FAILED]', err);
    process.exit(1);
  }
}

main();
