/**
 * tool_runner_core.test.js
 * M2-B1 Unit Tests: ToolStep validators + RunnerCore + ToolGateway stub
 */

const assert = require('assert');
const {
  RUN_STATUS,
  RUN_CODES,
  CODE_TO_STATUS,
  validateToolArgs,
  validateBudget,
  validateToolStepShape,
  validateEvidenceCandidateShape,
  getWorstStatus
} = require('../../lib/tool_runner/ssot');

const { validateToolStep, validateEvidenceCandidates } = require('../../lib/tool_runner/validateToolStep');
const { createStubGateway, mapGatewayErrorCode } = require('../../lib/tool_runner/ToolGatewayAdapter');
const { run } = require('../../lib/tool_runner/RunnerCore');
const { depsForToolName } = require('../../lib/readiness/ssot');

// ===== Test: SSOT getWorstStatus =====

async function testGetWorstStatus() {
  console.log('[Test] testGetWorstStatus: START');
  assert.strictEqual(getWorstStatus([]), RUN_STATUS.OK, 'empty should be ok');
  assert.strictEqual(getWorstStatus([RUN_STATUS.OK]), RUN_STATUS.OK);
  assert.strictEqual(getWorstStatus([RUN_STATUS.OK, RUN_STATUS.FAILED]), RUN_STATUS.FAILED);
  assert.strictEqual(getWorstStatus([RUN_STATUS.OK, RUN_STATUS.BLOCKED]), RUN_STATUS.BLOCKED);
  assert.strictEqual(getWorstStatus([RUN_STATUS.FAILED, RUN_STATUS.BLOCKED]), RUN_STATUS.BLOCKED, 'blocked > failed');
  console.log('[Test] testGetWorstStatus: PASS ✓');
  return true;
}

// ===== Test: validateToolArgs (per-tool allowlist) =====

async function testValidateToolArgs() {
  console.log('[Test] testValidateToolArgs: START');
  let result = validateToolArgs('web_search', { query: 'test', max_results: 10 });
  assert.strictEqual(result.valid, true, 'valid web_search args');

  // Guardrail: web_search supports common real MCP keys (limit)
  result = validateToolArgs('web_search', { query: 'test', limit: 1 });
  assert.strictEqual(result.valid, true, 'web_search should allow limit');

  result = validateToolArgs('web_search', { query: 'test', invalid_key: 'bad' });
  assert.strictEqual(result.valid, false, 'extra key should fail');
  assert.strictEqual(result.code, RUN_CODES.INVALID_TOOL_ARGS);

  // Guardrail: memory supports search_nodes query key
  result = validateToolArgs('memory', { query: 'needle' });
  assert.strictEqual(result.valid, true, 'memory should allow query');

  // Guardrail: trace-only fields must never be allowed in args
  result = validateToolArgs('memory', { _original_tool: 'read_graph' });
  assert.strictEqual(result.valid, false, 'trace-only keys must be rejected');
  assert.strictEqual(result.code, RUN_CODES.INVALID_TOOL_ARGS);

  result = validateToolArgs('unknown_tool', { query: 'test' });
  assert.strictEqual(result.valid, false, 'unknown tool should fail');
  assert.strictEqual(result.code, RUN_CODES.UNKNOWN_TOOL);

  result = validateToolArgs('web_search', null);
  assert.strictEqual(result.valid, true, 'null args should be allowed');
  console.log('[Test] testValidateToolArgs: PASS ✓');
  return true;
}

// ===== Test: validateBudget =====

async function testValidateBudget() {
  console.log('[Test] testValidateBudget: START');
  let result = validateBudget({ max_steps: 5 });
  assert.strictEqual(result.valid, true);

  result = validateBudget({ max_wall_ms: 5000 });
  assert.strictEqual(result.valid, true);

  result = validateBudget({ max_bytes: 1024 });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.INVALID_BUDGET);

  result = validateBudget(null);
  assert.strictEqual(result.valid, true);
  console.log('[Test] testValidateBudget: PASS ✓');
  return true;
}

// ===== Test: validateToolStepShape =====

async function testValidateToolStepShape() {
  console.log('[Test] testValidateToolStepShape: START');
  let result = validateToolStepShape({ tool_name: 'web_search', args: {} });
  assert.strictEqual(result.valid, true);

  result = validateToolStepShape({ args: {} });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.INVALID_TOOL_STEP);

  result = validateToolStepShape({ tool_name: '', args: {} });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.INVALID_TOOL_STEP);
  console.log('[Test] testValidateToolStepShape: PASS ✓');
  return true;
}

// ===== Test: validateToolStep (full) =====

async function testValidateToolStep() {
  console.log('[Test] testValidateToolStep: START');
  let result = validateToolStep({
    tool_name: 'web_search',
    args: { query: 'test' },
    budget: { max_steps: 1 }
  });
  assert.strictEqual(result.valid, true, 'valid step should pass');

  result = validateToolStep({ tool_name: 'unknown_tool', args: {} });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.UNKNOWN_TOOL);
  assert.strictEqual(result.status, RUN_STATUS.BLOCKED, 'unknown tool should be blocked');

  result = validateToolStep({ tool_name: 'web_search', args: { query: 'test', bad_key: 'bad' } });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.INVALID_TOOL_ARGS);
  assert.strictEqual(result.status, RUN_STATUS.BLOCKED);

  result = validateToolStep({ tool_name: 'web_search', args: { query: 'test' }, budget: { max_bytes: 1024 } });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.INVALID_BUDGET);
  assert.strictEqual(result.status, RUN_STATUS.BLOCKED);
  console.log('[Test] testValidateToolStep: PASS ✓');
  return true;
}

// ===== Test: validateEvidenceCandidate =====

async function testValidateEvidenceCandidate() {
  console.log('[Test] testValidateEvidenceCandidate: START');
  let result = validateEvidenceCandidateShape({
    kind: 'tool_output',
    source: 'web_search',
    retrieved_at: new Date().toISOString()
  });
  assert.strictEqual(result.valid, true);

  result = validateEvidenceCandidateShape({
    source: 'web_search',
    retrieved_at: new Date().toISOString()
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.INVALID_EVIDENCE_CANDIDATE);

  result = validateEvidenceCandidateShape({
    kind: 'tool_output',
    source: 'web_search',
    retrieved_at: 'not-a-date'
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.INVALID_EVIDENCE_CANDIDATE);
  console.log('[Test] testValidateEvidenceCandidate: PASS ✓');
  return true;
}

// ===== Test: validateEvidenceCandidates (batch) =====

async function testValidateEvidenceCandidates() {
  console.log('[Test] testValidateEvidenceCandidates: START');
  let result = validateEvidenceCandidates([]);
  assert.strictEqual(result.valid, true);

  result = validateEvidenceCandidates([{
    kind: 'tool_output',
    source: 'web_search',
    retrieved_at: new Date().toISOString()
  }]);
  assert.strictEqual(result.valid, true);

  result = validateEvidenceCandidates([
    { kind: 'tool_output', source: 'web_search', retrieved_at: new Date().toISOString() },
    { source: 'memory', retrieved_at: new Date().toISOString() }
  ]);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.INVALID_EVIDENCE_CANDIDATE);
  console.log('[Test] testValidateEvidenceCandidates: PASS ✓');
  return true;
}

// ===== Test: mapGatewayErrorCode =====

async function testMapGatewayErrorCode() {
  console.log('[Test] testMapGatewayErrorCode: START');
  assert.strictEqual(mapGatewayErrorCode(RUN_CODES.TOOL_TIMEOUT), RUN_CODES.TOOL_TIMEOUT);
  assert.strictEqual(mapGatewayErrorCode('timeout'), RUN_CODES.TOOL_TIMEOUT);
  assert.strictEqual(mapGatewayErrorCode('TIMEOUT'), RUN_CODES.TOOL_TIMEOUT);
  assert.strictEqual(mapGatewayErrorCode('unavailable'), RUN_CODES.TOOL_UNAVAILABLE);
  assert.strictEqual(mapGatewayErrorCode('error'), RUN_CODES.TOOL_EXEC_FAILED);
  assert.strictEqual(mapGatewayErrorCode('unknown_code'), RUN_CODES.TOOL_EXEC_FAILED);
  assert.strictEqual(mapGatewayErrorCode(null), RUN_CODES.TOOL_EXEC_FAILED);
  console.log('[Test] testMapGatewayErrorCode: PASS ✓');
  return true;
}

// ===== Test: createStubGateway =====

async function testCreateStubGateway() {
  console.log('[Test] testCreateStubGateway: START');
  const stub = createStubGateway({
    web_search: { ok: true, result: { items: [] }, evidenceCandidates: [] }
  });

  let response = stub.execute({ toolName: 'web_search', args: { query: 'test' } });
  assert.strictEqual(response.ok, true);

  response = stub.execute({ toolName: 'unknown_tool', args: {} });
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.error.code, RUN_CODES.UNKNOWN_TOOL);
  console.log('[Test] testCreateStubGateway: PASS ✓');
  return true;
}

// ===== Test: RunnerCore with stub gateway (step dispatch) =====

async function testRunnerCoreStepDispatch() {
  console.log('[Test] testRunnerCoreStepDispatch: START');
  const stub = createStubGateway({
    web_search: { ok: true, result: 'search result', evidenceCandidates: [] },
    memory: { ok: true, result: 'memory result', evidenceCandidates: [] }
  });

  const ticket = { id: 'ticket-1', tool_steps: [
    { tool_name: 'web_search', args: { query: 'test' } },
    { tool_name: 'memory', args: { operation: 'read' } }
  ]};

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  const report = await run(ticket, deps, { gateway: stub });

  assert.strictEqual(report.status, RUN_STATUS.OK, 'overall status should be ok');
  assert.strictEqual(report.step_reports.length, 2, 'should have 2 step reports');
  assert.strictEqual(report.step_reports[0].tool_name, 'web_search');
  assert.strictEqual(report.step_reports[0].status, RUN_STATUS.OK);
  assert.strictEqual(report.step_reports[1].tool_name, 'memory');
  assert.strictEqual(report.step_reports[1].status, RUN_STATUS.OK);
  console.log('[Test] testRunnerCoreStepDispatch: PASS ✓');
  return true;
}

// ===== Guardrail: unknown tool deps fallback must still gate =====

async function testRunnerCoreRequiredDepsFunctionUnknownFallbackBlocks() {
  console.log('[Test] testRunnerCoreRequiredDepsFunctionUnknownFallbackBlocks: START');

  const ticket = {
    id: 'ticket-fallback-1',
    tool_steps: [
      { tool_name: 'memory', args: { operation: 'read' } }
    ]
  };

  // Simulate readiness: memory missing, web_search ready.
  const deps = {
    memory: { ready: false, code: 'DEP_UNAVAILABLE' },
    web_search: { ready: true, code: null }
  };

  // Gateway must not be called if gating works.
  const gateway = {
    execute() {
      throw new Error('Gateway should not be called when required deps are missing');
    }
  };

  const report = await run(ticket, deps, {
    gateway,
    // Force conservative deps selection via unknown tool fallback.
    requiredDeps: () => depsForToolName('__unknown__')
  });

  assert.strictEqual(report.step_reports.length, 1);
  assert.strictEqual(report.step_reports[0].status, RUN_STATUS.BLOCKED);
  assert.strictEqual(report.step_reports[0].code, RUN_CODES.MCP_REQUIRED_UNAVAILABLE);
  assert.strictEqual(report.status, RUN_STATUS.BLOCKED);
  assert.strictEqual(report.code, RUN_CODES.MCP_REQUIRED_UNAVAILABLE);

  console.log('[Test] testRunnerCoreRequiredDepsFunctionUnknownFallbackBlocks: PASS ✓');
  return true;
}

// ===== Test: RunnerCore with max_steps budget =====

async function testRunnerCoreBudgetMaxSteps() {
  console.log('[Test] testRunnerCoreBudgetMaxSteps: START');
  const stub = createStubGateway({
    web_search: { ok: true, result: 'search result', evidenceCandidates: [] }
  });

  const ticket = { id: 'ticket-2', tool_steps: [
    { tool_name: 'web_search', args: { query: 'test1' } },
    { tool_name: 'web_search', args: { query: 'test2' } }
  ]};

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  const report = await run(ticket, deps, { gateway: stub, budget: { max_steps: 1 } });

  assert.strictEqual(report.step_reports.length, 2, 'should have 2 step reports');
  assert.strictEqual(report.step_reports[0].status, RUN_STATUS.OK, 'first step should be ok');
  assert.strictEqual(report.step_reports[1].status, RUN_STATUS.BLOCKED, 'second step should be blocked');
  assert.strictEqual(report.step_reports[1].code, RUN_CODES.BUDGET_EXCEEDED);
  assert.strictEqual(report.status, RUN_STATUS.BLOCKED, 'overall should be blocked (worst)');
  console.log('[Test] testRunnerCoreBudgetMaxSteps: PASS ✓');
  return true;
}

// ===== Test: RunnerCore with missing deps (逐 step blocked) =====

async function testRunnerCoreMissingDeps() {
  console.log('[Test] testRunnerCoreMissingDeps: START');
  const stub = createStubGateway({
    web_search: { ok: true, result: 'search result', evidenceCandidates: [] }
  });

  const ticket = { id: 'ticket-3', tool_steps: [{ tool_name: 'web_search', args: { query: 'test' } }]};

  const deps = {
    memory: { ready: false, code: 'DEP_UNAVAILABLE' },
    web_search: { ready: true, code: null }
  };

  const report = await run(ticket, deps, { gateway: stub, requiredDeps: ['memory', 'web_search'] });

  assert.strictEqual(report.step_reports.length, 1);
  assert.strictEqual(report.step_reports[0].status, RUN_STATUS.BLOCKED, 'step should be blocked');
  assert.strictEqual(report.step_reports[0].code, RUN_CODES.MCP_REQUIRED_UNAVAILABLE);
  assert.strictEqual(report.status, RUN_STATUS.BLOCKED, 'overall should be blocked');
  console.log('[Test] testRunnerCoreMissingDeps: PASS ✓');
  return true;
}

// ===== Test: RunnerCore with gateway error (failed) =====

async function testRunnerCoreGatewayError() {
  console.log('[Test] testRunnerCoreGatewayError: START');
  const stub = createStubGateway({
    web_search: { ok: false, error: { code: RUN_CODES.TOOL_TIMEOUT, message: 'timeout' } }
  });

  const ticket = { id: 'ticket-4', tool_steps: [{ tool_name: 'web_search', args: { query: 'test' } }]};

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  const report = await run(ticket, deps, { gateway: stub });

  assert.strictEqual(report.step_reports.length, 1);
  assert.strictEqual(report.step_reports[0].status, RUN_STATUS.FAILED, 'step should be failed (timeout)');
  assert.strictEqual(report.step_reports[0].code, RUN_CODES.TOOL_TIMEOUT);
  assert.strictEqual(report.status, RUN_STATUS.FAILED, 'overall should be failed');
  console.log('[Test] testRunnerCoreGatewayError: PASS ✓');
  return true;
}

// ===== Test: RunnerCore determinism (same input → same output except time) =====

async function testRunnerCoreDeterminism() {
  console.log('[Test] testRunnerCoreDeterminism: START');
  const stub = createStubGateway({
    web_search: { ok: true, result: 'fixed result', evidenceCandidates: [] }
  });

  const ticket = { id: 'ticket-5', tool_steps: [{ tool_name: 'web_search', args: { query: 'test' } }]};

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  const report1 = await run(ticket, deps, { gateway: stub });
  const report2 = await run(ticket, deps, { gateway: stub });

  assert.strictEqual(report1.status, report2.status);
  assert.strictEqual(report1.code, report2.code);
  assert.strictEqual(report1.step_reports.length, report2.step_reports.length);
  assert.strictEqual(report1.step_reports[0].tool_name, report2.step_reports[0].tool_name);
  assert.strictEqual(report1.step_reports[0].status, report2.step_reports[0].status);
  assert.notStrictEqual(report1.run_id, report2.run_id, 'run_id should be unique');
  console.log('[Test] testRunnerCoreDeterminism: PASS ✓');
  return true;
}

// ===== Test: RunnerCore with invalid step (blocked) =====

async function testRunnerCoreInvalidStep() {
  console.log('[Test] testRunnerCoreInvalidStep: START');
  const stub = createStubGateway({
    web_search: { ok: true, result: 'result', evidenceCandidates: [] }
  });

  const ticket = { id: 'ticket-6', tool_steps: [{ tool_name: 'unknown_tool', args: {} }]};

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  const report = await run(ticket, deps, { gateway: stub });

  assert.strictEqual(report.step_reports.length, 1);
  assert.strictEqual(report.step_reports[0].status, RUN_STATUS.BLOCKED, 'step should be blocked');
  assert.strictEqual(report.step_reports[0].code, RUN_CODES.UNKNOWN_TOOL);
  assert.strictEqual(report.status, RUN_STATUS.BLOCKED, 'overall should be blocked');
  console.log('[Test] testRunnerCoreInvalidStep: PASS ✓');
  return true;
}

// ===== Test: RunnerCore with no steps (blocked) =====

async function testRunnerCoreNoSteps() {
  console.log('[Test] testRunnerCoreNoSteps: START');
  const stub = createStubGateway({});

  const ticket = { id: 'ticket-7', tool_steps: [] };

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  const report = await run(ticket, deps, { gateway: stub });

  assert.strictEqual(report.status, RUN_STATUS.BLOCKED, 'no steps should be blocked');
  assert.strictEqual(report.code, RUN_CODES.INVALID_TOOL_STEP);
  assert.strictEqual(report.step_reports.length, 0, 'should have 0 step reports');
  console.log('[Test] testRunnerCoreNoSteps: PASS ✓');
  return true;
}

// ===== Test: Runner contract (async test may not return true) =====

async function testRunnerContractAsyncNoReturn() {
  console.log('[Test] testRunnerContractAsyncNoReturn: START');
  assert.strictEqual(1 + 1, 2);
  console.log('[Test] testRunnerContractAsyncNoReturn: PASS ✓');
  // Intentionally no return.
}

// ===== Test: RunnerCore overall code selection follows worst-first rule =====

async function testRunnerCoreOverallWorstCodeSelection() {
  console.log('[Test] testRunnerCoreOverallWorstCodeSelection: START');
  const stub = createStubGateway({
    web_search: ({ args }) => {
      // Step 1 fails with non-stable timeout variant to test mapping.
      if (args && args.query === 't1') {
        return { ok: false, error: { code: 'timeout', message: 'timeout' } };
      }
      // Step 2 would be ok, but we will exceed max_steps to force BLOCKED on step 2.
      return { ok: true, result: 'ok', evidenceCandidates: [] };
    }
  });

  const ticket = { id: 'ticket-worst-code', tool_steps: [
    { tool_name: 'web_search', args: { query: 't1' } },
    { tool_name: 'web_search', args: { query: 't2' } }
  ]};

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  const report = await run(ticket, deps, { gateway: stub, budget: { max_steps: 1 } });

  // Step 1: failed timeout; Step 2: blocked budget exceeded; overall worst => blocked.
  assert.strictEqual(report.step_reports[0].status, RUN_STATUS.FAILED);
  assert.strictEqual(report.step_reports[0].code, RUN_CODES.TOOL_TIMEOUT);
  assert.strictEqual(report.step_reports[1].status, RUN_STATUS.BLOCKED);
  assert.strictEqual(report.step_reports[1].code, RUN_CODES.BUDGET_EXCEEDED);

  assert.strictEqual(report.status, RUN_STATUS.BLOCKED);
  assert.strictEqual(report.code, RUN_CODES.BUDGET_EXCEEDED, 'overall code should be first worst (blocked) code');
  console.log('[Test] testRunnerCoreOverallWorstCodeSelection: PASS ✓');
  return true;
}

// ===== Test: RUN_TIMEOUT is failed (and stable) =====

async function testRunnerCoreRunTimeoutFailed() {
  console.log('[Test] testRunnerCoreRunTimeoutFailed: START');
  const stub = createStubGateway({
    web_search: { ok: true, result: 'ok', evidenceCandidates: [] }
  });

  const ticket = { id: 'ticket-run-timeout', tool_steps: [
    { tool_name: 'web_search', args: { query: 't1' } }
  ]};

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  // Force immediate timeout deterministically.
  const report = await run(ticket, deps, { gateway: stub, budget: { max_wall_ms: -1 } });
  assert.strictEqual(report.step_reports.length, 1);
  assert.strictEqual(report.step_reports[0].status, RUN_STATUS.FAILED);
  assert.strictEqual(report.step_reports[0].code, RUN_CODES.RUN_TIMEOUT);
  assert.strictEqual(report.status, RUN_STATUS.FAILED);
  assert.strictEqual(report.code, RUN_CODES.RUN_TIMEOUT);
  console.log('[Test] testRunnerCoreRunTimeoutFailed: PASS ✓');
  return true;
}

// ===== Test: EvidenceCandidate must not contain blob-ish fields =====

async function testValidateEvidenceCandidateRejectsBlob() {
  console.log('[Test] testValidateEvidenceCandidateRejectsBlob: START');
  const result = validateEvidenceCandidateShape({
    kind: 'tool_output',
    source: 'web_search',
    retrieved_at: new Date().toISOString(),
    bytes: 'INLINE_BYTES_NOT_ALLOWED'
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, RUN_CODES.INVALID_EVIDENCE_CANDIDATE);
  console.log('[Test] testValidateEvidenceCandidateRejectsBlob: PASS ✓');
  return true;
}

// ===== Test: RunnerCore blocks step if evidenceCandidates invalid =====

async function testRunnerCoreBlocksInvalidEvidenceCandidates() {
  console.log('[Test] testRunnerCoreBlocksInvalidEvidenceCandidates: START');
  let attachCalls = 0;
  const attachEvidence = async () => {
    attachCalls++;
    return { id: 'e1' };
  };

  const stub = createStubGateway({
    web_search: {
      ok: true,
      result: 'ok',
      evidenceCandidates: [{
        kind: 'tool_output',
        source: 'web_search',
        retrieved_at: new Date().toISOString(),
        bytes: 'INLINE_BYTES_NOT_ALLOWED'
      }]
    }
  });

  const ticket = { id: 'ticket-bad-evidence', tool_steps: [
    { tool_name: 'web_search', args: { query: 't1' } }
  ]};

  const deps = {
    memory: { ready: true, code: null },
    web_search: { ready: true, code: null }
  };

  const report = await run(ticket, deps, { gateway: stub, attachEvidence });
  assert.strictEqual(report.step_reports.length, 1);
  assert.strictEqual(report.step_reports[0].status, RUN_STATUS.BLOCKED);
  assert.strictEqual(report.step_reports[0].code, RUN_CODES.INVALID_EVIDENCE_CANDIDATE);
  assert.strictEqual(attachCalls, 0, 'attachEvidence must not be called for invalid candidates');
  assert.strictEqual(report.status, RUN_STATUS.BLOCKED);
  assert.strictEqual(report.code, RUN_CODES.INVALID_EVIDENCE_CANDIDATE);
  console.log('[Test] testRunnerCoreBlocksInvalidEvidenceCandidates: PASS ✓');
  return true;
}

// ===== Export all tests =====

module.exports = {
  testGetWorstStatus,
  testValidateToolArgs,
  testValidateBudget,
  testValidateToolStepShape,
  testValidateToolStep,
  testValidateEvidenceCandidate,
  testValidateEvidenceCandidates,
  testMapGatewayErrorCode,
  testCreateStubGateway,
  testRunnerCoreStepDispatch,
  testRunnerCoreRequiredDepsFunctionUnknownFallbackBlocks,
  testRunnerCoreBudgetMaxSteps,
  testRunnerCoreMissingDeps,
  testRunnerCoreGatewayError,
  testRunnerCoreDeterminism,
  testRunnerCoreInvalidStep,
  testRunnerCoreNoSteps,
  testRunnerContractAsyncNoReturn,
  testRunnerCoreOverallWorstCodeSelection,
  testRunnerCoreRunTimeoutFailed,
  testValidateEvidenceCandidateRejectsBlob,
  testRunnerCoreBlocksInvalidEvidenceCandidates
};
