/**
 * B-script executor SSOT (M2-B.2)
 * 
 * Contract:
 * - EXIT_CODE 規則（1=fatal, 3=failed, 2=blocked, 0=otherwise）
 * - JSON report schema（stdout 輸出）
 * - tool_verdict tri-state mapping（RunReport.status → PROCEED/DEFER/BLOCK）
 * - stable codes（executor 自身 + TicketStore guardrails）
 * 
 * Key Decisions (定案):
 * - Decision 1: exit code worst 規則採「failed 優先於 blocked」（CI/運維直覺）
 * - Decision 2: tool_verdict mapping 採保守策略（ok→PROCEED, failed/blocked→DEFER, 暫不用 BLOCK）
 * - Decision 3: evidence bytes 禁止進 RunReport/tool_context/report JSON
 */

// ===== Report Version =====

const REPORT_VERSION = '1.0.0';

// ===== Exit Code (stable) =====

/**
 * Exit code 規則（CI/CD 可驗收）
 * - 1 = FATAL：executor 自身 fatal（config 錯、unhandled exception、schemaGate crash、IO 崩）
 * - 3 = HAS_FAILED：本輪有任何 failed step/ticket（例如 TOOL_TIMEOUT, TOOL_EXEC_FAILED, RUN_TIMEOUT）
 * - 2 = HAS_BLOCKED：無 failed 但有 blocked（例如 INVALID_*, BUDGET_EXCEEDED, MCP_REQUIRED_UNAVAILABLE）
 * - 0 = OTHERWISE：全 ok 或無票可處理
 * 
 * Worst 規則：failed 優先於 blocked（與 B.1 的 status worst 規則反向，這裡符合運維直覺）
 */
const EXIT_CODE = Object.freeze({
  OTHERWISE: 0,
  FATAL: 1,
  HAS_BLOCKED: 2,
  HAS_FAILED: 3
});

/**
 * 取 worst exit code（failed 優先於 blocked）
 */
function getWorstExitCode(codes) {
  if (!Array.isArray(codes) || codes.length === 0) {
    return EXIT_CODE.OTHERWISE;
  }
  if (codes.includes(EXIT_CODE.FATAL)) return EXIT_CODE.FATAL;
  if (codes.includes(EXIT_CODE.HAS_FAILED)) return EXIT_CODE.HAS_FAILED;
  if (codes.includes(EXIT_CODE.HAS_BLOCKED)) return EXIT_CODE.HAS_BLOCKED;
  return EXIT_CODE.OTHERWISE;
}

// ===== Tool Verdict Tri-state Mapping =====

/**
 * tool_verdict tri-state: PROCEED / DEFER / BLOCK（schema SSOT）
 * 
 * Mapping 規則（Decision 2）:
 * - RunReport.status === 'ok' → PROCEED（允許 TOOL→REPLY 派生）
 * - RunReport.status === 'failed' OR 'blocked' → DEFER（不派生，保留人工介入空間）
 * - BLOCK：暫不使用（未來可新增 policy code set：如 security_blocked / content_blocked）
 * 
 * 理由：RunnerCore 的 blocked/failed 多為「規格/環境/執行失敗」而非「政策拒絕」；
 * 過早映射到 BLOCK 會把可修可重試的情況誤判為終止拒絕。
 */
const VERDICT_MAP = Object.freeze({
  ok: 'PROCEED',
  failed: 'DEFER',
  blocked: 'DEFER'
  // 未來若新增：policy_blocked_codes → 'BLOCK'
});

/**
 * 根據 RunReport.status 映射成 tri-state verdict
 */
function mapRunReportStatusToVerdict(status) {
  return VERDICT_MAP[status] || 'DEFER';
}

// ===== Counter Keys (report 統計欄位) =====

/**
 * Report counters（可驗收欄位）
 */
const COUNTER_KEYS = Object.freeze([
  'total',
  'leased',
  'ok',
  'blocked',
  'failed',
  'skipped',
  'lease_failed',
  'derive_failed'
]);

// ===== Sample Limits (避免 report 爆炸) =====

/**
 * Sample limits（每個分類最多取幾筆範例，避免 report JSON 過大）
 */
const SAMPLE_LIMITS = Object.freeze({
  blocked: 5,
  failed: 5,
  ok: 3
});

// ===== Stable Codes (executor 自身 + TicketStore guardrails) =====

/**
 * Executor 自身 codes（除了 B.1 的 RUN_CODES，還加上 executor layer）
 */
const EXECUTOR_CODES = Object.freeze({
  // Executor fatal
  EXECUTOR_FATAL: 'EXECUTOR_FATAL',
  CONFIG_MISSING: 'CONFIG_MISSING',
  UNHANDLED_EXCEPTION: 'UNHANDLED_EXCEPTION',
  
  // TicketStore guardrails（來自 TicketStore.js emitGuardReject）
  LEASE_OWNER_MISMATCH: 'lease_owner_mismatch',
  DIRECT_FILL_NOT_ALLOWED: 'direct_fill_not_allowed',
  DIRECT_FILL_MISSING_BY: 'direct_fill_missing_by',
  
  // Lease 失敗（非 fatal，只影響該輪）
  LEASE_FAILED: 'LEASE_FAILED',

  // Derivation non-fatal failures
  DERIVE_FAILED: 'DERIVE_FAILED',

  // Release fallback failures
  RELEASE_FAILED: 'RELEASE_FAILED'
});

// ===== Report Schema (JSON stdout) =====

/**
 * 產生初始 report 結構
 */
function createReport({
  version = REPORT_VERSION,
  started_at,
  ended_at,
  duration_ms,
  executor_config = {},
  worker,
  counters = {},
  by_code = {},
  samples = {},
  stable_codes = []
}) {
  return {
    version,
    started_at,
    ended_at,
    duration_ms,
    executor_config,
    worker,
    counters,
    by_code,
    samples,
    stable_codes
  };
}

/**
 * 新增 sample（避免超出限制）
 */
function addSample(samples, category, entry, limit) {
  if (!samples[category]) samples[category] = [];
  if (samples[category].length < limit) {
    samples[category].push(entry);
  }
}

// ===== Minimal Report Validator (guardrail for CI) =====

const REQUIRED_REPORT_KEYS = Object.freeze([
  'version',
  'started_at',
  'ended_at',
  'duration_ms',
  'executor_config',
  'worker',
  'counters',
  'by_code',
  'samples',
  'stable_codes'
]);

/**
 * Minimal report schema validation.
 * This is intentionally small: we only lock required top-level keys + version.
 */
function validateReportShape(report) {
  const errors = [];

  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    return { ok: false, errors: ['report must be an object'] };
  }

  const missing = REQUIRED_REPORT_KEYS.filter(k => !(k in report));
  if (missing.length > 0) {
    errors.push(`missing keys: ${missing.join(', ')}`);
  }

  if (report.version !== REPORT_VERSION) {
    errors.push(`version mismatch: expected ${REPORT_VERSION}, got ${String(report.version)}`);
  }

  return { ok: errors.length === 0, errors };
}

// ===== Exports =====

module.exports = {
  REPORT_VERSION,
  EXIT_CODE,
  getWorstExitCode,
  VERDICT_MAP,
  mapRunReportStatusToVerdict,
  COUNTER_KEYS,
  SAMPLE_LIMITS,
  EXECUTOR_CODES,
  createReport,
  addSample,
  REQUIRED_REPORT_KEYS,
  validateReportShape
};
