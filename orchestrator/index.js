const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { v4: uuidv4 } = require('uuid');

const TicketStore = require('./store/TicketStore');
const ToolGateway = require('./tool_gateway/ToolGateway');
const mcpConfig = require('./mcp_config.json');

// --- [CONFIG] 日誌開關 ---
const ENABLE_AUDIT_LOGS = process.env.ENABLE_AUDIT_LOGS !== 'false';

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
    
    this.ticketStore = new TicketStore();
    this.toolGateway = new ToolGateway(logger, mcpConfig);
    this.filter = new TriageFilter();
    
    if (ENABLE_AUDIT_LOGS) {
      const logDir = path.resolve(process.cwd(), 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    }
  }

  async start() {
    await this.toolGateway.initialize();

    this.app.use(cors());
    this.app.use(bodyParser.json({ limit: '10mb' }));

    this.setupRoutes();

    this.app.listen(this.port, () => {
      logger.info(`Orchestrator running at http://localhost:${this.port}`);
      logger.info(`Mode: Sync-Strategic | Triage Filter: Enabled | Audit: ${ENABLE_AUDIT_LOGS}`);
    });
  }

  writeAuditLog(filename, data) {
    if (!ENABLE_AUDIT_LOGS) return;
    const filepath = path.resolve(process.cwd(), 'logs', filename);
    const entry = JSON.stringify({ at: new Date().toISOString(), ...data });
    
    fs.appendFile(filepath, entry + '\n', (err) => {
      if (err) logger.error(`Failed to write log ${filename}`, err.message);
    });
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

      await this.ticketStore.create(ticket);
      logger.info(`[Ingest] Ticket created: ${ticketId}`);
      return { status: 'queued', ticket_id: ticketId };
    };

    this.app.post('/events', async (req, res) => {
      try {
        const result = await ingestEvent(req.body);
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

    this.app.post('/v1/tickets/:id/fill', async (req, res) => {
      const { id } = req.params;
      const { outputs, by } = req.body;

      try {
        const ticket = await this.ticketStore.get(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        await this.ticketStore.complete(id, outputs, by);
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
            const allTickets = await this.ticketStore.list({ limit: 10000 });
            
            // 基礎統計
            const total = allTickets.length;
            const pending = allTickets.filter(t => t.status === 'pending').length;
            const completed = allTickets.filter(t => t.status === 'completed').length;
            const failed = allTickets.filter(t => t.status === 'failed').length;
            const success_rate = total > 0 ? (completed / total) : 0;

            // Reply 專項統計 (識別 Reply 票)
            const replyTickets = allTickets.filter(t => 
                (t.flow_id && t.flow_id.includes('reply')) || 
                (t.metadata && t.metadata.kind === 'REPLY')
            );
            const replies_indexed = replyTickets.length;
            const replies_pending = replyTickets.filter(t => t.status === 'pending').length;
            const replies_done = replyTickets.filter(t => t.status === 'completed').length;

            res.json({
                tickets: {
                    total,
                    pending,
                    completed,
                    failed,
                    success_rate: Number(success_rate.toFixed(2))
                },
                replies: {
                    indexed: replies_indexed,
                    pending: replies_pending,
                    done: replies_done
                },
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    this.app.post('/v1/tools/execute', async (req, res) => {
      try {
        const { server, tool, arguments: args } = req.body;
        const result = await this.toolGateway.executeTool(server, tool, args || {});
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/health', (req, res) => res.json({ status: 'ok', version: 'v3-final' }));
    
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