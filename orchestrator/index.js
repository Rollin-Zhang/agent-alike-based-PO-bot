const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { v4: uuidv4 } = require('uuid');

const TicketStore = require('./store/TicketStore');
const ToolGateway = require('./tool_gateway/ToolGateway');
const { resolveRuntimeEnv } = require('./shared/constants');
const deriveToolTicketFromTriage = require('./lib/deriveToolTicketFromTriage');
const { maybeDeriveReplyFromToolOnFill } = require('./lib/maybeDeriveReplyFromToolOnFill');
const schemaGate = require('./lib/schemaGate');

// --- M2-C.1 Cutover observability ---
const { createCutoverPolicy } = require('./lib/compat/CutoverPolicy');
const { cutoverMetrics } = require('./lib/compat/cutoverMetrics');

// --- M2-A.1 Readiness Imports ---
const { evaluateReadiness } = require('./lib/readiness/evaluateReadiness');
const { requireDeps } = require('./lib/readiness/requireDeps');
const { readinessMetrics } = require('./lib/readiness/readinessMetrics');
const { formatStrictInitFailOutput, depsForToolName } = require('./lib/readiness/ssot');

// --- [CONFIG] NO_MCP Boot Mode ---
// When NO_MCP=true, server runs without MCP connections (test mode)
const NO_MCP = process.env.NO_MCP === 'true';

// Allow overriding MCP config path for Real MCP (Phase B) runs
const MCP_CONFIG_PATH = process.env.MCP_CONFIG_PATH;
const mcpConfig = NO_MCP
  ? { mcp_servers: {}, tool_whitelist: [] }
  : (() => {
      try {
        const configPath = MCP_CONFIG_PATH
          ? path.resolve(MCP_CONFIG_PATH)
          : path.resolve(__dirname, 'mcp_config.json');

        if (!fs.existsSync(configPath)) {
          console.error('[FATAL] MCP config not found:', configPath);
          process.exit(1);
        }

        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (err) {
        console.error('[FATAL] Failed to load MCP config:', err.message);
        process.exit(1);
      }
    })();

// --- [CONFIG] 日誌開關 ---
const ENABLE_AUDIT_LOGS = process.env.ENABLE_AUDIT_LOGS !== 'false';

// --- [CONFIG] MCP Path Resolution Helper ---
/**
 * Resolve MCP server entrypoint paths relative to repo root.
 * This ensures spawning works regardless of process.cwd().
 */
function resolveMCPPaths(config) {
  // Skip path resolution in NO_MCP mode
  if (NO_MCP) {
    return config;
  }
  // Repo root is one level up from orchestrator/
  const repoRoot = path.resolve(__dirname, '..');
  const servers = config.mcp_servers || {};

  for (const [serverName, serverConfig] of Object.entries(servers)) {
    // Only process node stdio servers with relative paths
    if (serverConfig.command === 'node' && 
        serverConfig.args && 
        serverConfig.args.length > 0) {
      
      const entrypoint = serverConfig.args[0];
      
      // Target web_search specifically for this commit
      if (serverName === 'web_search' && 
          !path.isAbsolute(entrypoint)) {
        
        const resolvedPath = path.resolve(repoRoot, entrypoint);
        const exists = fs.existsSync(resolvedPath);
        
        console.log(`[mcp] resolve ${serverName} entrypoint path=${resolvedPath} exists=${exists}`);
        
        // Fail-fast if path doesn't exist
        if (!exists) {
          throw new Error(`MCP ${serverName} entrypoint not found: ${resolvedPath}`);
        }
        
        // Update args with resolved absolute path
        serverConfig.args[0] = resolvedPath;
      }
    }
  }
  
  return config;
}

// --- 1. 輕量級 Logger ---
const logger = {
  info: (msg, meta) => console.log(`[INFO] ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : '')
};

// --- 2. 流量過濾器 (TriageFilter) ---
class TriageFilter {
  constructor() {
    this.rules = this.loadRules();
  }

  loadRules() {
    try {
      const p = path.resolve(process.cwd(), 'rules/triage.yaml');
      if (fs.existsSync(p)) {
        const doc = yaml.load(fs.readFileSync(p, 'utf8'));
        logger.info(`Loaded triage rules from ${p}`);
        return doc || {};
      }
    } catch (e) {
      logger.warn('Failed to load triage rules, using defaults', e.message);
    }
    return {
      gate0: { enabled: true, min_len: 10 },
      gate0b: { enabled: true, min_likes: 10, min_comments: 5 }
    };
  }

  check(event) {
    const content = event.content || (event.context_digest?.target_snippet) || '';
    const features = event.features || {};
    const engagement = features.engagement || {};

    const g0 = this.rules.gate0;
    if (g0 && g0.enabled) {
      const minLen = g0.min_len || 0;
      if (content.length < minLen) {
        return { pass: false, reason: `Too short (${content.length} < ${minLen})` };
      }
    }

    const g0b = this.rules.gate0b;
    if (g0b && g0b.enabled) {
      const likes = Number(engagement.likes || 0);
      const comments = Number(engagement.comments || 0);
      
      if (likes < (g0b.min_likes || 0)) {
        return { pass: false, reason: `Low likes (${likes} < ${g0b.min_likes})` };
      }
      if (comments < (g0b.min_comments || 0)) {
        return { pass: false, reason: `Low comments (${comments} < ${g0b.min_comments})` };
      }
    }

    return { pass: true };
  }
}

// --- 3. Orchestrator 主程式 ---
class Orchestrator {
  constructor() {
    this.app = express();
    this.port = process.env.ORCHESTRATOR_PORT || 3000;
    
    // Support custom TicketStore path for testing
    const storePath = process.env.TICKETSTORE_PATH || null;
    this.ticketStore = new TicketStore(storePath);

    // Setup TicketStore audit logger (guardrail rejects)
    if (typeof TicketStore.setAuditLogger === 'function') {
      TicketStore.setAuditLogger((entry) => {
        this.writeAuditLog('ticket_store.jsonl', entry);
      });
    }
    // Resolve MCP paths before initializing ToolGateway
    const resolvedConfig = resolveMCPPaths(mcpConfig);
    this.toolGateway = new ToolGateway(logger, resolvedConfig);
    this.filter = new TriageFilter();
    
    if (ENABLE_AUDIT_LOGS) {
      const logDir = path.resolve(process.cwd(), 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Setup schemaGate audit logger
    schemaGate.setAuditLogger((entry) => {
      this.writeAuditLog('schema_gate.jsonl', entry);
    });
  }

  async start() {
    // Only initialize ToolGateway in normal mode
    if (!NO_MCP) {
      await this.toolGateway.initialize();
    }

    // --- M2-A.1 STRICT_MCP_INIT Check ---
    const STRICT_MCP_INIT = process.env.STRICT_MCP_INIT === 'true';
    if (STRICT_MCP_INIT) {
      // Get readiness snapshot immediately after init
      const depStates = this.toolGateway.getDepStates();
      const snapshot = evaluateReadiness(depStates, new Date());

      // Check if any required deps are not ready
      const requiredNotReady = Object.entries(snapshot.required).filter(([_, dep]) => !dep.ready);
      
      if (requiredNotReady.length > 0) {
        // Output last snapshot to stderr with fixed prefix
        const output = formatStrictInitFailOutput(snapshot);
        console.error(output);
        
        // Exit with code 1
        process.exit(1);
      }
    }

    // --- Phase D: Startup Probes (Defense-in-Depth) ---
    const STRICT_PROBES = process.env.STRICT_PROBES !== 'false'; // Default true in production
    const skipProbes = NO_MCP && !STRICT_PROBES; // Bypass only if NO_MCP + not strict

    if (!skipProbes) {
      const probeResult = await this.runStartupProbes();
      
      // Fail-fast if probes failed (unless bypass allowed)
      if (!probeResult.all_passed) {
        logger.error('[Startup Probes] One or more probes failed. Orchestrator will not start.');
        logger.error(`[Startup Probes] Report written to: ${probeResult.report_path}`);
        process.exit(1);
      }
      
      logger.info('[Startup Probes] All probes passed ✓');
      logger.info(`[Startup Probes] Report: ${probeResult.report_path}`);
    } else {
      // NO_MCP bypass: still write report but allow startup
      const probeResult = await this.runStartupProbes({ bypass: true });
      logger.warn('[Startup Probes] Bypassed (NO_MCP mode, STRICT_PROBES=false)');
      logger.warn(`[Startup Probes] Traceable report: ${probeResult.report_path}`);
    }

    this.app.use(cors());
    this.app.use(bodyParser.json({ limit: '10mb' }));

    this.setupRoutes();

    this.app.listen(this.port, () => {
      logger.info(`Orchestrator running at http://localhost:${this.port}`);
      logger.info(`Mode: ${NO_MCP ? 'NO_MCP (Test)' : 'Sync-Strategic'} | Triage Filter: Enabled | Audit: ${ENABLE_AUDIT_LOGS}`);
      
      // [Commit 1] Log resolved environment variables (planned architecture keys)
      const runtimeEnv = resolveRuntimeEnv();
      logger.info('[Environment] Resolved configuration for planned architecture keys:', {
        enableToolDerivation: runtimeEnv.enableToolDerivation,
        toolOnlyMode: runtimeEnv.toolOnlyMode,
        orchRoot: runtimeEnv.orchRoot,
        memoryFilePath: runtimeEnv.memoryFilePath,
        enableTicketSchemaValidation: runtimeEnv.enableTicketSchemaValidation,
        note: 'Using defaults where env vars not set'
      });
    });
  }

  writeAuditLog(filename, data) {
    if (!ENABLE_AUDIT_LOGS) return;
    const filepath = path.resolve(process.cwd(), 'logs', filename);
    const entry = filename === 'schema_gate.jsonl'
      ? JSON.stringify(data)
      : JSON.stringify({ at: new Date().toISOString(), ...data });
    
    fs.appendFile(filepath, entry + '\n', (err) => {
      if (err) logger.error(`Failed to write log ${filename}`, err.message);
    });
  }

  /**
   * Phase D: Run startup probes (defense-in-depth)
   * 
   * @param {Object} options
   * @param {boolean} [options.bypass] - If true, run probes but don't fail-fast (NO_MCP bypass mode)
   * @returns {Promise<Object>} { all_passed, report_path, report }
   */
  async runStartupProbes(options = {}) {
    const { bypass = false } = options;
    const { ProbeRunner, createProviderFromEnv } = require('./probes/ProbeRunner');
    const { probeResultToStepReport, createAttemptEvent } = require('./probes/probeStepReportBuilder');
    const { writeStartupProbeReport, writeDepSnapshot, createDepSnapshot } = require('./probes/writeProbeArtifacts');
    const { PROBE_ATTEMPT_CODES } = require('./probes/ssot');

    // Read environment
    const forceFailName = process.env.PROBE_FORCE_FAIL || null;
    const forceInvalidShape = process.env.PROBE_FORCE_INVALID_SHAPE || null;

    // Create provider
    const provider = createProviderFromEnv({ 
      noMcp: NO_MCP, 
      configPath: MCP_CONFIG_PATH,
      realMcpTests: false // Startup probes don't require RUN_REAL_MCP_TESTS
    });
    await provider.initialize();

    // Get dep states for snapshot
    const depStates = this.toolGateway.getDepStates();
    const now = new Date();
    const as_of = now.toISOString();
    const run_id = `startup_${Date.now()}`; // Simple timestamp-based ID (deterministic for same second)

    // Create dep snapshot
    const depSnapshot = createDepSnapshot({
      depStates,
      snapshot_id: run_id,
      as_of,
      probe_context: 'startup_probes'
    });

    // Write dep snapshot
    const depSnapshotPath = writeDepSnapshot(depSnapshot, { run_id });

    // Run probes (Phase D: pass forceInvalidShapeName to runner)
    const runner = new ProbeRunner({ 
      forceFailName,
      forceInvalidShapeName: forceInvalidShape
    });
    const { results, allPassed } = await runner.runAll({ provider });

    // Cleanup provider
    await provider.cleanup();

    // Convert ProbeResults to StepReports
    const step_reports = results.map((probeResult, index) => {
      const started_at = as_of; // Simplified: all probes started at same time
      const ended_at = as_of; // Simplified: ended_at same as started_at (duration in duration_ms)
      const duration_ms = 0; // Simplified: no per-probe duration tracking in this version

      const attempt_events = bypass
        ? [createAttemptEvent({
            as_of,
            status: 'ok',
            code: PROBE_ATTEMPT_CODES.PROBE_SKIPPED_NO_MCP,
            duration_ms: 0,
            note: 'NO_MCP bypass (STRICT_PROBES=false)'
          })]
        : [];

      const dep_snapshot_ref = depSnapshot.missing_dep_codes.length > 0 ? {
        path: depSnapshotPath,
        snapshot_id: depSnapshot.snapshot_id,
        missing_dep_codes: depSnapshot.missing_dep_codes
      } : null;

      return probeResultToStepReport({
        probeResult,
        step_index: index + 1,
        started_at,
        ended_at,
        duration_ms,
        dep_snapshot_ref,
        attempt_events
      });
    });

    // Build startup probe report
    const report = {
      version: 'v1',
      mode: bypass ? 'no_mcp_bypass' : 'strict',
      report_id: run_id,
      as_of,
      all_passed: allPassed,
      exit_code: allPassed ? 0 : 1,
      provider: provider.name,
      provider_selected_reason: NO_MCP ? 'NO_MCP' : 'FALLBACK_NO_CONFIG',
      strict_probes: !bypass,
      no_mcp: NO_MCP,
      force_fail_name: forceFailName,
      force_invalid_shape: forceInvalidShape,
      step_reports,
      dep_snapshot_ref: depSnapshot.missing_dep_codes.length > 0 ? {
        path: depSnapshotPath,
        snapshot_id: depSnapshot.snapshot_id,
        missing_dep_codes: depSnapshot.missing_dep_codes
      } : null,
      evidence: [],
      evidence_truncated: false,
      evidence_dropped_count: 0
    };

    // Write startup probe report
    const reportPath = writeStartupProbeReport(report, { run_id });

    return {
      all_passed: allPassed,
      report_path: reportPath,
      report
    };
  }

  setupRoutes() {
    // ---------------------------------------------------------
    // 資料攝入 (Ingest) - 確保 kind: 'TRIAGE'
    // ---------------------------------------------------------
    const ingestEvent = async (eventData) => {
      const check = this.filter.check(eventData);
      if (!check.pass) {
        logger.info(`[Filter] Skipped: ${check.reason}`);
        return { status: 'skipped', reason: check.reason };
      }

      const ticketId = uuidv4();
      const ticket = {
        id: ticketId,
        ticket_id: ticketId,
        type: 'DraftTicket',
        status: 'pending',
        flow_id: 'triage_zh_hant_v1',
        event: eventData,
        metadata: {
          created_at: new Date().toISOString(),
          mode: 'auto-ingest',
          candidate_id: eventData.event_id || eventData.candidate_id,
          // [關鍵交互點 1] 必須標記為 TRIAGE，Worker 才領得到
          kind: 'TRIAGE'
        }
      };

      // --- SchemaGate: validate before create (boundary: ticket_create, direction: ingress) ---
      const gateResult = schemaGate.gateIngress(ticket, {
        boundary: schemaGate.BOUNDARY.TICKET_CREATE,
        kind: schemaGate.KIND.TRIAGE,
        ticketId: ticketId
      });
      
      if (!gateResult.ok) {
        // Strict mode rejection
        return { 
          status: 'rejected', 
          error_code: gateResult.code,
          schema_warn_count: gateResult.result.warnCount
        };
      }
      
      await this.ticketStore.create(ticket);
      logger.info(`[Ingest] Ticket created: ${ticketId}`);
      return { status: 'queued', ticket_id: ticketId };
    };

    this.app.post('/events', async (req, res) => {
      try {
        const result = await ingestEvent(req.body);
        // Set schema warn header if enabled (never modifies body)
        if (result.schema_warn_count !== undefined) {
          schemaGate.setWarnHeader(res, result.schema_warn_count);
        }
        if (result.status === 'rejected') {
          return res.status(400).json(result);
        }
        res.json(result);
      } catch (e) {
        logger.error('Event ingestion failed', e);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/v1/triage/batch', async (req, res) => {
      try {
        const { candidates } = req.body;
        const results = [];
        if (Array.isArray(candidates)) {
          for (const c of candidates) {
            const eventData = {
              type: 'triage_candidate',
              event_id: `batch-${c.candidate_id || uuidv4()}`,
              content: c.snippet || c.context_digest?.target_snippet || '',
              features: c.features,
              ...c
            };
            results.push(await ingestEvent(eventData));
          }
        }
        res.json({ results });
      } catch (e) {
        logger.error('Batch ingestion failed', e);
        res.status(500).json({ error: e.message });
      }
    });

    // ---------------------------------------------------------
    // 票據流轉 (Ticket Lifecycle) - 支援 V1
    // ---------------------------------------------------------
    this.app.post('/v1/tickets/lease', async (req, res) => {
      try {
        const { kind, limit, lease_sec } = req.body;
        // 延長租約至 300s 以容納 MCP
        const tickets = await this.ticketStore.lease(kind, limit || 1, lease_sec || 300);
        res.json({ tickets });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/v1/tickets/:id', async (req, res) => {
      const { id } = req.params;
      try {
        const ticket = await this.ticketStore.get(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        
        // Return ticket with all metadata, using compat helper for derived field
        res.json({
          id: ticket.id,
          ticket_id: ticket.ticket_id,
          status: ticket.status,
          type: ticket.type,
          flow_id: ticket.flow_id,
          metadata: ticket.metadata,
          payload: ticket.payload,
          outputs: ticket.outputs,
          event: ticket.event,
          derived: ticket.derived || null,
          created_at: ticket.created_at,
          completed_at: ticket.completed_at
        });
      } catch (e) {
        logger.error('Failed to get ticket', e);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/v1/tickets/:id/fill', async (req, res) => {
      const { id } = req.params;
      const { outputs, by, lease_owner, lease_token } = req.body;
      let schemaWarnCount = 0;

      try {
        const ticket = await this.ticketStore.get(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        // --- TRIAGE→TOOL Derivation (Block A) ---
        await deriveToolTicketFromTriage(ticket, outputs, this.ticketStore);

        // --- TOOL→REPLY Derivation (Block B) ---
        await maybeDeriveReplyFromToolOnFill(ticket, outputs, this.ticketStore, logger);

        // --- SchemaGate: validate completed ticket before persist (boundary: ticket_complete) ---
        const completedTicketPreview = {
          ...ticket,
          status: 'done',
          metadata: { ...ticket.metadata, final_outputs: outputs }
        };
        const gateResult = schemaGate.gateIngress(completedTicketPreview, {
          boundary: schemaGate.BOUNDARY.TICKET_COMPLETE,
          kind: ticket.metadata?.kind || schemaGate.KIND.UNKNOWN,
          ticketId: id
        });
        schemaWarnCount = gateResult.result.warnCount;
        
        if (!gateResult.ok) {
          // Strict mode rejection
          schemaGate.setWarnHeader(res, schemaWarnCount);
          return res.status(gateResult.httpStatus).json({
            status: 'rejected',
            error_code: gateResult.code,
            schema_warn_count: schemaWarnCount
          });
        }

        const completeResult = await this.ticketStore.complete(id, outputs, by, { lease_owner, lease_token });
        if (completeResult && completeResult.ok === false) {
          schemaGate.setWarnHeader(res, schemaWarnCount);
          return res.status(409).json({
            status: 'rejected',
            error_code: completeResult.code
          });
        }
        
        // Set warn header before response (never modifies body)
        schemaGate.setWarnHeader(res, schemaWarnCount);
        res.json({ status: 'ok' });

        // Audit Logging
        if (ticket.flow_id.includes('triage')) {
            this.writeAuditLog('triage_decisions.jsonl', {
                ticket_id: id,
                candidate_id: ticket.metadata.candidate_id,
                decision: outputs.decision,
                reason: outputs.short_reason || outputs.reasons,
                strategy: outputs.reply_strategy,
                info_needs: outputs.information_needs,
                full_output: outputs
            });
        } else if (ticket.flow_id.includes('reply')) {
            this.writeAuditLog('reply_results.jsonl', {
                ticket_id: id,
                candidate_id: ticket.metadata.candidate_id,
                triage_ticket_id: ticket.metadata.triage_reference_id,
                reply: outputs.reply,
                confidence: outputs.confidence,
                used_strategy: outputs.used_strategy,
            by: by
            });
        }

        // Trigger Automation Logic
        this.handlePostFillAutomation(ticket, outputs).catch(err => {
          logger.error(`Automation error for ticket ${id}`, err);
        });

      } catch (e) {
        logger.error(`Fill failed`, e);
        if (!res.headersSent) res.status(500).json({ error: e.message });
      }
    });

    // ---------------------------------------------------------
    // 監控與工具 (Metrics & Tools)
    // ---------------------------------------------------------
    
    // [NEW] 戰情儀表板 - 專門為了回應您的 curl 監控需求
    this.app.get('/metrics', async (req, res) => {
        try {
        const counts = await this.ticketStore.countByStatus();
        const total = Object.values(counts).reduce((acc, v) => acc + (typeof v === 'number' ? v : 0), 0);

        const pending = counts.pending || 0;
        const running = counts.running || 0;
        const done = counts.done || 0;
        const failed = counts.failed || 0;
        const blocked = counts.blocked || 0;

        // Success rate aligned to Stage 2 terminal outcomes
        const terminal = done + failed + blocked;
        const success_rate = terminal > 0 ? (done / terminal) : 0;

        // Reply 專項統計 (識別 Reply 票)
        const allTickets = await this.ticketStore.list({ limit: 10000 });
        const replyTickets = allTickets.filter(t =>
          (t.flow_id && t.flow_id.includes('reply')) ||
          (t.metadata && t.metadata.kind === 'REPLY')
        );
        const replies_indexed = replyTickets.length;
        const replies_pending = replyTickets.filter(t => t.status === 'pending').length;
        const replies_running = replyTickets.filter(t => t.status === 'running').length;
        const replies_done = replyTickets.filter(t => t.status === 'done' || t.status === 'completed').length;
        const replies_failed = replyTickets.filter(t => t.status === 'failed').length;
        const replies_blocked = replyTickets.filter(t => t.status === 'blocked').length;

        // --- M2-A.1 Readiness Metrics ---
        const depStates = this.toolGateway.getDepStates();
        const readinessSnapshot = evaluateReadiness(depStates, new Date());
        const readiness = readinessMetrics.getMetricsSnapshot(readinessSnapshot);

        // --- M2-C.1 Cutover ---
        const policy = createCutoverPolicy();
        const cutover = {
          cutover_until_ms: policy.cutover_until_ms,
          env_source: policy.env_source,
          mode: policy.mode(Date.now()),
          metrics: cutoverMetrics.snapshot()
        };

            res.json({
                tickets: {
                    total,
                    pending,
                running,
                done,
                    failed,
                blocked,
                    success_rate: Number(success_rate.toFixed(2))
                },
                replies: {
                    indexed: replies_indexed,
                    pending: replies_pending,
                running: replies_running,
                done: replies_done,
                failed: replies_failed,
                blocked: replies_blocked
                },
                schema_gate: schemaGate.getMetrics(),
                ticket_store: this.ticketStore.getGuardMetrics(),
                readiness: readiness,  // M2-A.1: Add readiness block
                cutover,
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- M2-A.1: Apply requireDeps middleware to /v1/tools/execute ---
    // 必修保護：gating deps 透過 depsForToolName(toolName) 插槽，避免未來 filesystem 工具需求漂移。
    const getDepStatesFn = () => this.toolGateway.getDepStates();
    const toolsExecuteGating = (req, res, next) => {
      const toolName = req?.body?.tool;

      // Guardrail (小洞 A): missing/invalid toolName must be rejected upstream.
      // Do not let depsForToolName decide this case (prevents bypass via "no tool").
      if (typeof toolName !== 'string' || toolName.trim() === '') {
        return res.status(400).json({ error: 'missing_tool' });
      }

      const depKeys = depsForToolName(toolName);
      return requireDeps(depKeys, getDepStatesFn)(req, res, next);
    };

    this.app.post('/v1/tools/execute',
      toolsExecuteGating,
      async (req, res) => {
        try {
          const { server, tool, arguments: args } = req.body;
          const result = await this.toolGateway.executeTool(server, tool, args || {});
          res.json(result);
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      }
    );

    // --- M2-A.1: Replace /health with readiness snapshot ---
    this.app.get('/health', (req, res) => {
      try {
        const depStates = this.toolGateway.getDepStates();
        const snapshot = evaluateReadiness(depStates, new Date());
        res.status(200).json(snapshot);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
    
    // Alias for legacy listing
    this.app.get('/tickets', async (req, res) => {
      const { status, limit } = req.query;
      const tickets = await this.ticketStore.list({ status, limit: Number(limit) || 20 });
      res.json(tickets);
    });
    this.app.get('/v1/tickets', async (req, res) => {
      const { status, limit } = req.query;
      const tickets = await this.ticketStore.list({ status, limit: Number(limit) || 20 });
      res.json(tickets);
    });
  }

  // --- 自動化中樞 (Automation Hub) ---
  async handlePostFillAutomation(triageTicket, outputs) {
    const isTriage = triageTicket.flow_id.includes('triage') || triageTicket.event.type === 'triage_candidate';
    const isApproved = outputs.decision === 'APPROVE';

    if (!isTriage || !isApproved) return;

    logger.info(`[Auto] Promoting Ticket ${triageTicket.id} to Reply Phase`);

    const infoNeeds = outputs.information_needs || [];
    let fetchedContext = "";

    if (infoNeeds.length > 0) {
      logger.info(`[Auto] Fetching ${infoNeeds.length} items from NotebookLM...`);
      
      const promises = infoNeeds.map(async (item) => {
        try {
          const result = await this.toolGateway.executeTool('notebooklm', 'ask_question', { 
            question: item.question 
          });
          
          let text = '';
          if (result?.content && Array.isArray(result.content)) {
             text = result.content.map(c => c.text).join('\n');
          } else if (typeof result === 'string') {
             text = result;
          }
          return `【問：${item.question}】\n(目的：${item.purpose})\n答：${text}`;
        } catch (e) {
          logger.warn(`Context fetch failed: ${item.question}`, e.message);
          return `【問：${item.question}】\n(查詢失敗：${e.message})`;
        }
      });

      const results = await Promise.all(promises);
      fetchedContext = results.join('\n\n');
      logger.info(`[Auto] Context fetching complete.`);
    }

    const replyTicketId = uuidv4();
    const replyTicket = {
      id: replyTicketId,
      ticket_id: replyTicketId,
      type: 'DraftTicket',
      status: 'pending',
      flow_id: 'reply_zh_hant_v1',
      event: triageTicket.event,
      metadata: {
        created_at: new Date().toISOString(),
        triage_reference_id: triageTicket.id,
        candidate_id: triageTicket.metadata.candidate_id,
        prompt_id: outputs.target_prompt_id || 'reply.standard',
        // [關鍵交互點 2] 必須標記為 REPLY，Worker 才領得到 Reply 任務
        kind: 'REPLY',
        reply_input: {
          strategy: outputs.reply_strategy,
          context_notes: fetchedContext
        }
      }
    };

    await this.ticketStore.create(replyTicket);
    logger.info(`[Auto] Created Reply Ticket ${replyTicketId} [${replyTicket.metadata.prompt_id}]`);
  }
}

if (require.main === module) {
  const orchestrator = new Orchestrator();
  orchestrator.start().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
  });
}

module.exports = Orchestrator;
