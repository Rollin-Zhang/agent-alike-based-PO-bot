/**
 * Tool Runner SSOT (Single Source of Truth)
 * M2-B.1: ToolTicketRunnerCore 規格本體
 *
 * Contract:
 * - RunReport 是唯一真相來源（任何 log/summary 只能由 RunReport 派生）
 * - Stable codes 不得擴充除非修改此 SSOT
 * - blocked vs failed vs ok 規則表由此 SSOT 鎖死
 *
 * Key Decisions:
 * - Decision 1: dep 不可用採「逐 step blocked」，整體 status 取 worst (blocked > failed > ok)
 * - Decision 2: RUN_TIMEOUT/TOOL_TIMEOUT = failed（有能力執行但未完成）
 * - Decision 3: args allowlist 採 per-tool（tool_name -> allowedKeys[]）
 * - Decision 4: tool_verdict canonical 最小必備欄位固定
 * - Decision 5: evidenceCandidates 不得含 blob；必備追溯欄位
 */

const crypto = require('crypto');

// ===== Version & Identity =====

const RUN_REPORT_VERSION = '1.0.0';

// ===== Tool Name Canonicalization (Bridge Contract) =====

/**
 * SSOT note:
 * - RunnerCore 的 allowlist/validator（TOOL_ARGS_ALLOWLIST）以 server-level tool_name 做 key，例如 'web_search'。
 * - 因此 bridge layer 必須把 {server, tool} normalize 成 tool_name=server（不要組成 'server.tool'）。
 * - 若未來要支援 'server.tool'，必須同步升級 allowlist + gateway fixtures；在那之前，canonical 固定為 server。
 */
const TOOL_NAME_CANONICAL_FORMAT = 'server';

// ===== Stable Status Enums =====

const RUN_STATUS = Object.freeze({
  OK: 'ok',
  FAILED: 'failed',
  BLOCKED: 'blocked'
});

// ===== Stable Error Codes =====

/**
 * Stable codes 分類（避免誤用）：
 * - BLOCKED codes: 規格/環境不允許執行（例如：INVALID_*, MCP_REQUIRED_UNAVAILABLE, BUDGET_EXCEEDED）
 * - FAILED codes: 有能力執行但執行失敗（例如：TOOL_TIMEOUT, TOOL_EXEC_FAILED, RUN_TIMEOUT）
 * - OK: step 成功（即使 evidence 被 omitted/write failed，仍維持 ok）
 */
const RUN_CODES = Object.freeze({
  // BLOCKED codes
  INVALID_TOOL_STEP: 'INVALID_TOOL_STEP',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  INVALID_TOOL_ARGS: 'INVALID_TOOL_ARGS',
  INVALID_BUDGET: 'INVALID_BUDGET',
  MCP_REQUIRED_UNAVAILABLE: 'MCP_REQUIRED_UNAVAILABLE',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  INVALID_EVIDENCE_CANDIDATE: 'INVALID_EVIDENCE_CANDIDATE',

  // FAILED codes (Decision 2: timeout = failed, not blocked)
  RUN_TIMEOUT: 'RUN_TIMEOUT',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  TOOL_EXEC_FAILED: 'TOOL_EXEC_FAILED',
  TOOL_UNAVAILABLE: 'TOOL_UNAVAILABLE'
});

// ===== Status → Code Mapping (可測規則表) =====

/**
 * blocked vs failed vs ok 規則表（Decision 1 & 2）
 */
const CODE_TO_STATUS = Object.freeze({
  // BLOCKED
  [RUN_CODES.INVALID_TOOL_STEP]: RUN_STATUS.BLOCKED,
  [RUN_CODES.UNKNOWN_TOOL]: RUN_STATUS.BLOCKED,
  [RUN_CODES.INVALID_TOOL_ARGS]: RUN_STATUS.BLOCKED,
  [RUN_CODES.INVALID_BUDGET]: RUN_STATUS.BLOCKED,
  [RUN_CODES.MCP_REQUIRED_UNAVAILABLE]: RUN_STATUS.BLOCKED,
  [RUN_CODES.BUDGET_EXCEEDED]: RUN_STATUS.BLOCKED,
  [RUN_CODES.INVALID_EVIDENCE_CANDIDATE]: RUN_STATUS.BLOCKED,

  // FAILED (Decision 2: timeout 視為 failed)
  [RUN_CODES.RUN_TIMEOUT]: RUN_STATUS.FAILED,
  [RUN_CODES.TOOL_TIMEOUT]: RUN_STATUS.FAILED,
  [RUN_CODES.TOOL_EXEC_FAILED]: RUN_STATUS.FAILED,
  [RUN_CODES.TOOL_UNAVAILABLE]: RUN_STATUS.FAILED
});

/**
 * 取 worst status（blocked > failed > ok）
 */
function getWorstStatus(statuses) {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return RUN_STATUS.OK;
  }
  if (statuses.includes(RUN_STATUS.BLOCKED)) return RUN_STATUS.BLOCKED;
  if (statuses.includes(RUN_STATUS.FAILED)) return RUN_STATUS.FAILED;
  return RUN_STATUS.OK;
}

/**
 * 取整體 run 的 code（可測規則）
 * - 若整體 ok => null
 * - 否則：取「第一個 status === overallStatus 且有 code」的 code
 * - 若找不到（理論上不應發生）=> 回退到第一個有 code 的 step
 */
function selectOverallCode(stepReports, overallStatus) {
  if (overallStatus === RUN_STATUS.OK) return null;
  if (!Array.isArray(stepReports) || stepReports.length === 0) return null;

  const firstWorst = stepReports.find(r => r && r.status === overallStatus && r.code);
  if (firstWorst && firstWorst.code) return firstWorst.code;

  const firstAny = stepReports.find(r => r && r.code);
  return firstAny ? firstAny.code : null;
}

// ===== Tool Args Allowlist (Decision 3: per-tool) =====

/**
 * TOOL_ARGS_ALLOWLIST（Stage B.1: 先寫死 1-3 個核心工具）
 * 
 * Future: 可切換至 registry-driven（留鉤子但不實作）
 */
const TOOL_ARGS_SOURCE = 'ssot'; // 或 'registry'（future）

const TOOL_ARGS_ALLOWLIST = Object.freeze({
  // web_search MCP tools commonly use: query + limit/max_results + optional toggles
  web_search: ['query', 'max_results', 'limit', 'timeout_ms', 'includeContent', 'maxContentLength'],
  // memory MCP server supports multiple tools with different arg keys; allow the union.
  memory: ['operation', 'entities', 'relations', 'observations', 'query', 'names', 'ids'],
  filesystem: ['path', 'operation', 'content']
});

/**
 * 驗證 tool args（per-tool allowlist）
 * @returns {{ valid: boolean, code?: string, message?: string }}
 */
function validateToolArgs(toolName, args) {
  const allowedKeys = TOOL_ARGS_ALLOWLIST[toolName];
  if (!allowedKeys) {
    // tool 不在 allowlist 中
    return { valid: false, code: RUN_CODES.UNKNOWN_TOOL, message: `Unknown tool: ${toolName}` };
  }

  if (args === null || args === undefined) {
    // args 可選，允許 null/undefined（視為空 object）
    return { valid: true };
  }

  if (typeof args !== 'object' || Array.isArray(args)) {
    return { valid: false, code: RUN_CODES.INVALID_TOOL_ARGS, message: 'args must be an object' };
  }

  const argKeys = Object.keys(args);
  const extraKeys = argKeys.filter(k => !allowedKeys.includes(k));
  if (extraKeys.length > 0) {
    return {
      valid: false,
      code: RUN_CODES.INVALID_TOOL_ARGS,
      message: `Invalid args keys for ${toolName}: ${extraKeys.join(', ')}`
    };
  }

  return { valid: true };
}

// ===== Budget Enforcement (Decision 2: 只認 max_steps/max_wall_ms) =====

/**
 * Budget 單位只認兩個：max_steps（步驟數）、max_wall_ms（wall clock timeout）
 * bytes limits 全部交給 A.2 evidence policy，不在 B.1 重複
 */
const BUDGET_KNOWN_KEYS = Object.freeze(['max_steps', 'max_wall_ms']);

function validateBudget(budget) {
  if (budget === null || budget === undefined) {
    return { valid: true };
  }

  if (typeof budget !== 'object' || Array.isArray(budget)) {
    return { valid: false, code: RUN_CODES.INVALID_BUDGET, message: 'budget must be an object' };
  }

  const keys = Object.keys(budget);
  const unknownKeys = keys.filter(k => !BUDGET_KNOWN_KEYS.includes(k));
  if (unknownKeys.length > 0) {
    return {
      valid: false,
      code: RUN_CODES.INVALID_BUDGET,
      message: `Unknown budget keys: ${unknownKeys.join(', ')}`
    };
  }

  return { valid: true };
}

// ===== ToolStep Shape (runtime validator helper) =====

/**
 * ToolStep 最小欄位（runtime 驗證）
 * - tool_name: string (required)
 * - args: object (optional, default {})
 * - budget: object (optional, keys: max_steps/max_wall_ms)
 * - save_as: string (optional, evidence key)
 */
function validateToolStepShape(step) {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) {
    return { valid: false, code: RUN_CODES.INVALID_TOOL_STEP, message: 'step must be an object' };
  }

  if (typeof step.tool_name !== 'string' || step.tool_name.trim() === '') {
    return { valid: false, code: RUN_CODES.INVALID_TOOL_STEP, message: 'tool_name is required and must be non-empty string' };
  }

  return { valid: true };
}

// ===== EvidenceCandidate Shape (Decision 5: 不得含 blob，必備追溯欄位) =====

/**
 * EvidenceCandidate 最小必備欄位（runtime）
 * - kind: string (required)
 * - source: string (required)
 * - retrieved_at: ISO8601 string (required)
 *
 * 禁止：不得含 blob（candidate 只帶 metadata + pointer；bytes 必須走 A.2 attachEvidence 流程）
 */
const EVIDENCE_CANDIDATE_REQUIRED_KEYS = Object.freeze(['kind', 'source', 'retrieved_at']);

// Minimal guardrail: reject inline blob-ish fields at candidate stage.
const EVIDENCE_CANDIDATE_FORBIDDEN_KEYS = Object.freeze([
  'bytes',
  'raw_bytes',
  'blob',
  'base64',
  'buffer'
]);

function validateEvidenceCandidateShape(candidate) {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { valid: false, code: RUN_CODES.INVALID_EVIDENCE_CANDIDATE, message: 'candidate must be an object' };
  }

  // 禁止 blob 欄位（避免偷渡進 RunReport）
  const forbiddenKeys = Object.keys(candidate).filter(k => EVIDENCE_CANDIDATE_FORBIDDEN_KEYS.includes(k));
  if (forbiddenKeys.length > 0) {
    return {
      valid: false,
      code: RUN_CODES.INVALID_EVIDENCE_CANDIDATE,
      message: `Forbidden evidence candidate keys: ${forbiddenKeys.join(', ')}`
    };
  }

  for (const key of EVIDENCE_CANDIDATE_REQUIRED_KEYS) {
    if (!candidate[key]) {
      return {
        valid: false,
        code: RUN_CODES.INVALID_EVIDENCE_CANDIDATE,
        message: `Missing required key: ${key}`
      };
    }
  }

  // kind/source 必須是 string
  if (typeof candidate.kind !== 'string' || typeof candidate.source !== 'string') {
    return {
      valid: false,
      code: RUN_CODES.INVALID_EVIDENCE_CANDIDATE,
      message: 'kind and source must be strings'
    };
  }

  // retrieved_at 必須是合法 ISO8601
  if (typeof candidate.retrieved_at !== 'string' || !isIso8601(candidate.retrieved_at)) {
    return {
      valid: false,
      code: RUN_CODES.INVALID_EVIDENCE_CANDIDATE,
      message: 'retrieved_at must be ISO8601 string'
    };
  }

  return { valid: true };
}

function isIso8601(value) {
  if (typeof value !== 'string') return false;
  const t = Date.parse(value);
  return !isNaN(t);
}

// ===== tool_verdict Canonical Shape (Decision 4) =====

/**
 * RunReport.tool_verdict 的 canonical 最小必備欄位：
 * - status: 'ok'|'blocked'|'failed'
 * - code: stable code | null (ok 可 null)
 * - tool_name: string
 * - started_at: ISO8601 string
 * - ended_at: ISO8601 string
 * - result_summary: string (短字串，禁止大 blob)
 * - evidence: EvidenceItem[] (沿用 A.2 契約)
 * 
 * 重要：canonical ≠ compat
 * toolVerdictCompat.js 僅做「各來源 → canonical」轉換，不是規格本體
 */
const TOOL_VERDICT_CANONICAL_KEYS = Object.freeze([
  'status',
  'code',
  'tool_name',
  'started_at',
  'ended_at',
  'result_summary',
  'evidence'
]);

function validateToolVerdictCanonical(verdict) {
  if (typeof verdict !== 'object' || verdict === null || Array.isArray(verdict)) {
    return { valid: false, message: 'tool_verdict must be an object' };
  }

  // status 必須是三態之一
  if (!Object.values(RUN_STATUS).includes(verdict.status)) {
    return { valid: false, message: `Invalid status: ${verdict.status}` };
  }

  // code: ok 可 null，其他必須是 stable code
  if (verdict.status !== RUN_STATUS.OK && (typeof verdict.code !== 'string' || !verdict.code)) {
    return { valid: false, message: 'code is required for non-ok status' };
  }

  // tool_name 必須是 string
  if (typeof verdict.tool_name !== 'string') {
    return { valid: false, message: 'tool_name must be string' };
  }

  // started_at/ended_at 必須是 ISO8601
  if (!isIso8601(verdict.started_at) || !isIso8601(verdict.ended_at)) {
    return { valid: false, message: 'started_at/ended_at must be ISO8601 strings' };
  }

  // result_summary 必須是 string（短字串）
  if (typeof verdict.result_summary !== 'string') {
    return { valid: false, message: 'result_summary must be string' };
  }

  // evidence 必須是陣列
  if (!Array.isArray(verdict.evidence)) {
    return { valid: false, message: 'evidence must be array' };
  }

  return { valid: true };
}

// ===== RunReport Shape (唯一真相來源) =====

/**
 * RunReport 結構（唯一真相）
 * - version: RUN_REPORT_VERSION
 * - run_id: uuid (由 RunnerCore 生成，禁止外部覆寫)
 * - ticket_id: string
 * - status: 'ok'|'failed'|'blocked' (整體 worst)
 * - code: stable code | null
 * - started_at: ISO8601
 * - ended_at: ISO8601
 * - duration_ms: number
 * - step_reports: StepReport[]
 * - evidence_summary: { items: EvidenceItem[] }
 * - tool_verdict: canonical shape (Decision 4)
 * 
 * 不變式：相同 ticket + 相同 stub gateway → 除時間欄位外完全一致
 */
function createRunReport({
  run_id,
  ticket_id,
  status,
  code = null,
  started_at,
  ended_at,
  duration_ms,
  step_reports = [],
  evidence_summary = { items: [] },
  tool_verdict = null
}) {
  return {
    version: RUN_REPORT_VERSION,
    run_id,
    ticket_id,
    status,
    code,
    started_at,
    ended_at,
    duration_ms,
    step_reports,
    evidence_summary,
    tool_verdict
  };
}

/**
 * StepReport 結構
 * - step_index: number
 * - tool_name: string
 * - status: 'ok'|'failed'|'blocked'
 * - code: stable code | null
 * - started_at: ISO8601
 * - ended_at: ISO8601
 * - duration_ms: number
 * - result_summary: string (短字串)
 * - evidence_items: EvidenceItem[]
 */
function createStepReport({
  step_index,
  tool_name,
  status,
  code = null,
  started_at,
  ended_at,
  duration_ms,
  result_summary = '',
  evidence_items = []
}) {
  return {
    step_index,
    tool_name,
    status,
    code,
    started_at,
    ended_at,
    duration_ms,
    result_summary,
    evidence_items
  };
}

// ===== DepSnapshot Shape (Decision: 只接受 depSnapshot，不接受 evaluator) =====

/**
 * DepSnapshot 介面（最小子集，對齊 A.1 /health 的 DepKey 視角）
 * - depKey: string
 * - ready: boolean
 * - code: string (DEP_UNAVAILABLE / DEP_INIT_FAILED / etc.)
 * 
 * RunnerCore 不懂 providerId/readiness evaluator；只接受 depSnapshot
 */
function isDepReady(depSnapshot, depKey) {
  if (!depSnapshot || typeof depSnapshot !== 'object') {
    return false;
  }
  const dep = depSnapshot[depKey];
  return dep && dep.ready === true;
}

// ===== run_id / as_of 生成規則（決定性） =====

/**
 * 生成 run_id（由 RunnerCore 生成，禁止外部覆寫）
 */
function generateRunId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 生成 ISO8601 timestamp
 */
function generateTimestamp() {
  return new Date().toISOString();
}

// ===== Exports =====

module.exports = {
  // Version
  RUN_REPORT_VERSION,

  // Tool name canonicalization (bridge contract)
  TOOL_NAME_CANONICAL_FORMAT,

  // Status & Codes
  RUN_STATUS,
  RUN_CODES,
  CODE_TO_STATUS,
  getWorstStatus,
  selectOverallCode,

  // Tool args
  TOOL_ARGS_SOURCE,
  TOOL_ARGS_ALLOWLIST,
  validateToolArgs,

  // Budget
  BUDGET_KNOWN_KEYS,
  validateBudget,

  // ToolStep
  validateToolStepShape,

  // EvidenceCandidate
  EVIDENCE_CANDIDATE_REQUIRED_KEYS,
  validateEvidenceCandidateShape,

  // tool_verdict
  TOOL_VERDICT_CANONICAL_KEYS,
  validateToolVerdictCanonical,

  // RunReport / StepReport
  createRunReport,
  createStepReport,

  // DepSnapshot
  isDepReady,

  // Identity
  generateRunId,
  generateTimestamp
};
