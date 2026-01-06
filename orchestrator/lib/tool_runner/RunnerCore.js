/**
 * RunnerCore.js
 * M2-B1-2: ToolTicketRunnerCore 純函式核心
 *
 * Contract:
 * - run(ticket, deps) -> RunReport（唯一真相）
 * - 任何 log/summary 只能由 RunReport 派生，不可反向依賴
 *
 * Key Features:
 * - 決定性：相同輸入 → 除時間欄位外一致
 * - Budget enforcement: max_steps / max_wall_ms
 * - dep 不可用：逐 step blocked（整體取 worst）
 * - Evidence attach: 唯一入口 attachEvidence()（不自行處理 raw_pointer/limits）
 */

const {
  RUN_STATUS,
  RUN_CODES,
  CODE_TO_STATUS,
  getWorstStatus,
  selectOverallCode,
  createRunReport,
  createStepReport,
  isDepReady,
  generateRunId,
  generateTimestamp
} = require('./ssot');

const { validateToolStep, validateEvidenceCandidates } = require('./validateToolStep');
const { mapToStableCode } = require('../run_report/stable_codes');

const {
  createRunReportV1,
  appendAttemptEvent,
  ATTEMPT_EVENT_TYPES_V1
} = require('../run_report/createRunReportV1');
const { createStepReportV1 } = require('../run_report/createStepReportV1');

/**
 * RunnerCore.run(ticket, deps) -> RunReport
 *
 * @param {Object} ticket - Tool ticket（含 tool_steps）
 * @param {Object} deps - depSnapshot { depKey: { ready, code } }
 * @param {Object} options - 執行選項
 *   - gateway: ToolGateway adapter (execute({ toolName, args, context }))
 *   - attachEvidence: (candidate) => EvidenceItem (from A.2)
 *   - budget: { max_steps?, max_wall_ms? }
 *   - requiredDeps: string[] (預設 ['memory', 'web_search'])
 * @returns {RunReport}
 */
async function runImpl(ticket, deps, options = {}, { withV1 = false } = {}) {
  const {
    gateway,
    attachEvidence = null,
    budget = {},
    requiredDeps = ['memory', 'web_search']
  } = options;

  const run_id = generateRunId();
  const ticket_id = ticket.id || ticket._id || 'unknown';
  const started_at = generateTimestamp();
  const startTime = Date.now();

  // Phase C: collect v1 artifacts (non-breaking; legacy RunReport unchanged)
  const v1AttemptEvents = [];
  const v1StepReports = [];
  const v1EventBag = { attempt_events: v1AttemptEvents };
  if (withV1) {
    appendAttemptEvent(v1EventBag, { type: ATTEMPT_EVENT_TYPES_V1.RUN_START, message: 'run_start' });
  }

  // 1) 取 tool_steps
  const steps = ticket.tool_steps || ticket.metadata?.tool_steps || [];
  if (!Array.isArray(steps) || steps.length === 0) {
    // 沒有 steps → blocked + INVALID_TOOL_STEP
    const ended_at = generateTimestamp();
    if (withV1) {
      appendAttemptEvent(v1EventBag, {
        type: ATTEMPT_EVENT_TYPES_V1.RUN_END,
        status: RUN_STATUS.BLOCKED,
        code: RUN_CODES.INVALID_TOOL_STEP,
        message: 'no_tool_steps'
      });

      const runReportV1 = createRunReportV1({
        ticket_id,
        terminal_status: RUN_STATUS.BLOCKED,
        primary_failure_code: RUN_CODES.INVALID_TOOL_STEP,
        started_at,
        ended_at,
        duration_ms: Date.now() - startTime,
        step_reports: [],
        attempt_events: v1AttemptEvents
      });

      return {
        runReport: createRunReport({
          run_id,
          ticket_id,
          status: RUN_STATUS.BLOCKED,
          code: RUN_CODES.INVALID_TOOL_STEP,
          started_at,
          ended_at,
          duration_ms: Date.now() - startTime,
          step_reports: [],
          evidence_summary: { items: [] },
          tool_verdict: null
        }),
        runReportV1
      };
    }

    return createRunReport({
      run_id,
      ticket_id,
      status: RUN_STATUS.BLOCKED,
      code: RUN_CODES.INVALID_TOOL_STEP,
      started_at,
      ended_at,
      duration_ms: Date.now() - startTime,
      step_reports: [],
      evidence_summary: { items: [] },
      tool_verdict: null
    });
  }

  // 3) Budget: max_steps
  const maxSteps = budget.max_steps || Infinity;
  const maxWallMs = budget.max_wall_ms || Infinity;

  // 4) 執行 steps（逐步）
  const step_reports = [];
  let allEvidenceItems = [];
  let stepIndex = 0;

  for (const step of steps) {
    stepIndex++;

    if (withV1) {
      appendAttemptEvent(v1EventBag, {
        type: ATTEMPT_EVENT_TYPES_V1.STEP_START,
        step_index: stepIndex,
        tool_name: step?.tool_name || 'unknown',
        message: 'step_start'
      });
    }

    // 檢查 budget: max_steps
    if (stepIndex > maxSteps) {
      // 超過 budget → blocked + BUDGET_EXCEEDED
      const stepStartedAt = generateTimestamp();
      const stepEndedAt = generateTimestamp();
      step_reports.push(createStepReport({
        step_index: stepIndex,
        tool_name: step.tool_name || 'unknown',
        status: RUN_STATUS.BLOCKED,
        code: RUN_CODES.BUDGET_EXCEEDED,
        started_at: stepStartedAt,
        ended_at: stepEndedAt,
        duration_ms: 0,
        result_summary: 'Budget exceeded (max_steps)',
        evidence_items: []
      }));

      if (withV1) {
        v1StepReports.push(createStepReportV1({
          step_index: stepIndex,
          tool_name: step.tool_name || 'unknown',
          status: RUN_STATUS.BLOCKED,
          code: RUN_CODES.BUDGET_EXCEEDED,
          started_at: stepStartedAt,
          ended_at: stepEndedAt,
          duration_ms: 0,
          result_summary: 'Budget exceeded (max_steps)',
          evidence_items: []
        }));

        appendAttemptEvent(v1EventBag, {
          type: ATTEMPT_EVENT_TYPES_V1.STEP_END,
          step_index: stepIndex,
          tool_name: step?.tool_name || 'unknown',
          status: RUN_STATUS.BLOCKED,
          code: RUN_CODES.BUDGET_EXCEEDED,
          message: 'budget_exceeded'
        });
      }
      continue;
    }

    // 檢查 budget: max_wall_ms
    if (Date.now() - startTime > maxWallMs) {
      // 超時 → failed + RUN_TIMEOUT（Decision 2）
      const stepStartedAt = generateTimestamp();
      const stepEndedAt = generateTimestamp();
      step_reports.push(createStepReport({
        step_index: stepIndex,
        tool_name: step.tool_name || 'unknown',
        status: RUN_STATUS.FAILED,
        code: RUN_CODES.RUN_TIMEOUT,
        started_at: stepStartedAt,
        ended_at: stepEndedAt,
        duration_ms: 0,
        result_summary: 'Run timeout (max_wall_ms)',
        evidence_items: []
      }));

      if (withV1) {
        v1StepReports.push(createStepReportV1({
          step_index: stepIndex,
          tool_name: step.tool_name || 'unknown',
          status: RUN_STATUS.FAILED,
          code: RUN_CODES.RUN_TIMEOUT,
          started_at: stepStartedAt,
          ended_at: stepEndedAt,
          duration_ms: 0,
          result_summary: 'Run timeout (max_wall_ms)',
          evidence_items: []
        }));

        appendAttemptEvent(v1EventBag, {
          type: ATTEMPT_EVENT_TYPES_V1.STEP_END,
          step_index: stepIndex,
          tool_name: step?.tool_name || 'unknown',
          status: RUN_STATUS.FAILED,
          code: RUN_CODES.RUN_TIMEOUT,
          message: 'run_timeout'
        });
      }
      break; // 超時就停止執行
    }

    // 檢查 step 格式
    const validationResult = validateToolStep(step);
    if (!validationResult.valid) {
      const stepStartedAt = generateTimestamp();
      const stepEndedAt = generateTimestamp();
      step_reports.push(createStepReport({
        step_index: stepIndex,
        tool_name: step.tool_name || 'unknown',
        status: validationResult.status,
        code: validationResult.code,
        started_at: stepStartedAt,
        ended_at: stepEndedAt,
        duration_ms: 0,
        result_summary: validationResult.message || 'Invalid step',
        evidence_items: []
      }));

      if (withV1) {
        v1StepReports.push(createStepReportV1({
          step_index: stepIndex,
          tool_name: step.tool_name || 'unknown',
          status: validationResult.status,
          code: validationResult.code,
          started_at: stepStartedAt,
          ended_at: stepEndedAt,
          duration_ms: 0,
          result_summary: validationResult.message || 'Invalid step',
          evidence_items: []
        }));

        appendAttemptEvent(v1EventBag, {
          type: ATTEMPT_EVENT_TYPES_V1.STEP_END,
          step_index: stepIndex,
          tool_name: step?.tool_name || 'unknown',
          status: validationResult.status,
          code: validationResult.code,
          message: validationResult.message || 'invalid_step'
        });
      }
      continue;
    }

    // 檢查 deps（Decision 1: 逐 step blocked）
    // requiredDeps supports:
    // - string[]: global required deps (legacy behavior)
    // - function(toolName) => string[]: per-step required deps
    let requiredForThisStep = [];
    if (typeof requiredDeps === 'function') {
      try {
        const v = requiredDeps(step.tool_name);
        requiredForThisStep = Array.isArray(v) ? v : [];
      } catch {
        requiredForThisStep = [];
      }
    } else {
      requiredForThisStep = Array.isArray(requiredDeps) ? requiredDeps : [];
    }

    const missingDeps = requiredForThisStep.filter(depKey => !isDepReady(deps, depKey));
    if (missingDeps.length > 0) {
      const stepStartedAt = generateTimestamp();
      const stepEndedAt = generateTimestamp();
      step_reports.push(createStepReport({
        step_index: stepIndex,
        tool_name: step.tool_name,
        status: RUN_STATUS.BLOCKED,
        code: RUN_CODES.MCP_REQUIRED_UNAVAILABLE,
        started_at: stepStartedAt,
        ended_at: stepEndedAt,
        duration_ms: 0,
        result_summary: `Missing required deps: ${missingDeps.join(', ')}`,
        evidence_items: []
      }));

      if (withV1) {
        v1StepReports.push(createStepReportV1({
          step_index: stepIndex,
          tool_name: step.tool_name,
          status: RUN_STATUS.BLOCKED,
          code: RUN_CODES.MCP_REQUIRED_UNAVAILABLE,
          started_at: stepStartedAt,
          ended_at: stepEndedAt,
          duration_ms: 0,
          result_summary: `Missing required deps: ${missingDeps.join(', ')}`,
          evidence_items: []
        }));

        appendAttemptEvent(v1EventBag, {
          type: ATTEMPT_EVENT_TYPES_V1.STEP_END,
          step_index: stepIndex,
          tool_name: step.tool_name,
          status: RUN_STATUS.BLOCKED,
          code: RUN_CODES.MCP_REQUIRED_UNAVAILABLE,
          message: `missing_deps:${missingDeps.join(',')}`
        });
      }
      continue;
    }

    // 執行 step
    const stepStartedAt = generateTimestamp();
    const stepStartTime = Date.now();

    let stepStatus = RUN_STATUS.OK;
    let stepCode = null;
    let resultSummary = '';
    let evidenceItems = [];

    try {
      if (!gateway) {
        throw new Error('gateway is required');
      }

      const response = await gateway.execute({
        toolName: step.tool_name,
        args: step.args || {},
        context: { ticket_id, step_index: stepIndex, step }
      });

      if (response.ok) {
        stepStatus = RUN_STATUS.OK;
        stepCode = null;
        resultSummary = typeof response.result === 'string'
          ? response.result.substring(0, 200)
          : JSON.stringify(response.result || {}).substring(0, 200);

        // Evidence attach（Decision 5: 唯一入口）
        if (attachEvidence && response.evidenceCandidates) {
          const evidenceValidation = validateEvidenceCandidates(response.evidenceCandidates);
          if (!evidenceValidation.valid) {
            // Guardrail: candidate 階段不允許 blob/不合規 shape
            stepStatus = RUN_STATUS.BLOCKED;
            stepCode = evidenceValidation.code;
            resultSummary = evidenceValidation.message || 'Invalid evidence candidate(s)';
          } else {
            for (const candidate of response.evidenceCandidates) {
              try {
                const evidenceItem = await attachEvidence(candidate);
                evidenceItems.push(evidenceItem);
                allEvidenceItems.push(evidenceItem);
              } catch (err) {
                // attachEvidence 失敗不影響 step status（tool 成功 ≠ evidence 一定成功）
                console.warn(`[RunnerCore] attachEvidence failed for step ${stepIndex}:`, err.message);
              }
            }
          }
        }
      } else {
        // gateway 回 error → failed/blocked（依 code 判定）
        stepCode = mapToStableCode(response.error, { boundary: 'gateway' });
        stepStatus = CODE_TO_STATUS[stepCode] || RUN_STATUS.FAILED;
        resultSummary = response.error?.message || 'Tool execution failed';
      }
    } catch (err) {
      stepStatus = RUN_STATUS.FAILED;
      stepCode = mapToStableCode(err, { boundary: 'runner' });
      resultSummary = err.message || 'Unknown error';
    }

    const stepEndedAt = generateTimestamp();
    const stepDurationMs = Date.now() - stepStartTime;

    step_reports.push(createStepReport({
      step_index: stepIndex,
      tool_name: step.tool_name,
      status: stepStatus,
      code: stepCode,
      started_at: stepStartedAt,
      ended_at: stepEndedAt,
      duration_ms: stepDurationMs,
      result_summary: resultSummary,
      evidence_items: evidenceItems
    }));

    if (withV1) {
      v1StepReports.push(createStepReportV1({
        step_index: stepIndex,
        tool_name: step.tool_name,
        status: stepStatus,
        code: stepCode,
        started_at: stepStartedAt,
        ended_at: stepEndedAt,
        duration_ms: stepDurationMs,
        result_summary: resultSummary,
        evidence_items: evidenceItems
      }));

      appendAttemptEvent(v1EventBag, {
        type: ATTEMPT_EVENT_TYPES_V1.STEP_END,
        step_index: stepIndex,
        tool_name: step.tool_name,
        status: stepStatus,
        code: stepCode,
        message: 'step_end'
      });
    }
  }

  // 5) 計算整體 status（Decision 1: worst）
  const allStatuses = step_reports.map(r => r.status);
  const overallStatus = getWorstStatus(allStatuses);
  const overallCode = selectOverallCode(step_reports, overallStatus);

  // 6) 組裝 RunReport
  const ended_at = generateTimestamp();
  const duration_ms = Date.now() - startTime;

  const legacy = createRunReport({
    run_id,
    ticket_id,
    status: overallStatus,
    code: overallCode,
    started_at,
    ended_at,
    duration_ms,
    step_reports,
    evidence_summary: { items: allEvidenceItems },
    tool_verdict: null // 暫時不填，後續 M2-B1-4 會補
  });

  if (withV1) {
    appendAttemptEvent(v1EventBag, {
      type: ATTEMPT_EVENT_TYPES_V1.RUN_END,
      status: overallStatus,
      code: overallCode,
      message: 'run_end'
    });

    const runReportV1 = createRunReportV1({
      ticket_id,
      terminal_status: overallStatus,
      primary_failure_code: overallCode,
      started_at,
      ended_at,
      duration_ms,
      step_reports: v1StepReports,
      attempt_events: v1AttemptEvents
    });

    return { runReport: legacy, runReportV1 };
  }

  return legacy;
}

async function run(ticket, deps, options = {}) {
  return runImpl(ticket, deps, options, { withV1: false });
}

async function runWithV1(ticket, deps, options = {}) {
  return runImpl(ticket, deps, options, { withV1: true });
}

module.exports = {
  run,
  runWithV1
};
