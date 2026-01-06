'use strict';

/**
 * stable_codes.js
 *
 * Single mapping入口：將各層錯誤（gateway/service/runner）映射為 stable RUN_CODES。
 *
 * NOTE:
 * - RUN_CODES SSOT 仍以 lib/tool_runner/ssot.js 為準。
 * - 這個檔案只負責 mapping（避免 ToolGatewayAdapter / ToolExecutionService / RunnerCore 各自維護）。
 */

const { RUN_CODES } = require('../tool_runner/ssot');

const GATEWAY_ERROR_CODE_MAPPING = Object.freeze({
  // Timeout variants
  timeout: RUN_CODES.TOOL_TIMEOUT,
  TIMEOUT: RUN_CODES.TOOL_TIMEOUT,
  request_timeout: RUN_CODES.TOOL_TIMEOUT,
  execution_timeout: RUN_CODES.TOOL_TIMEOUT,

  // Unavailable variants
  unavailable: RUN_CODES.TOOL_UNAVAILABLE,
  UNAVAILABLE: RUN_CODES.TOOL_UNAVAILABLE,
  service_unavailable: RUN_CODES.TOOL_UNAVAILABLE,
  not_available: RUN_CODES.TOOL_UNAVAILABLE,

  // Execution failures
  error: RUN_CODES.TOOL_EXEC_FAILED,
  ERROR: RUN_CODES.TOOL_EXEC_FAILED,
  execution_error: RUN_CODES.TOOL_EXEC_FAILED,
  internal_error: RUN_CODES.TOOL_EXEC_FAILED
});

function isStableRunCode(code) {
  return typeof code === 'string' && Object.values(RUN_CODES).includes(code);
}

function mapGatewayErrorCode(gatewayCode) {
  if (typeof gatewayCode !== 'string') {
    return RUN_CODES.TOOL_EXEC_FAILED;
  }
  if (isStableRunCode(gatewayCode)) {
    return gatewayCode;
  }
  return GATEWAY_ERROR_CODE_MAPPING[gatewayCode] || RUN_CODES.TOOL_EXEC_FAILED;
}

/**
 * mapToStableCode(err, ctx)
 *
 * Supported inputs:
 * - string: treated as a gateway/remote error code
 * - { code }: treated as gateway error-ish
 * - Error: message heuristics (very conservative)
 */
function mapToStableCode(err, ctx = {}) {
  // 1) Direct string code
  if (typeof err === 'string') {
    return mapGatewayErrorCode(err);
  }

  // 2) Error-like object with a code
  const code = err && typeof err === 'object' ? err.code : undefined;
  if (typeof code === 'string') {
    return mapGatewayErrorCode(code);
  }

  // 3) Axios-like / Node errors (best-effort, minimal)
  const message = err && typeof err === 'object' ? String(err.message || '') : '';
  const name = err && typeof err === 'object' ? String(err.name || '') : '';

  // Timeout signals
  if (message.includes('timeout') || name.toLowerCase().includes('timeout')) {
    return RUN_CODES.TOOL_TIMEOUT;
  }

  // Transport/unavailable signals
  if (message.includes('ECONNREFUSED') || message.includes('EPIPE') || message.includes('ENOTFOUND')) {
    return RUN_CODES.TOOL_UNAVAILABLE;
  }

  // Runner context: missing gateway or programmer error → TOOL_EXEC_FAILED
  if (ctx && ctx.boundary === 'runner') {
    return RUN_CODES.TOOL_EXEC_FAILED;
  }

  return RUN_CODES.TOOL_EXEC_FAILED;
}

module.exports = {
  GATEWAY_ERROR_CODE_MAPPING,
  isStableRunCode,
  mapGatewayErrorCode,
  mapToStableCode
};
