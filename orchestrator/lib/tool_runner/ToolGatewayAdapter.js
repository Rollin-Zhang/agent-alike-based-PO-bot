/**
 * ToolGatewayAdapter.js
 * M2-B1-3: ToolGateway 最小介面與穩定映射
 *
 * Interface:
 * - execute({ toolName, args, context }) -> { ok, result?, error?, evidenceCandidates? }
 *
 * Guardrails:
 * - 禁止 raw error string 直接進 RunReport
 * - 只允許 stable error.code 或映射成 stable code
 * - 若 gateway 回非 stable code → 映射到 fallback codes
 */

const { RUN_CODES, RUN_STATUS, CODE_TO_STATUS } = require('./ssot');
const axios = require('axios');

const {
  GATEWAY_ERROR_CODE_MAPPING,
  mapGatewayErrorCode
} = require('../run_report/stable_codes');

// ===== Error Code Mapping (gateway → stable) =====
// Single source: lib/run_report/stable_codes.js

// ===== Stub Gateway (for testing) =====

/**
 * StubToolGateway: 用於單測的假 gateway
 * 
 * 用法：
 *   const stub = createStubGateway({ web_search: { ok: true, result: {...} } });
 *   const response = stub.execute({ toolName: 'web_search', args: {...} });
 */
function createStubGateway(fixtures = {}) {
  return {
    execute({ toolName, args, context }) {
      const fixture = fixtures[toolName];
      if (!fixture) {
        return {
          ok: false,
          error: {
            code: RUN_CODES.UNKNOWN_TOOL,
            message: `Stub: tool not found: ${toolName}`
          }
        };
      }

      // 若 fixture 是函式，呼叫並取結果
      if (typeof fixture === 'function') {
        return fixture({ toolName, args, context });
      }

      // 否則直接回傳 fixture
      return fixture;
    }
  };
}

// ===== Real Gateway Adapter (wrap existing ToolGateway) =====

/**
 * RealToolGatewayAdapter: 包裝既有的 ToolGateway
 * 將其回傳格式統一成 { ok, result?, error?, evidenceCandidates? }
 * 
 * 注意：現有 ToolGateway 的 executeTool() 介面可能不同，需要適配
 */
class RealToolGatewayAdapter {
  constructor(toolGateway) {
    this.gateway = toolGateway;
  }

  /**
   * execute({ toolName, args, context }) -> { ok, result?, error?, evidenceCandidates? }
   */
  async execute({ toolName, args, context }) {
    try {
      // 呼叫既有 gateway 的 executeTool
      // 假設 executeTool 回傳 { success, result, error }
      const response = await this.gateway.executeTool(toolName, args, context);

      if (response.success === true || response.ok === true) {
        return {
          ok: true,
          result: response.result || response.data,
          evidenceCandidates: response.evidenceCandidates || []
        };
      } else {
        // 失敗：映射 error code
        const rawCode = response.error?.code || response.code || 'error';
        const stableCode = mapGatewayErrorCode(rawCode);

        return {
          ok: false,
          error: {
            code: stableCode,
            message: response.error?.message || response.message || 'Tool execution failed',
            detail: response.error?.detail || response.detail
          }
        };
      }
    } catch (err) {
      // gateway throw 錯誤 → 統一映射成 TOOL_EXEC_FAILED
      return {
        ok: false,
        error: {
          code: RUN_CODES.TOOL_EXEC_FAILED,
          message: err.message || 'Tool execution exception',
          detail: err.stack
        }
      };
    }
  }
}

// ===== In-Process Gateway Adapter (M2-A ↔ M2-B primary integration) =====

/**
 * InProcessToolsGatewayAdapter
 *
 * Bridges RunnerCore gateway interface to in-process ToolExecutionService.
 * This is the default/recommended path for Stage 2 M2-B integration.
 *
 * Benefits over HTTP:
 * - Same memory space: no serialization/transport overhead
 * - Same governance: reuses M2-A readiness/schemaGate/audit
 * - Simpler observability: single process logs/metrics
 * - No HTTP server dependency for tool execution
 *
 * Upgrade path: If cross-process execution is needed (e.g. multi-machine,
 * tool isolation, rate-limiting at HTTP layer), switch to HttpToolsExecuteGatewayAdapter
 * by swapping adapter instance (no RunnerCore changes required).
 */
class InProcessToolsGatewayAdapter {
  constructor(toolExecutionService, logger = console) {
    if (!toolExecutionService || typeof toolExecutionService.executeTool !== 'function') {
      throw new Error('InProcessToolsGatewayAdapter requires a valid ToolExecutionService instance');
    }

    this.service = toolExecutionService;
    this.logger = logger;
  }

  async execute({ toolName, args, context }) {
    // Delegate directly to ToolExecutionService (same-process)
    return this.service.executeTool({ tool_name: toolName, args, context });
  }
}

// ===== HTTP Gateway Adapter (Future/Optional upgrade path) =====

/**
 * HttpToolsExecuteGatewayAdapter
 *
 * Bridges RunnerCore gateway interface to Orchestrator HTTP API:
 *   POST /v1/tools/execute { server, tool, arguments }
 *
 * NOTE: This is NOT the default path for Stage 2 M2-B integration.
 * Use InProcessToolsGatewayAdapter unless you have specific requirements for:
 * - Cross-process tool execution
 * - Multi-machine horizontal scaling
 * - Tool runtime isolation
 * - Centralized rate-limiting/circuit-breaking at HTTP layer
 *
 * If none of the above apply, prefer in-process adapter for simplicity.
 */
class HttpToolsExecuteGatewayAdapter {
  constructor(options = {}) {
    const { baseUrl, timeoutMs = 30000, logger = console } = options;

    if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
      throw new Error('HttpToolsExecuteGatewayAdapter requires baseUrl');
    }

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  async execute({ toolName, args, context }) {
    // RunnerCore toolName == providerId/server
    const server = toolName;
    const tool = context?.step?._original_tool || context?._original_tool || null;

    if (typeof tool !== 'string' || tool.trim() === '') {
      return {
        ok: false,
        error: {
          code: RUN_CODES.INVALID_TOOL_STEP,
          message: 'Missing MCP tool name for HTTP gateway (expected context.step._original_tool)'
        }
      };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/v1/tools/execute`,
        {
          server,
          tool,
          arguments: args || {}
        },
        {
          timeout: this.timeoutMs,
          // allow us to handle non-2xx as normal responses
          validateStatus: () => true
        }
      );

      // Success
      if (response.status >= 200 && response.status < 300) {
        return {
          ok: true,
          result: response.data,
          evidenceCandidates: []
        };
      }

      // Readiness gating
      if (response.status === 503 && response.data && response.data.error_code === RUN_CODES.MCP_REQUIRED_UNAVAILABLE) {
        return {
          ok: false,
          error: {
            code: RUN_CODES.MCP_REQUIRED_UNAVAILABLE,
            message: 'Required MCP deps unavailable',
            detail: response.data
          }
        };
      }

      // Request validation / contract issues
      if (response.status === 400) {
        return {
          ok: false,
          error: {
            code: RUN_CODES.INVALID_TOOL_STEP,
            message: response.data?.error || 'Bad request'
          }
        };
      }

      // Timeout / upstream errors
      if (response.status === 408 || response.status === 504) {
        return {
          ok: false,
          error: {
            code: RUN_CODES.TOOL_TIMEOUT,
            message: 'Tool request timed out'
          }
        };
      }

      // Other failures
      return {
        ok: false,
        error: {
          code: RUN_CODES.TOOL_EXEC_FAILED,
          message: response.data?.error || `HTTP tool execute failed (status=${response.status})`
        }
      };
    } catch (err) {
      // Network/transport error
      this.logger?.error?.('[HttpToolsExecuteGatewayAdapter] Request failed', err?.message);
      return {
        ok: false,
        error: {
          code: RUN_CODES.TOOL_UNAVAILABLE,
          message: err?.message || 'HTTP gateway unavailable'
        }
      };
    }
  }
}

module.exports = {
  GATEWAY_ERROR_CODE_MAPPING,
  mapGatewayErrorCode,
  createStubGateway,
  RealToolGatewayAdapter,
  InProcessToolsGatewayAdapter,
  HttpToolsExecuteGatewayAdapter
};
