/**
 * Probes SSOT (Single Source of Truth)
 * Phase D: Defense-in-Depth Probes / Guards
 *
 * Contract:
 * - ProbeStep tool_name 固定 enum（避免命名漂移）
 * - Probe StepReport pass/fail 判定只看 StepReport 欄位
 * - Probe stable codes 不污染 RunnerCore RUN_CODES
 *
 * Namespace / Mapping Policy (避免 SSOT drift):
 * - 策略 A（當前採用）：Probe 只產生「Probe namespace」codes（PROBE_STEP_CODES / PROBE_ATTEMPT_CODES）。
 *   這些 codes 不得與 lib/tool_runner/ssot.js 的 RUN_CODES 產生字串重疊。
 * - Probe → StepReport builder 可直接使用 Probe namespace codes（probe steps 的 StepReport.code）。
 * - 若未來需要讓「Probe failure」進入 RUN stable codes 世界觀，必須在 builder 內做顯式映射
 *   （例如 mapProbeCodeToRunCode），並以測試鎖定映射表；不得隱式混用兩套 codes。
 */

'use strict';

// ===== ProbeStep Tool Name Enum =====

/**
 * ProbeStep tool_name 固定枚舉
 * - 命名格式：probe.<probe_name>
 * - 目的：避免 security_probe、probeSecurity 等變體造成聚合/查詢困難
 */
const PROBE_STEP_TOOL_NAMES = Object.freeze({
  SECURITY: 'probe.security',
  ACCESS: 'probe.access',
  SEARCH: 'probe.search',
  MEMORY: 'probe.memory'
});

/**
 * 驗證 tool_name 是否為合法 ProbeStep
 */
function isProbeStepToolName(toolName) {
  return Object.values(PROBE_STEP_TOOL_NAMES).includes(toolName);
}

// ===== Probe StepReport Pass/Fail 判定規則 =====

/**
 * CRITICAL CONTRACT (Phase D):
 * Probe pass/fail 只看 StepReport 欄位，不依賴 attempt_events 或 message
 *
 * pass: status='ok' && code==null
 * fail: status in {'blocked','failed'} && code!=null
 */
function isProbeStepPass(stepReport) {
  return stepReport.status === 'ok' && stepReport.code === null;
}

function isProbeStepFail(stepReport) {
  return (stepReport.status === 'blocked' || stepReport.status === 'failed') &&
         stepReport.code !== null;
}

// ===== Probe Stable Codes (不污染 RUN_CODES) =====

/**
 * Probe 專用 stable codes（獨立於 lib/tool_runner/ssot.js RUN_CODES）
 *
 * 設計決策：
 * - 避免污染 RunnerCore/ToolGateway 的 RUN_CODES mapping
 * - Probe StepReport.code 只在 fail 時出現（ok 時必為 null）
 * - attempt_events[*].code 可使用這些 codes 追溯內部嘗試
 */
const PROBE_STEP_CODES = Object.freeze({
  // Access probe specific
  FS_LIST_LOGS_FAILED: 'FS_LIST_LOGS_FAILED',
  FS_ACCESS_DENIED: 'FS_ACCESS_DENIED',
  
  // Search probe specific
  SEARCH_PROBE_INVALID_SHAPE: 'SEARCH_PROBE_INVALID_SHAPE',
  SEARCH_PROBE_FAILED: 'SEARCH_PROBE_FAILED',
  
  // Memory probe specific
  MEMORY_READ_FAILED: 'MEMORY_READ_FAILED',
  MEMORY_ACCESS_DENIED: 'MEMORY_ACCESS_DENIED',
  
  // Provider-level (shared)
  PROBE_PROVIDER_UNAVAILABLE: 'PROBE_PROVIDER_UNAVAILABLE',
  PROBE_PROVIDER_TIMEOUT: 'PROBE_PROVIDER_TIMEOUT',
  
  // Force failure (deterministic testing)
  PROBE_FORCED_FAIL: 'PROBE_FORCED_FAIL',
  
  // Invalid shape injection (deterministic testing)
  PROBE_FORCED_INVALID_SHAPE: 'PROBE_FORCED_INVALID_SHAPE'
});

/**
 * Probe attempt_event codes（只用於 attempt_events，不得作為 StepReport.code）
 */
const PROBE_ATTEMPT_CODES = Object.freeze({
  // Security probe attempt (access control)
  FS_PATH_NOT_WHITELISTED: 'FS_PATH_NOT_WHITELISTED',
  PROBE_SKIPPED_NO_MCP: 'PROBE_SKIPPED_NO_MCP'
});

/**
 * Helper: 判定是否為 Probe namespace code（包含 step codes 與 attempt codes）
 */
function isProbeCode(code) {
  if (typeof code !== 'string') return false;
  return Object.values(PROBE_STEP_CODES).includes(code) || Object.values(PROBE_ATTEMPT_CODES).includes(code);
}

/**
 * Probe code → status mapping (blocked vs failed)
 *
 * 規則：
 * - blocked: 規格/環境不允許執行（例如 access denied, invalid shape）
 * - failed: 有能力執行但失敗（例如 timeout, probe failed）
 */
const PROBE_CODE_TO_STATUS = Object.freeze({
  // blocked
  [PROBE_STEP_CODES.FS_ACCESS_DENIED]: 'blocked',
  [PROBE_STEP_CODES.SEARCH_PROBE_INVALID_SHAPE]: 'blocked',
  [PROBE_STEP_CODES.MEMORY_ACCESS_DENIED]: 'blocked',
  [PROBE_STEP_CODES.PROBE_FORCED_INVALID_SHAPE]: 'blocked',
  
  // failed
  [PROBE_STEP_CODES.FS_LIST_LOGS_FAILED]: 'failed',
  [PROBE_STEP_CODES.SEARCH_PROBE_FAILED]: 'failed',
  [PROBE_STEP_CODES.MEMORY_READ_FAILED]: 'failed',
  [PROBE_STEP_CODES.PROBE_PROVIDER_UNAVAILABLE]: 'failed',
  [PROBE_STEP_CODES.PROBE_PROVIDER_TIMEOUT]: 'failed',
  [PROBE_STEP_CODES.PROBE_FORCED_FAIL]: 'failed'
});

/**
 * 取得 probe code 對應的 status
 */
function getProbeCodeStatus(code) {
  return PROBE_CODE_TO_STATUS[code] || 'failed';
}

// ===== Attempt Event 最小欄位 (Phase D Contract) =====

/**
 * attempt_events[] 最小必備欄位（避免變成 log dump）
 *
 * - as_of: ISO8601 timestamp
 * - status: 'ok' | 'blocked' | 'failed'
 * - code: stable code 或 null
 * - duration_ms: number
 * - note?: 可選短字串（不要自由長文本）
 */
const ATTEMPT_EVENT_REQUIRED_KEYS = Object.freeze(['as_of', 'status', 'code', 'duration_ms']);

function validateAttemptEvent(event) {
  if (typeof event !== 'object' || event === null) {
    return { valid: false, message: 'attempt_event must be an object' };
  }
  
  for (const key of ATTEMPT_EVENT_REQUIRED_KEYS) {
    if (!(key in event)) {
      return { valid: false, message: `Missing required key: ${key}` };
    }
  }
  
  // status 必須是合法值
  if (!['ok', 'blocked', 'failed'].includes(event.status)) {
    return { valid: false, message: `Invalid status: ${event.status}` };
  }
  
  // code 必須是 string 或 null
  if (event.code !== null && typeof event.code !== 'string') {
    return { valid: false, message: 'code must be string or null' };
  }

  // code（若非 null）必須屬於 Probe namespace，避免任意 code 混入
  if (event.code !== null && !isProbeCode(event.code)) {
    return { valid: false, message: `code must be a probe namespace code: ${event.code}` };
  }
  
  // duration_ms 必須是非負數
  if (typeof event.duration_ms !== 'number' || event.duration_ms < 0) {
    return { valid: false, message: 'duration_ms must be non-negative number' };
  }
  
  // as_of 必須是字串（不驗證 ISO8601 格式，交給 schema）
  if (typeof event.as_of !== 'string') {
    return { valid: false, message: 'as_of must be string' };
  }
  
  return { valid: true };
}

module.exports = {
  PROBE_STEP_TOOL_NAMES,
  PROBE_STEP_CODES,
  PROBE_ATTEMPT_CODES,
  PROBE_CODE_TO_STATUS,
  ATTEMPT_EVENT_REQUIRED_KEYS,
  isProbeStepToolName,
  isProbeCode,
  isProbeStepPass,
  isProbeStepFail,
  getProbeCodeStatus,
  validateAttemptEvent
};
