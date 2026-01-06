/**
 * ToolExecutionService.js
 * M2-A ↔ M2-B Integration: In-process 治理層
 *
 * 提供工具執行的統一入口，集中 M2-A 治理能力：
 * - Readiness gating (requireDeps)
 * - Schema gate (args/outputs validation)
 * - Audit/metrics (tool execution trace)
 * - Tool args allowlist/validator
 * - Actual tool execution (via ToolGateway)
 *
 * 注意：這是 in-process service，M2-B RunnerCore 透過 adapter 呼叫，
 * 而不是走 HTTP /v1/tools/execute（後者是未來可選的升級路徑）。
 */

const { evaluateReadiness } = require('../readiness/evaluateReadiness');
const { readinessMetrics } = require('../readiness/readinessMetrics');
const { depsForToolName } = require('../readiness/ssot');
const { RUN_CODES } = require('../tool_runner/ssot');
const { mapGatewayErrorCode } = require('../run_report/stable_codes');
const schemaGate = require('../schemaGate');

/**
 * ToolExecutionService
 *
 * Options:
 * - toolGateway: ToolGateway instance (for actual MCP execution)
 * - logger: logger instance (default: console)
 * - mode: 'NO_MCP' | 'NORMAL' (default: from env NO_MCP)
 */
class ToolExecutionService {
  constructor(options = {}) {
    const {
      toolGateway = null,
      logger = console,
      mode = process.env.NO_MCP === 'true' ? 'NO_MCP' : 'NORMAL'
    } = options;

    if (!toolGateway) {
      throw new Error('ToolExecutionService requires toolGateway');
    }

    this.toolGateway = toolGateway;
    this.logger = logger;
    this.mode = mode;
  }

  /**
   * Execute a tool with full M2-A governance
   *
   * @param {Object} params
   * @param {string} params.tool_name - Server-level tool name (e.g. 'memory', 'web_search')
   * @param {Object} params.args - Tool arguments
   * @param {Object} params.context - Execution context (ticket_id, step_index, step)
   * @returns {Object} { ok, result?, error?, evidenceCandidates? }
   *
   * Error codes (stable):
   * - MCP_REQUIRED_UNAVAILABLE: required deps not ready
   * - INVALID_TOOL_STEP: missing tool name or _original_tool in context
   * - INVALID_TOOL_ARGS: args validation failed (schemaGate strict)
   * - TOOL_EXEC_FAILED / TOOL_TIMEOUT / TOOL_UNAVAILABLE: execution errors
   */
  async executeTool({ tool_name, args, context }) {
    const startTime = Date.now();

    // 1) Validate inputs
    if (typeof tool_name !== 'string' || tool_name.trim() === '') {
      return {
        ok: false,
        error: {
          code: RUN_CODES.INVALID_TOOL_STEP,
          message: 'tool_name is required'
        }
      };
    }

    // Extract MCP tool name from context (trace-only field)
    const mcpToolName = context?.step?._original_tool || context?._original_tool || null;
    if (typeof mcpToolName !== 'string' || mcpToolName.trim() === '') {
      return {
        ok: false,
        error: {
          code: RUN_CODES.INVALID_TOOL_STEP,
          message: 'Missing MCP tool name in context (expected context.step._original_tool)'
        }
      };
    }

    // 2) Readiness gating
    const requiredDepKeys = depsForToolName(tool_name);
    const depStates = this.toolGateway.getDepStates();
    const snapshot = evaluateReadiness(depStates, new Date());

    const missingRequired = [];
    for (const depKey of requiredDepKeys) {
      const depState = snapshot.required[depKey];
      if (!depState || !depState.ready) {
        missingRequired.push(depKey);
      }
    }

    if (missingRequired.length > 0) {
      // Increment counters (same as HTTP middleware)
      for (const depKey of missingRequired) {
        readinessMetrics.incrementRequiredUnavailable(depKey);
      }

      return {
        ok: false,
        error: {
          code: RUN_CODES.MCP_REQUIRED_UNAVAILABLE,
          message: `Required deps unavailable: ${missingRequired.join(', ')}`,
          detail: {
            missing_required: missingRequired,
            degraded: snapshot.degraded
          }
        }
      };
    }

    // 3) Schema gate: args validation (strict internal mode)
    const schemaGateMode = process.env.SCHEMA_GATE_MODE || 'off';
    if (schemaGateMode !== 'off') {
      // Use schemaGate internal mode (never throw, return ok=false on reject)
      const argsGateResult = schemaGate.gateInternal(
        { args },
        {
          boundary: 'tool_execute_args',
          direction: 'internal',
          kind: 'TOOL',
          ticketId: context?.ticket_id || 'unknown'
        }
      );

      if (!argsGateResult.ok) {
        // Schema gate reject: return blocked (do not execute tool)
        this.logger?.warn?.(
          `[ToolExecutionService] Args validation rejected for tool=${tool_name}:`,
          argsGateResult.code,
          argsGateResult.errors
        );

        return {
          ok: false,
          error: {
            code: RUN_CODES.INVALID_TOOL_ARGS,
            message: 'Tool args validation failed',
            detail: {
              warn_codes: argsGateResult.errors || [],
              schema_gate_mode: schemaGateMode
            }
          }
        };
      }
    }

    // 4) Execute tool via ToolGateway
    try {
      // Map tool_name (server-level) + mcpToolName to ToolGateway executeTool(server, tool, args)
      const server = tool_name;
      const tool = mcpToolName;

      const result = await this.toolGateway.executeTool(server, tool, args || {});

      // ToolGateway response shape (legacy): may return { content, error, ... }
      // We normalize to RunnerCore adapter shape: { ok, result?, error? }

      if (result && (result.content || result.result || result.success)) {
        // Success path
        return {
          ok: true,
          result: result.content || result.result || result,
          evidenceCandidates: result.evidenceCandidates || []
        };
      }

      if (result && result.error) {
        // Error path
        return {
          ok: false,
          error: {
            code: mapGatewayErrorCode(result.error.code),
            message: result.error.message || 'Tool execution failed',
            detail: result.error.detail
          }
        };
      }

      // Fallback: unclear response shape
      this.logger?.warn?.(
        `[ToolExecutionService] Unclear ToolGateway response shape for tool=${tool_name}:`,
        result
      );

      return {
        ok: true,
        result: result,
        evidenceCandidates: []
      };
    } catch (err) {
      // Gateway threw exception
      this.logger?.error?.(
        `[ToolExecutionService] ToolGateway threw exception for tool=${tool_name}:`,
        err?.message
      );

      return {
        ok: false,
        error: {
          code: RUN_CODES.TOOL_EXEC_FAILED,
          message: err?.message || 'Tool execution exception',
          detail: { stack: err?.stack }
        }
      };
    }
  }

  /**
   * Map ToolGateway error code to stable RUN_CODES
   * (Reuse logic from ToolGatewayAdapter)
   */
  mapGatewayErrorCode(gatewayCode) {
    return mapGatewayErrorCode(gatewayCode);
  }
}

module.exports = { ToolExecutionService };
