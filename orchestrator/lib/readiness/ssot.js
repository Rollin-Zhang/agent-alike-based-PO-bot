/**
 * M2-A.1 Readiness SSOT (Single Source of Truth)
 *
 * 不可變規範：
 * - DepKey（產品層，metrics label 用，永不改名）
 * - ProviderId（實作層，ToolGateway 內部 provider 名稱，可變）
 * - Mapping（DepKey ↔ ProviderId）
 * - Code 分層（dep-level vs http-level）
 * - JSON schemas（/health, /metrics, 503 body）
 *
 * 明確策略（必修保護 #1：避免未來誤改回 filesystem required）
 * - requiredDeps 現在 = ['memory','web_search']
 * - filesystem 不是 required（Stage 2 暫時 non-required，等 provider 補齊再切回 required）
 *   - 必須仍出現在 knownDeps/futureRequiredCandidates 中，避免被當成遺失 bug
 */

// ===== DepKey ↔ ProviderId Mapping =====

/**
 * Required dependencies (must be available for /v1/tools/execute to work)
 *
 * 明確策略：Stage 2 暫時 required = memory + web_search。
 */
const REQUIRED_DEPS = [
  { key: 'memory', provider: 'memory' },
  { key: 'web_search', provider: 'web_search' }
];

/**
 * Optional dependencies (degraded if unavailable, but system still operational)
 */
const OPTIONAL_DEPS = [
  { key: 'notebooklm', provider: 'notebooklm' }
];

/**
 * Known deps / future candidates
 * - 這些是「產品層 DepKey」的穩定集合
 * - 即使非 required，也要保留以避免後續誤判為 bug
 */
const KNOWN_DEPS = [
  { key: 'memory', provider: 'memory' },
  { key: 'web_search', provider: 'web_search' },
  { key: 'notebooklm', provider: 'notebooklm' },
  // Stage 2: 暫時 non-required，等 provider 補齊再切回 required
  { key: 'filesystem', provider: 'filesystem', note: 'Stage 2 暫時 non-required；provider 補齊後可升級回 required' }
];

/**
 * Candidates that are expected to become required later.
 */
const FUTURE_REQUIRED_CANDIDATES = [
  { key: 'filesystem', provider: 'filesystem' }
];

// Build reverse lookup: ProviderId → DepKey
const PROVIDER_TO_DEPKEY = {};
[...REQUIRED_DEPS, ...OPTIONAL_DEPS].forEach(({ key, provider }) => {
  PROVIDER_TO_DEPKEY[provider] = key;
});

// Build forward lookup: DepKey → ProviderId
const DEPKEY_TO_PROVIDER = {};
[...REQUIRED_DEPS, ...OPTIONAL_DEPS].forEach(({ key, provider }) => {
  DEPKEY_TO_PROVIDER[key] = provider;
});

// ===== Code 分層（強制分工） =====

/**
 * Dep-level codes: 只允許出現在 /health 的 required/optional 狀態中
 */
const DEP_CODES = {
  UNAVAILABLE: 'DEP_UNAVAILABLE',      // NO_MCP、未連線、未初始化
  INIT_FAILED: 'DEP_INIT_FAILED',      // 連線失敗
  TIMEOUT: 'DEP_TIMEOUT',              // 初始化超時
  UNKNOWN: 'DEP_UNKNOWN'               // 保底
};

/**
 * HTTP-level codes: 只允許出現在 middleware 擋下事件（503 response）
 */
const HTTP_CODES = {
  REQUIRED_UNAVAILABLE: 'MCP_REQUIRED_UNAVAILABLE'
};

/**
 * /metrics readiness counter key format
 * - 建議使用 SSOT 提供的 formatter，避免各處拼字漂移
 */
function formatCounterKey(depKey, httpCode) {
  return `${depKey}|${httpCode}`;
}

/**
 * 必修保護 #2：/v1/tools/execute 的 gating deps 要與「工具實際需求」切開。
 *
 * 目前策略（stub）：全部工具都 require memory + web_search。
 * 後續若加入 filesystem 相關工具，請在此加入 toolName → deps 規則。
 */
function depsForToolName(toolName) {
  /**
   * Guardrail (小洞 A): fallback 策略必須保守，避免 unknown tool 不擋。
   * - unknown toolName（字串但不匹配任何規則）→ 回 requiredDeps（最保守策略）
   * - missing/invalid toolName（undefined/null/非字串）→ 不應由此決定，
   *   應在 request validation / schemaGate 先擋下（400/blocked），避免被用來繞過 gating。
   */

  if (typeof toolName !== 'string') {
    return REQUIRED_DEPS.map(d => d.key);
  }

  // Per-tool deps (recommended): server-level tool names map to their own provider.
  // - memory tools require memory
  // - web_search tools require web_search
  // - notebooklm tools require notebooklm (even though it's optional globally)
  if (toolName === 'memory') return ['memory'];
  if (toolName === 'web_search') return ['web_search'];
  if (toolName === 'notebooklm') return ['notebooklm'];

  // Reserved slot for future mapping (e.g. filesystem).
  // Conservative fallback: unknown tool still requires required deps.
  return REQUIRED_DEPS.map(d => d.key);
}

// ===== JSON Schemas =====

/**
 * ReadinessSnapshot schema (used by /health, evaluator output, strict init snapshot)
 * 
 * Example:
 * {
 *   degraded: true,
 *   required: {
 *     memory: { ready: false, code: 'DEP_UNAVAILABLE', detail: { reason: 'NO_MCP' } },
 *     web_search: { ready: false, code: 'DEP_UNAVAILABLE' }
 *   },
 *   optional: {
 *     notebooklm: { ready: false, code: 'DEP_UNAVAILABLE' }
 *   },
 *   as_of: '2026-01-01T12:00:00.000Z'
 * }
 */
function validateReadinessSnapshot(snapshot) {
  if (typeof snapshot !== 'object' || !snapshot) return false;
  if (typeof snapshot.degraded !== 'boolean') return false;
  if (typeof snapshot.required !== 'object' || !snapshot.required) return false;
  if (typeof snapshot.optional !== 'object' || !snapshot.optional) return false;
  if (typeof snapshot.as_of !== 'string') return false;

  // Validate required deps
  for (const { key } of REQUIRED_DEPS) {
    const dep = snapshot.required[key];
    if (!dep || typeof dep.ready !== 'boolean') return false;
    if (dep.code !== null && typeof dep.code !== 'string') return false;
    // Enforce: required/optional.*.code 禁止出現 MCP_REQUIRED_UNAVAILABLE
    if (dep.code === HTTP_CODES.REQUIRED_UNAVAILABLE) return false;
  }

  // Validate optional deps
  for (const { key } of OPTIONAL_DEPS) {
    const dep = snapshot.optional[key];
    if (!dep || typeof dep.ready !== 'boolean') return false;
    if (dep.code !== null && typeof dep.code !== 'string') return false;
    if (dep.code === HTTP_CODES.REQUIRED_UNAVAILABLE) return false;
  }

  return true;
}

/**
 * 503 body schema (used by requireDeps middleware)
 * 
 * Example:
 * {
 *   error_code: 'MCP_REQUIRED_UNAVAILABLE',
 *   missing_required: ['memory', 'web_search'],
 *   degraded: true,
 *   as_of: '2026-01-01T12:00:00.000Z'
 * }
 */
function validate503Body(body) {
  if (typeof body !== 'object' || !body) return false;
  if (body.error_code !== HTTP_CODES.REQUIRED_UNAVAILABLE) return false;
  if (!Array.isArray(body.missing_required)) return false;
  if (typeof body.degraded !== 'boolean') return false;
  if (typeof body.as_of !== 'string') return false;
  return true;
}

/**
 * /metrics readiness shape (固定結構，維持 JSON)
 * 
 * Example:
 * {
 *   readiness: {
 *     degraded: 1,
 *     required_ready: { memory: 0, web_search: 0 },
 *     optional_ready: { notebooklm: 0 },
 *     required_unavailable_total: {
 *       'memory|MCP_REQUIRED_UNAVAILABLE': 5,
 *       'web_search|MCP_REQUIRED_UNAVAILABLE': 3
 *     }
 *   }
 * }
 */
function validateMetricsReadinessShape(readiness) {
  if (typeof readiness !== 'object' || !readiness) return false;
  if (typeof readiness.degraded !== 'number') return false;
  if (typeof readiness.required_ready !== 'object' || !readiness.required_ready) return false;
  if (typeof readiness.optional_ready !== 'object' || !readiness.optional_ready) return false;
  if (typeof readiness.required_unavailable_total !== 'object' || !readiness.required_unavailable_total) return false;

  // Validate required_ready keys
  for (const { key } of REQUIRED_DEPS) {
    if (typeof readiness.required_ready[key] !== 'number') return false;
  }

  // Validate optional_ready keys
  for (const { key } of OPTIONAL_DEPS) {
    if (typeof readiness.optional_ready[key] !== 'number') return false;
  }

  // Validate required_unavailable_total keys format: "depKey|MCP_REQUIRED_UNAVAILABLE"
  for (const counterKey of Object.keys(readiness.required_unavailable_total)) {
    if (!counterKey.includes('|MCP_REQUIRED_UNAVAILABLE')) return false;
    // Enforce: 禁止用 DEP_* codes 打到 counter
    for (const depCode of Object.values(DEP_CODES)) {
      if (counterKey.includes(depCode)) return false;
    }
  }

  return true;
}

// ===== STRICT_MCP_INIT Output Format =====

/**
 * Strict init fail 最後輸出點格式
 * Format: "[readiness][strict_init_fail] " + JSON.stringify(snapshot)
 */
const STRICT_INIT_FAIL_PREFIX = '[readiness][strict_init_fail] ';

function formatStrictInitFailOutput(snapshot) {
  return STRICT_INIT_FAIL_PREFIX + JSON.stringify(snapshot);
}

function parseStrictInitFailOutput(line) {
  if (!line.startsWith(STRICT_INIT_FAIL_PREFIX)) return null;
  try {
    const json = line.slice(STRICT_INIT_FAIL_PREFIX.length);
    const snapshot = JSON.parse(json);
    return validateReadinessSnapshot(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

// ===== Exports =====

module.exports = {
  // Mapping
  REQUIRED_DEPS,
  OPTIONAL_DEPS,
  KNOWN_DEPS,
  FUTURE_REQUIRED_CANDIDATES,
  PROVIDER_TO_DEPKEY,
  DEPKEY_TO_PROVIDER,

  // Codes
  DEP_CODES,
  HTTP_CODES,

  // Key formatter / tool deps
  formatCounterKey,
  depsForToolName,

  // Validators
  validateReadinessSnapshot,
  validate503Body,
  validateMetricsReadinessShape,

  // Strict init output
  STRICT_INIT_FAIL_PREFIX,
  formatStrictInitFailOutput,
  parseStrictInitFailOutput
};
