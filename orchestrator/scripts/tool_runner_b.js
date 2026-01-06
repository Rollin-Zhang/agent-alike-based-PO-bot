#!/usr/bin/env node
/**
 * tool_runner_b.js - B-script executor (M2-B.2)
 * 
 * Stage 2 TOOL worker: lease pending TOOL tickets → run RunnerCore → writeback → report
 * 
 * Usage:
 *   node orchestrator/scripts/tool_runner_b.js [options]
 * 
 * Options:
 *   --limit <n>          Max tickets to process in this run (default: 10)
 *   --lease-sec <n>      Lease duration in seconds (default: 300)
 *   --owner <name>       Lease owner identifier (default: auto-generated)
 *   --no-mcp             Use stub gateway (offline mode)
 *   --real-mcp           Use real MCP gateway (requires RUN_REAL_MCP_TESTS=true or MCP_CONFIG_PATH)
 * 
 * Environment:
 *   NO_MCP=true                  Force stub gateway
 *   RUN_REAL_MCP_TESTS=true      Enable real MCP gateway
 *   MCP_CONFIG_PATH=<path>       MCP config path
 *   SCHEMA_GATE_MODE=<mode>      Schema gate mode (off/warn/strict)
 *   TICKETSTORE_PATH=<path>      Ticket store data path
 * 
 * Exit codes:
 *   0 - All tickets ok or no tickets processed
 *   1 - Executor fatal error
 *   2 - Some tickets blocked (no failed)
 *   3 - Some tickets failed
 * 
 * Output:
 *   JSON report to stdout with structure defined in b_script_executor_ssot.js
 */

const path = require('path');
const TicketStore = require('../store/TicketStore');
const { run: runCore } = require('../lib/tool_runner/RunnerCore');
const { createStubGateway, InProcessToolsGatewayAdapter } = require('../lib/tool_runner/ToolGatewayAdapter');
const { RUN_STATUS, RUN_CODES } = require('../lib/tool_runner/ssot');
const { bridgeToolSteps } = require('../lib/tool_runner/b_script_bridge');
const { attachEvidence } = require('../lib/evidence/attachEvidence');
const { EvidenceStore } = require('../lib/evidence/EvidenceStore');
const { getEvidenceLimitsFromEnv } = require('../lib/evidence/ssot');
const {
  REPORT_VERSION,
  EXIT_CODE,
  getWorstExitCode,
  mapRunReportStatusToVerdict,
  COUNTER_KEYS,
  SAMPLE_LIMITS,
  EXECUTOR_CODES,
  createReport,
  addSample
} = require('../lib/tool_runner/b_script_executor_ssot');
const { maybeDeriveReplyFromToolOnFill } = require('../lib/maybeDeriveReplyFromToolOnFill');
const { readToolVerdict, isProceed } = require('../lib/toolVerdict');


// ===== Evidence Wrapper (A.2 → RunnerCore) =====

/**
 * 包裝 A.2 attachEvidence() 成 RunnerCore 期待的形式
 * - A.2 回 {item}
 * - RunnerCore 期待 (candidate) => EvidenceItem
 * - bytes 只進 A.2，不進 RunReport（Decision 3）
 */
function createEvidenceAttachWrapper(limits, store) {
  return async (candidate) => {
    // 注意：candidate 已經過 RunnerCore 的 validateEvidenceCandidates（禁止 blob 欄位）
    // 這裡的 bytes 應該來自「外部 context」（例如 gateway response 的 metadata），不是 candidate 本體
    // 目前最小實作：假設 candidate 不含 bytes（符合 validator），bytes 由 stub/real gateway 負責
    const { item } = await attachEvidence({
      kind: candidate.kind,
      source: candidate.source,
      retrieved_at: candidate.retrieved_at,
      metadata: candidate.metadata || {},
      bytes: null, // 明確不從 candidate 取 bytes（已被 validator 禁止）
      limits,
      store
    });
    return item;
  };
}

// ===== Writeback Helper =====

/**
 * 寫回 TOOL ticket 的 outputs（含 tool_context + tool_verdict）
 */
function buildOutputsFromRunReport(runReport) {
  const tool_context = {
    evidence: runReport.evidence_summary?.items || []
  };
  
  const tool_verdict = mapRunReportStatusToVerdict(runReport.status);
  
  return {
    tool_context,
    tool_verdict
  };
}

// ===== Main Executor Logic =====

async function main() {
  const started_at = new Date().toISOString();
  const startTime = Date.now();
  
  // Parse args
  const args = process.argv.slice(2);
  let limit = 10;
  let leaseSec = 300;
  let owner = null;
  let useStubGateway = process.env.NO_MCP === 'true';
  let useRealMcp = process.env.RUN_REAL_MCP_TESTS === 'true';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--lease-sec' && i + 1 < args.length) {
      leaseSec = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--owner' && i + 1 < args.length) {
      owner = args[i + 1];
      i++;
    } else if (args[i] === '--no-mcp') {
      useStubGateway = true;
    } else if (args[i] === '--real-mcp') {
      useRealMcp = true;
    }
  }
  
  // Executor config
  const executor_config = {
    no_mcp: useStubGateway,
    real_mcp: useRealMcp,
    schema_gate_mode: process.env.SCHEMA_GATE_MODE || 'off',
    limit,
    lease_sec: leaseSec
  };
  
  const worker = owner || `tool_runner_b:${Date.now()}`;
  
  // Counters
  const counters = {
    total: 0,
    leased: 0,
    ok: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    lease_failed: 0,
    derive_failed: 0
  };
  
  const by_code = {};
  const samples = { ok: [], blocked: [], failed: [] };
  const stable_codes = new Set();
  
  // Evidence limits
  const limits = getEvidenceLimitsFromEnv();
  const evidenceStore = new EvidenceStore();
  
  // TicketStore
  const ticketStore = new TicketStore();

  // M2-A ↔ M2-B Integration: in-process ToolExecutionService (non-NO_MCP path)
  let toolExecutionService = null;
  if (!useStubGateway) {
    // Lazy-require ToolGateway and ToolExecutionService (only in non-stub mode)
    const ToolGateway = require('../tool_gateway/ToolGateway');
    const { ToolExecutionService } = require('../lib/tool_execution/ToolExecutionService');

    const toolGateway = new ToolGateway(console);
    // Initialize MCP connections if needed
    await toolGateway.initialize();

    toolExecutionService = new ToolExecutionService({
      toolGateway,
      logger: console,
      mode: useStubGateway ? 'NO_MCP' : 'NORMAL'
    });
  }
  
  let exitCodeCandidates = [];
  
  try {
    // 1) Lease tickets
    console.error(`[Executor] Leasing up to ${limit} TOOL tickets (lease_sec=${leaseSec}, owner=${worker})...`);
    const tickets = await ticketStore.lease('TOOL', limit, leaseSec, worker);
    counters.total = tickets.length;
    counters.leased = tickets.length;
    
    if (tickets.length === 0) {
      console.error('[Executor] No pending TOOL tickets found.');
      exitCodeCandidates.push(EXIT_CODE.OTHERWISE);
    }
    
    // 2) Process each ticket
    for (const ticket of tickets) {
      console.error(`[Executor] Processing ticket ${ticket.id}...`);

      const leaseProof = {
        lease_owner: worker,
        lease_token: ticket.metadata?.lease_token
      };

      let didFinalizeTicket = false;
      
      try {
        // Bridge tool_steps
        const normalizedTicket = bridgeToolSteps(ticket);

        // Create gateway (stub or in-process)
        let gateway;
        if (useStubGateway) {
          // Stub gateway: minimal fixture for testing
          gateway = createStubGateway({
            web_search: { ok: true, result: { items: [] }, evidenceCandidates: [] },
            memory: { ok: true, result: { entities: [] }, evidenceCandidates: [] },
            filesystem: { ok: true, result: { files: [] }, evidenceCandidates: [] }
          });
        } else {
          // M2-A↔M2-B integration: in-process adapter using ToolExecutionService
          gateway = new InProcessToolsGatewayAdapter(toolExecutionService, console);
        }

        // Evidence attach wrapper
        const attachEvidenceWrapper = createEvidenceAttachWrapper(limits, evidenceStore);

        // Deps snapshot
        // - NO_MCP mode: optimistic local stub deps (offline path)
        // - Normal mode: use ToolGateway.getDepStates() for real readiness
        let deps = {
          memory: { ready: true, code: null },
          web_search: { ready: true, code: null },
          filesystem: { ready: true, code: null }
        };

        if (!useStubGateway && toolExecutionService) {
          const depStates = toolExecutionService.toolGateway.getDepStates();
          const { evaluateReadiness } = require('../lib/readiness/evaluateReadiness');
          const snapshot = evaluateReadiness(depStates, new Date());
          const required = snapshot.required || {};

          deps = {
            memory: {
              ready: Boolean(required.memory?.ready),
              code: required.memory?.code ?? null
            },
            web_search: {
              ready: Boolean(required.web_search?.ready),
              code: required.web_search?.code ?? null
            },
            filesystem: {
              ready: Boolean(required.filesystem?.ready ?? true),
              code: required.filesystem?.code ?? null
            }
          };
        }

        // Run RunnerCore
        let runReport;
        try {
          const { depsForToolName } = require('../lib/readiness/ssot');
          runReport = await runCore(normalizedTicket, deps, {
            gateway,
            attachEvidence: attachEvidenceWrapper,
            budget: normalizedTicket.metadata?.tool_input?.budget || {},
            requiredDeps: (toolName) => depsForToolName(toolName)
          });
        } catch (err) {
          console.error(`[Executor] RunnerCore threw exception for ticket ${ticket.id}:`, err);
          // Treat as failed
          runReport = {
            status: RUN_STATUS.FAILED,
            code: RUN_CODES.TOOL_EXEC_FAILED,
            step_reports: [],
            evidence_summary: { items: [] }
          };
        }

        // Collect codes
        if (runReport.code) {
          stable_codes.add(runReport.code);
          by_code[runReport.code] = (by_code[runReport.code] || 0) + 1;
        }

        // Update counters
        if (runReport.status === RUN_STATUS.OK) {
          counters.ok++;
          exitCodeCandidates.push(EXIT_CODE.OTHERWISE);
          addSample(samples, 'ok', {
            ticket_id: ticket.id,
            code: runReport.code,
            duration_ms: runReport.duration_ms
          }, SAMPLE_LIMITS.ok);
        } else if (runReport.status === RUN_STATUS.BLOCKED) {
          counters.blocked++;
          exitCodeCandidates.push(EXIT_CODE.HAS_BLOCKED);
          addSample(samples, 'blocked', {
            ticket_id: ticket.id,
            code: runReport.code,
            reason: runReport.step_reports[0]?.result_summary || 'Unknown'
          }, SAMPLE_LIMITS.blocked);
        } else if (runReport.status === RUN_STATUS.FAILED) {
          counters.failed++;
          exitCodeCandidates.push(EXIT_CODE.HAS_FAILED);
          addSample(samples, 'failed', {
            ticket_id: ticket.id,
            code: runReport.code,
            reason: runReport.step_reports[0]?.result_summary || 'Unknown'
          }, SAMPLE_LIMITS.failed);
        }

        // 3) Writeback + 派生 hook
        const outputs = buildOutputsFromRunReport(runReport);

        if (runReport.status === RUN_STATUS.OK) {
          const completeResult = await ticketStore.complete(ticket.id, outputs, worker, leaseProof);
          if (completeResult && completeResult.ok === false) {
            counters.lease_failed++;
            stable_codes.add(EXECUTOR_CODES.LEASE_OWNER_MISMATCH);
          } else {
            didFinalizeTicket = true;
          }

          // M2-B2-2-v2: TOOL→REPLY 派生 hook - 唯一入口 (maybeDeriveReplyFromToolOnFill)
          // 派生失敗不得回滾 complete；只記錄 derive_failed 與 stable_codes。
          if (process.env.ENABLE_REPLY_DERIVATION === 'true') {
            console.error(`[Executor] Attempting TOOL→REPLY derivation for ticket ${ticket.id}...`);

            let updatedTicket;
            try {
              updatedTicket = await ticketStore.get(ticket.id);
            } catch (err) {
              console.error(`[Executor] Failed to fetch updated ticket ${ticket.id}:`, err);
              updatedTicket = ticket; // fallback
            }

            try {
              const deriveResult = await maybeDeriveReplyFromToolOnFill(
                updatedTicket,
                outputs,
                ticketStore,
                console // logger
              );

              if (deriveResult.attempted && deriveResult.created) {
                console.error(`[Executor] REPLY ticket ${deriveResult.reply_ticket_id} created from TOOL ${ticket.id}`);
              } else if (deriveResult.attempted) {
                console.error(`[Executor] REPLY derivation attempted but not created: ${deriveResult.reason}`);
              } else {
                console.error(`[Executor] REPLY derivation skipped: ${deriveResult.reason}`);
              }
            } catch (deriveErr) {
              counters.derive_failed++;
              stable_codes.add(EXECUTOR_CODES.DERIVE_FAILED);
              console.error(`[Executor] TOOL→REPLY derivation failed for ticket ${ticket.id}:`, deriveErr);
            }
          }
        } else if (runReport.status === RUN_STATUS.FAILED) {
          const failResult = await ticketStore.fail(ticket.id, runReport.code || 'UNKNOWN_ERROR', worker, leaseProof);
          if (failResult && failResult.ok === false) {
            counters.lease_failed++;
            stable_codes.add(EXECUTOR_CODES.LEASE_OWNER_MISMATCH);
          } else {
            didFinalizeTicket = true;
          }
        } else if (runReport.status === RUN_STATUS.BLOCKED) {
          await ticketStore.block(ticket.id, {
            code: runReport.code || 'UNKNOWN_BLOCKED',
            reason: runReport.step_reports[0]?.result_summary || 'Blocked by RunnerCore',
            source: 'tool_runner_b'
          });
          didFinalizeTicket = true;
        }
      } catch (ticketErr) {
        console.error(`[Executor] Ticket processing failed for ${ticket.id}:`, ticketErr);
        stable_codes.add(EXECUTOR_CODES.UNHANDLED_EXCEPTION);
        exitCodeCandidates.push(EXIT_CODE.FATAL);
      } finally {
        // 保底 release：如果沒成功 finalize（complete/fail/block），避免卡在 running 到 expires。
        if (!didFinalizeTicket) {
          try {
            const current = await ticketStore.get(ticket.id);
            const isRunning = current?.status === 'running' || current?.status === 'leased';
            if (isRunning) {
              const releaseResult = await ticketStore.release(ticket.id, leaseProof);
              if (releaseResult && releaseResult.ok === false) {
                counters.lease_failed++;
                stable_codes.add(EXECUTOR_CODES.LEASE_OWNER_MISMATCH);
              }
            }
          } catch (releaseErr) {
            // release failure should not crash executor
            counters.lease_failed++;
            stable_codes.add(EXECUTOR_CODES.RELEASE_FAILED);
            console.error(`[Executor] Release failed for ticket ${ticket.id}:`, releaseErr);
          }
        }
      }
    }
  } catch (fatalErr) {
    console.error('[Executor] Fatal error:', fatalErr);
    stable_codes.add(EXECUTOR_CODES.EXECUTOR_FATAL);
    exitCodeCandidates.push(EXIT_CODE.FATAL);
  }
  
  // 4) Build report
  const ended_at = new Date().toISOString();
  const duration_ms = Date.now() - startTime;
  const exitCode = getWorstExitCode(exitCodeCandidates);
  
  const report = createReport({
    version: REPORT_VERSION,
    started_at,
    ended_at,
    duration_ms,
    executor_config,
    worker,
    counters,
    by_code,
    samples,
    stable_codes: Array.from(stable_codes)
  });
  
  // Output JSON to stdout
  console.log(JSON.stringify(report, null, 2));
  
  // Exit with stable code
  process.exit(exitCode);
}

// Run
main().catch(err => {
  console.error('[Executor] Unhandled fatal error:', err);
  process.exit(EXIT_CODE.FATAL);
});
