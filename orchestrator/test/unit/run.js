/**
 * Simple test runner for unit tests
 * Usage: node test/unit/run.js
 */

let hadUnhandled = false;
process.on('unhandledRejection', (err) => {
  hadUnhandled = true;
  console.error('[Runner] Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  hadUnhandled = true;
  console.error('[Runner] Uncaught Exception:', err);
});

async function runTests() {
  console.log('=== Running Unit Tests ===\n');

  const tests = [
    // Guard tests (run first to catch violations early)
    ...Object.values(require('./no_legacy_compat_paths.test')),
    ...Object.values(require('./no_scattered_tool_verdict_write.test')),
    // Unit tests (pure logic, no HTTP)
    ...Object.values(require('./derive_triage_tool.test')),
    ...Object.values(require('./derive_tool_reply_guardrail.test')),
    ...Object.values(require('./derive_tool_reply.test')),
    // Stage 2: canonical tool verdict helpers
    ...Object.values(require('./s2_tool_verdict.test')),
    // TicketStore.list query filter regression tests
    ...Object.values(require('./ticketstore_list_query_filter.test')),
    ...Object.values(require('./tool_runner_b_idempotency_guardrail.test')),
    // /fill Block B helper unit tests
    ...Object.values(require('./maybe_derive_reply_from_tool_on_fill.test')),
    // Legacy reply template builder tests (Commit 6B.1)
    ...Object.values(require('./legacy_reply_template_builder.test')),
    // Integration tests (HTTP + NO_MCP)
    ...Object.values(require('./http_fill_derivation.test')),
    // Commit 13: TRIAGE→TOOL E2E with idempotency proof
    ...Object.values(require('./http_triage_tool_e2e.test')),
    // Commit 14: TRIAGE→TOOL→REPLY (TOOL→REPLY reachability) in NO_MCP
    ...Object.values(require('./http_tool_reply_derivation.test')),
    // Commit 15 prep: shape-lock snapshot fixture (stable fields only)
    ...Object.values(require('./http_shape_lock_snapshot.test')),
    // Stage 1 Phase A: Probe Runner tests (deterministic fail-fast verification)
    ...Object.values(require('./probe_runner_force_fail_exit_code.test')),
    // Stage 1 Phase A: NO_MCP boot with /metrics available
    ...Object.values(require('./http_no_mcp_boot_metrics.test')),
    // Stage 1 Phase B: RealMcpProvider and memory read-only policy
    ...Object.values(require('./phase_b_real_mcp.test')),
    // Stage 2: S2-D schema compat (status + lease_expires)
    ...Object.values(require('./s2_ticket_schema_compat.test')),
    // Stage 2: S2-D TicketStore State Machine (pending→running→done/failed/blocked)
    { module: require('./s2_ticket_store_state_machine.test'), isRunAllStyle: true },
    // M2-C.1: Cutover policy + metrics + /metrics block
    { module: require('./m2c_cutover_policy_metrics.test'), isRunAllStyle: true },
    { module: require('./m2c_strict_cutover_gate.test'), isRunAllStyle: true },
    { module: require('./http_metrics_cutover_block.test'), isRunAllStyle: true },
    // M2-A.1: Readiness/Degraded unit tests
    { module: require('./readiness_ssot_schema.test'), isRunAllStyle: true },
    { module: require('./readiness_evaluator.test'), isRunAllStyle: true },
    { module: require('./requireDeps_unit.test'), isRunAllStyle: true },
    // M2-A.1: Integration tests (HTTP + readiness)
    { module: require('./http_health_readiness.test'), isRunAllStyle: true },
    { module: require('./http_required_gating.test'), isRunAllStyle: true },
    // M2-A ↔ M2-B: RunnerCore uses in-process ToolExecutionService (primary integration path)
    { module: require('./runnercore_http_gateway_integration.test'), isRunAllStyle: true },
    { module: require('./strict_mcp_init_exit.test'), isRunAllStyle: true },
    // M2-A.2: Evidence governance
    { module: require('./evidence_policy.test'), isRunAllStyle: true },
    { module: require('./evidence_store.test'), isRunAllStyle: true },
    { module: require('./evidence_integration_schema.test'), isRunAllStyle: true },
    // M2-B.1: Tool Runner Core (ToolStep validators + RunnerCore + ToolGateway stub)
    ...Object.values(require('./tool_runner_core.test')),
    // M2-B.2: B-script executor (SSOT + loop + derivation + v2 normalizeToolSteps)
    ...Object.values(require('./tool_runner_b.test')),
    // Phase C: RunReport v1 / StepReport v1 schema validation
    ...Object.values(require('./run_report_v1_schema.test')),
    // New gated real-MCP RunnerCore tests
    { module: require('./runnercore_real_mcp_memory.test'), isRunAllStyle: true },
    { module: require('./runnercore_real_mcp_web_search.test'), isRunAllStyle: true }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      // Handle runAll-style test modules
      if (test && typeof test === 'object' && test.isRunAllStyle) {
        await test.module.runAll();
        passed++;  // runAll throws on failure, so if we get here it passed
        continue;
      }

      if (typeof test !== 'function') {
        throw new Error(`Invalid test entry type: ${typeof test}`);
      }

      // Contract:
      // - A test passes if it does not throw/reject.
      // - A test may explicitly return false to mark failure.
      const result = await test();
      if (result === false) {
        failed++;
      } else {
        passed++;
      }
    } catch (err) {
      console.error(`[Runner] Test threw exception:`, err);
      failed++;
    }
    console.log(''); // Blank line between tests
  }

  console.log('=== Test Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  // Global safety net: if any unhandled async error occurred, treat as failure.
  if (hadUnhandled) {
    console.error('\n❌ Detected unhandled async error(s) during test run');
    process.exit(1);
  }

  if (failed > 0) {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[Runner] Fatal error:', err);
  process.exit(1);
});
