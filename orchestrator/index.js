const express = require('express');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const Joi = require('joi');
const TicketStore = require('./store/TicketStore');
const DAGExecutor = require('./dag_executor/DAGExecutor');
const AuditLogger = require('./audit/AuditLogger');
const FlowRegistry = require('./flows/FlowRegistry');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const readline = require('readline');

// [ADD] snapshot/tail constants
// 載入環境變數
require('dotenv').config();

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const TRIAGE_SNAPSHOT = process.env.TRIAGE_SNAPSHOT || path.join(LOG_DIR, 'triage_decisions.jsonl');
const REPLY_SNAPSHOT = process.env.REPLY_SNAPSHOT || path.join(LOG_DIR, 'reply_results.jsonl');
const WATERMARK_PATH = process.env.SNAPSHOT_WATERMARK || path.join(LOG_DIR, 'reply_watermark.json');

const REINDEX_ON_BOOT = (process.env.ORCH_REINDEX_ON_BOOT ?? 'true') !== 'false';
const TAIL_SNAPSHOTS = (process.env.ORCH_TAIL_SNAPSHOTS ?? 'true') !== 'false';

// 事件 Schema 驗證
const eventSchema = Joi.object({
  type: Joi.string().required(),
  event_id: Joi.string().required(),
  thread_id: Joi.string().required(),
  content: Joi.string().required(),
  actor: Joi.string().required(),
  timestamp: Joi.string().isoDate().required()
});

class Orchestrator {
  constructor() {
    this.app = express();
    this.port = process.env.ORCHESTRATOR_PORT || 3000;
    this.dryRun = process.env.DRY_RUN === 'true';
    
    // 初始化組件
    this.ticketStore = new TicketStore();
    this.auditLogger = new AuditLogger();
    this.flowRegistry = new FlowRegistry();
    this.dagExecutor = new DAGExecutor(this.auditLogger);
    
    // Event ID 去重追蹤
    this.processedEvents = new Set();

    // TRIAGE 索引（candidate_id → { ticket_id, state, result? }）
    this.triageIndex = new Map();
    this.triageDefaults = this.loadTriageRules();

    // REPLY 索引（candidate_id → { reply_ticket_id, state, reply_result? }）
    this.replyIndex = new Map();
    this.replyDefaults = this.loadReplyRules();
  this._logsDir = path.resolve(process.cwd(), 'logs');
  try { if (!fs.existsSync(this._logsDir)) fs.mkdirSync(this._logsDir, { recursive: true }); } catch(_) {}
  this._snapshotsWritten = 0;
  this._replySnapshotsWritten = 0;
  this._lastBatchSource = null;
  this._lastReplyDeriveSource = null;
  // 二級索引：以 seed.value 去重
  this._seedIndex = new Map(); // key: seed.value, val: candidate_id
    
    // 設定 logger
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/orchestrator.log' })
      ]
    });
    
    this.setupRoutes();
    this.setupErrorHandling();

    // 週期性釋放過期租約（最小可用版本）
    this._leaseReaper = setInterval(async () => {
      try {
        const released = await this.ticketStore.releaseExpiredLeases();
        if (released > 0) {
          this.logger.info('Released expired leases', { released });
        }
      } catch (e) {
        this.logger.warn('Lease reaper error', { error: e.message });
      }
    }, 5000);
  }

  loadTriageRules() {
    try {
      const rulesPath = path.resolve(process.cwd(), 'rules/triage.yaml');
      if (fs.existsSync(rulesPath)) {
        const doc = yaml.load(fs.readFileSync(rulesPath, 'utf8')) || {};
        if (this.logger && typeof this.logger.info === 'function') {
          this.logger.info('Loaded triage rules', { rules_path: rulesPath });
        } else {
          console.log('[orchestrator] Loaded triage rules', { rules_path: rulesPath });
        }
        // 建立預設並允許環境變數覆蓋 Gate-0B 門檻
        const gate0 = doc.gate0 || { enabled: true, min_len: 10 };
        const gate0bFromDoc = doc.gate0b || { enabled: false, min_len: 20, min_likes: 50, min_comments: 20 };
        const gate0b = { ...gate0bFromDoc };
        if (process.env.GATE0B_ENABLED != null) gate0b.enabled = String(process.env.GATE0B_ENABLED).toLowerCase() === 'true';
        if (process.env.GATE0B_MIN_LEN != null) gate0b.min_len = parseInt(process.env.GATE0B_MIN_LEN, 10);
        if (process.env.GATE0B_MIN_LIKES != null) gate0b.min_likes = parseInt(process.env.GATE0B_MIN_LIKES, 10);
        if (process.env.GATE0B_MIN_COMMENTS != null) gate0b.min_comments = parseInt(process.env.GATE0B_MIN_COMMENTS, 10);
        return {
          gate0,
          gate0b,
          prompt_id: doc.prompt_id || 'triage.zh-Hant@v1'
        };
      }
    } catch (e) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn('Failed to load triage rules, using defaults', { error: e.message });
      } else {
        console.warn('[orchestrator] Failed to load triage rules, using defaults', e.message);
      }
    }
    return {
      gate0: { enabled: true, min_len: 10, max_recency_minutes: 1440, engagement_min: { likes: 0, comments: 0 } },
      gate0b: { enabled: true, min_len: 20, min_likes: 100, min_comments: 30 },
      prompt_id: 'triage.zh-Hant@v1'
    };
  }

  loadReplyRules() {
    try {
      const rulesPath = path.resolve(process.cwd(), 'rules/reply.yaml');
      if (fs.existsSync(rulesPath)) {
        const doc = yaml.load(fs.readFileSync(rulesPath, 'utf8')) || {};
        if (this.logger && typeof this.logger.info === 'function') {
          this.logger.info('Loaded reply rules', { rules_path: rulesPath });
        } else {
          console.log('[orchestrator] Loaded reply rules', { rules_path: rulesPath });
        }
        return {
          prompt_id: doc.prompt_id || 'reply.zh-Hant@v1',
          brand_voice: doc?.vars?.find?.(v => v.name === 'brand_voice')?.default || '溫暖、專業、以公民教育為主',
          constraints: doc.constraints || { max_chars: 350, language: 'zh-Hant' }
        };
      }
    } catch (e) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn('Failed to load reply rules, using defaults', { error: e.message });
      } else {
        console.warn('[orchestrator] Failed to load reply rules, using defaults', e.message);
      }
    }
    return {
      prompt_id: 'reply.zh-Hant@v1',
      brand_voice: '溫暖、專業、以公民教育為主',
      constraints: { max_chars: 350, language: 'zh-Hant' }
    };
  }

  appendTriageAudit(entry) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      const p = path.resolve(process.cwd(), 'logs/triage_audit.jsonl');
      fs.appendFile(p, line, err => {
        if (err) this.logger.warn('Failed to append triage audit', { error: err.message });
      });
    } catch (e) {
      this.logger.warn('appendTriageAudit error', { error: e.message });
    }
  }

  appendTriageDecision(entry) {
    try {
      const line = JSON.stringify({ ver: 1, ...entry }) + '\n';
      const p = path.resolve(this._logsDir, 'triage_decisions.jsonl');
      fs.appendFile(p, line, err => {
        if (err) this.logger.warn('Failed to append triage decision', { error: err.message });
      });
      this._snapshotsWritten++;
    } catch (e) {
      this.logger.warn('appendTriageDecision error', { error: e.message });
    }
  }

  appendReplyAudit(entry) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      const p = path.resolve(this._logsDir, 'reply_audit.jsonl');
      fs.appendFile(p, line, err => {
        if (err) this.logger.warn('Failed to append reply audit', { error: err.message });
      });
    } catch (e) {
      this.logger.warn('appendReplyAudit error', { error: e.message });
    }
  }

  appendReplyResult(entry) {
    try {
      const line = JSON.stringify({ ver: 1, ...entry }) + '\n';
      const p = path.resolve(this._logsDir, 'reply_results.jsonl');
      fs.appendFile(p, line, err => {
        if (err) this.logger.warn('Failed to append reply result', { error: err.message });
      });
      this._replySnapshotsWritten++;
    } catch (e) {
      this.logger.warn('appendReplyResult error', { error: e.message });
    }
  }

  // [ADD] 讀寫水位
  _loadWatermark() {
    try {
      return JSON.parse(fs.readFileSync(WATERMARK_PATH, 'utf8'));
    } catch (_) {
      return { triageBytes: 0, triageInode: null };
    }
  }

  _saveWatermark(watermark) {
    try {
      fs.mkdirSync(path.dirname(WATERMARK_PATH), { recursive: true });
      fs.writeFileSync(WATERMARK_PATH, JSON.stringify(watermark, null, 2), 'utf8');
    } catch (e) {
      this.logger?.warn?.('Failed to save watermark', { error: String(e) });
    }
  }

  // [ADD] 啟動回灌：掃 triage/reply 快照，重建 in-memory 索引
  async reindexFromSnapshots() {
    let triageCount = 0;
    let replyCount = 0;

    if (fs.existsSync(TRIAGE_SNAPSHOT)) {
      const rl = readline.createInterface({
        input: fs.createReadStream(TRIAGE_SNAPSHOT, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        const trimmed = line && line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.state === 'DONE' && obj.triage_result?.decision) {
            const candidateId = obj.candidate_id;
            if (!candidateId) continue;
            const entry = {
              candidate_id: candidateId,
              ticket_id: obj.ticket_id || null,
              state: obj.state || 'DONE',
              result: obj.triage_result,
              snapshot: obj
            };
            if (obj.seed?.value) {
              this._seedIndex.set(obj.seed.value, candidateId);
            }
            this.triageIndex.set(candidateId, entry);
            triageCount++;
          }
        } catch (e) {
          this.logger?.warn?.('Warm reindex triage parse error', { error: String(e) });
        }
      }
    }

    if (fs.existsSync(REPLY_SNAPSHOT)) {
      const rl = readline.createInterface({
        input: fs.createReadStream(REPLY_SNAPSHOT, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        const trimmed = line && line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          const candidateId = obj.candidate_id;
          if (!candidateId) continue;
          this.replyIndex.set(candidateId, {
            candidate_id: candidateId,
            reply_ticket_id: obj.reply_ticket_id || obj.ticket_id || null,
            triage_ticket_id: obj.triage_ticket_id || null,
            state: obj.state || 'PENDING',
            reply_result: obj.reply_result || null,
            reply_input: obj.reply_input || null,
            source: obj.source || 'snapshot',
            snapshot: obj
          });
          replyCount++;
        } catch (e) {
          this.logger?.warn?.('Warm reindex reply parse error', { error: String(e) });
        }
      }
    }

    try {
      if (fs.existsSync(TRIAGE_SNAPSHOT)) {
        const stat = fs.statSync(TRIAGE_SNAPSHOT);
        const wm = this._loadWatermark();
        wm.triageBytes = stat.size;
        wm.triageInode = stat.ino ?? null;
        this._saveWatermark(wm);
      }
    } catch (e) {
      this.logger?.warn?.('Failed to update watermark after reindex', { error: String(e) });
    }

    this._snapshotsWritten = triageCount;
    this._replySnapshotsWritten = replyCount;
    if (triageCount > 0) {
      this._lastBatchSource = 'reindex:warm';
    }
    if (replyCount > 0) {
      this._lastReplyDeriveSource = 'reindex:warm';
    }

    this.logger?.info?.('Warm reindex completed', {
      triageLoaded: triageCount,
      replyLoaded: replyCount,
      triageSnapshot: TRIAGE_SNAPSHOT,
      replySnapshot: REPLY_SNAPSHOT
    });
  }

  // [ADD] 追尾 triage 決策：新 APPROVE 自動 derive REPLY
  followSnapshots() {
    if (!fs.existsSync(TRIAGE_SNAPSHOT)) {
      this.logger?.warn?.('followSnapshots: triage snapshot not found', { TRIAGE_SNAPSHOT });
      return;
    }

    let watermark = this._loadWatermark();

    const processNewChunk = async () => {
      try {
        const stat = fs.statSync(TRIAGE_SNAPSHOT);
        const inodeChanged = watermark.triageInode && stat.ino && watermark.triageInode !== stat.ino;
        const truncated = stat.size < (watermark.triageBytes || 0);
        if (inodeChanged || truncated) {
          watermark.triageBytes = 0;
          watermark.triageInode = stat.ino ?? null;
        }
        if (stat.size <= (watermark.triageBytes || 0)) return;

        const stream = fs.createReadStream(TRIAGE_SNAPSHOT, {
          start: watermark.triageBytes,
          encoding: 'utf8'
        });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
          const trimmed = line && line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj.state === 'DONE' && obj.triage_result?.decision === 'APPROVE') {
              const candidateId = obj.candidate_id;
              if (!candidateId) continue;

              this.triageIndex.set(candidateId, {
                candidate_id: candidateId,
                ticket_id: obj.ticket_id || null,
                state: obj.state || 'DONE',
                result: obj.triage_result,
                snapshot: obj
              });

              if (obj.seed?.value) {
                this._seedIndex.set(obj.seed.value, candidateId);
              }

              if (this.replyIndex.has(candidateId)) continue;

              const replyInput = {
                brand_voice: this.replyDefaults?.brand_voice,
                stance_summary: obj.triage_result?.short_reason || '',
                candidate_snippet: obj.context_digest?.target_snippet || '',
                context_notes: '',
                reply_objectives: []
              };

              const created = await this.createReplyTicket({
                candidateId,
                triageTicket: null,
                triageResult: obj.triage_result,
                replyInput,
                source: 'tail:auto'
              });

              this.logger?.info?.('Auto-derived REPLY from tail', {
                candidate_id: candidateId,
                reply_ticket_id: created?.reply_ticket_id || created?.ticket_id || null
              });
            }
          } catch (e) {
            this.logger?.warn?.('Tail parse error (ignored)', { error: String(e) });
          }
        }

        watermark.triageBytes = stat.size;
        watermark.triageInode = stat.ino ?? watermark.triageInode ?? null;
        this._saveWatermark(watermark);
      } catch (e) {
        this.logger?.warn?.('followSnapshots: tail step failed', { error: String(e) });
      }
    };

    let running = false;
    const enqueue = () => {
      if (running) return;
      running = true;
      processNewChunk()
        .catch(err => {
          this.logger?.warn?.('followSnapshots step failed', { error: String(err) });
        })
        .finally(() => {
          running = false;
        });
    };

    enqueue();

    fs.watchFile(TRIAGE_SNAPSHOT, { persistent: true, interval: 1000 }, () => {
      enqueue();
    });

    this.logger?.info?.('Tail-follow started', { TRIAGE_SNAPSHOT, WATERMARK_PATH });
  }

  _buildSnapshotFromCandidate({ candidate, candidate_id, state, reason, ticket_id }) {
    const features = candidate.features || {};
    const context_digest = candidate.context_digest || {};
    const seed = candidate.seed || { type: 'url', value: '' };
    return {
      at: new Date().toISOString(),
      state,
      reason,
      decision: state === 'SKIPPED' ? 'SKIP' : undefined,
      ticket_id: ticket_id || null,
      candidate_id,
      seed,
      features: {
        author: features.author || '',
        len: Number.isFinite(features.len) ? features.len : (context_digest.target_snippet || '').length,
        engagement: {
          likes: Number.isFinite(features.engagement?.likes) ? features.engagement.likes : 0,
          comments: Number.isFinite(features.engagement?.comments) ? features.engagement.comments : 0
        },
        posted_at_iso: features.posted_at_iso || null,
        lang: features.lang || 'zh-Hant'
      },
      context_digest: {
        target_snippet: context_digest.target_snippet || '',
        original_len: Number.isFinite(context_digest.original_len) ? context_digest.original_len : undefined,
        is_truncated: Boolean(context_digest.is_truncated)
      }
    };
  }

  _buildSnapshotFromTicketDone({ ticket, candidate_id, triage_result }) {
    const inp = ticket?.metadata?.triage_input || {};
    const seed = { type: 'url', value: inp.url || '' };
    const features = {
      author: inp.author || '',
      len: Number.isFinite(inp.len) ? inp.len : (inp.snippet || '').length,
      engagement: { likes: Number(inp.engagement?.likes || 0), comments: Number(inp.engagement?.comments || 0) },
      posted_at_iso: inp.posted_at_iso || null,
      lang: inp.lang || 'zh-Hant'
    };
    const context_digest = {
      target_snippet: inp.snippet || '',
      original_len: Number.isFinite(inp.original_len) ? inp.original_len : undefined,
      is_truncated: Boolean(inp.is_truncated)
    };
    return {
      at: new Date().toISOString(),
      state: 'DONE',
      decision: triage_result?.decision,
      ticket_id: ticket.id,
      candidate_id,
      seed,
      features,
      context_digest,
      triage_result: triage_result ? {
        decision: triage_result.decision,
        priority: triage_result.priority,
        short_reason: triage_result.short_reason,
        topics: triage_result.topics,
        sentiment: triage_result.sentiment,
        risk_tags: triage_result.risk_tags
      } : undefined
    };
  }

  _buildReplySnapshotPending({ candidateId, replyTicketId, triageResult, replyInput, triageTicket, source = 'triage' }) {
    return {
      at: new Date().toISOString(),
      state: 'PENDING',
      candidate_id: candidateId,
      reply_ticket_id: replyTicketId,
      triage_ticket_id: triageTicket?.id || null,
      source,
      triage_decision: triageResult || null,
      reply_input: replyInput
    };
  }

  _buildReplySnapshotDone({ candidateId, replyTicketId, triageTicket, triageResult, replyResult }) {
    return {
      at: new Date().toISOString(),
      state: 'DONE',
      candidate_id: candidateId,
      reply_ticket_id: replyTicketId,
      triage_ticket_id: triageTicket?.id || null,
      triage_decision: triageResult || null,
      reply_result: replyResult
    };
  }

  async deriveRepliesFromTriage(payload = {}) {
    const {
      candidate_ids = [],
      limit = 20,
      defaults = {},
      force = false,
      include_flagged = false,
      source = 'triage'
    } = payload;

    this._lastReplyDeriveSource = source;
    const results = [];
    const max = Math.max(1, Math.min(200, Number(limit) || 20));
    const allowFlags = include_flagged === true;

    const requestedIds = Array.isArray(candidate_ids) ? candidate_ids.map(id => String(id)) : [];
    const triageEntries = [];

    if (requestedIds.length > 0) {
      for (const cid of requestedIds) {
        const entry = this.triageIndex.get(cid);
        if (!entry || !entry.result) {
          results.push({ candidate_id: cid, state: 'SKIPPED', reason: 'TRIAGE_RESULT_MISSING' });
          continue;
        }
        triageEntries.push([cid, entry]);
      }
    } else {
      for (const [cid, entry] of this.triageIndex.entries()) {
        if (!entry.result) continue;
        const decision = (entry.result.decision || '').toUpperCase();
        if (decision !== 'APPROVE' && !(allowFlags && decision === 'FLAG')) continue;
        triageEntries.push([cid, entry]);
      }
    }

    let created = 0;
    for (const [cid, entry] of triageEntries) {
      if (created >= max) break;
      if (!force && this.replyIndex.has(cid)) {
        const existing = this.replyIndex.get(cid);
        results.push({ candidate_id: cid, state: existing?.state || 'UNKNOWN', reason: 'ALREADY_EXISTS', reply_ticket_id: existing?.reply_ticket_id || null });
        continue;
      }

      const decision = (entry.result?.decision || '').toUpperCase();
      if (decision !== 'APPROVE' && !(allowFlags && decision === 'FLAG')) {
        results.push({ candidate_id: cid, state: 'SKIPPED', reason: 'DECISION_NOT_APPROVE' });
        continue;
      }

      let triageTicket = null;
      if (entry.ticket_id) {
        try {
          triageTicket = await this.ticketStore.get(entry.ticket_id);
        } catch (e) {
          this.logger.warn('Failed to load triage ticket for reply derivation', { candidate_id: cid, error: e.message });
        }
      }

      const triageInput = triageTicket?.metadata?.triage_input || {};
      const perCandidate = defaults?.per_candidate?.[cid] || {};
      const baseBrandVoice = defaults.brand_voice || this.replyDefaults.brand_voice;
      const replyInput = {
        brand_voice: perCandidate.brand_voice || baseBrandVoice || '溫暖、專業、以公民教育為主',
        stance_summary: perCandidate.stance_summary || defaults.stance_summary || entry.result?.short_reason || '',
        candidate_snippet: perCandidate.candidate_snippet || triageInput.snippet || triageTicket?.event?.content || '',
        context_notes: perCandidate.context_notes || defaults.context_notes || '',
        reply_objectives: Array.isArray(perCandidate.reply_objectives)
          ? perCandidate.reply_objectives
          : Array.isArray(defaults.reply_objectives)
            ? defaults.reply_objectives
            : []
      };

      const ticketInfo = await this.createReplyTicket({
        candidateId: cid,
        triageTicket,
        triageResult: entry.result,
        replyInput,
        source
      });
      results.push(ticketInfo);
      created++;
    }

    return results;
  }

  async createReplyTicket({ candidateId, triageTicket, triageResult, replyInput, source = 'triage' }) {
    const replyTicketId = uuidv4();
    const nowIso = new Date().toISOString();
    const threadId = triageTicket?.context?.thread_id || candidateId;
    const eventActor = triageTicket?.event?.actor || 'threads_bot';
    const eventContent = replyInput.candidate_snippet || triageTicket?.event?.content || '';

    const replyInputWithId = { ...replyInput, candidate_id: candidateId };

    const ticket = {
      id: replyTicketId,
      ticket_id: replyTicketId,
      type: 'DraftTicket',
      status: 'pending',
      flow_id: 'reply_zh_hant_v1',
      event: {
        type: 'reply_request',
        event_id: `reply-${candidateId}`,
        thread_id: threadId,
        content: eventContent,
        actor: eventActor,
        timestamp: nowIso
      },
      context: {
        thread_id: threadId,
        event_id: `reply-${candidateId}`
      },
      constraints: {
        lang: (this.replyDefaults?.constraints?.language || 'zh-tw').toLowerCase(),
        max_chars: this.replyDefaults?.constraints?.max_chars || 350
      },
      metadata: {
        created_at: nowIso,
        updated_at: nowIso,
        mode: 'client-filled',
        prompt_id: this.replyDefaults?.prompt_id || 'reply.zh-Hant@v1',
        candidate_id: candidateId,
        triage_ticket_id: triageTicket?.id || null,
        triage_result: triageResult || null,
        reply_input: replyInputWithId,
        source,
        derived_at: nowIso
      }
    };

    await this.ticketStore.create(ticket);
    this.replyIndex.set(candidateId, {
      state: 'PENDING',
      reply_ticket_id: replyTicketId,
      triage_ticket_id: triageTicket?.id || null,
      triage_result: triageResult || null,
      reply_input: replyInputWithId,
      source
    });

    this._lastReplyDeriveSource = source;

    this.appendReplyAudit({ phase: 'derive', outcome: 'ENQUEUED', candidate_id: candidateId, reply_ticket_id: replyTicketId, source });
    const snap = this._buildReplySnapshotPending({
      candidateId,
      replyTicketId,
      triageResult,
      replyInput: replyInputWithId,
      triageTicket,
      source
    });
    this.appendReplyResult(snap);

    this.logger.info('Reply ticket created', {
      candidate_id: candidateId,
      reply_ticket_id: replyTicketId,
      source
    });

    return { candidate_id: candidateId, state: 'PENDING', reply_ticket_id: replyTicketId };
  }

  _normalizeDecision({ decision, should_reply, state }) {
    const d = (decision || '').toString().toUpperCase();
    if (d === 'APPROVE' || d === 'SKIP' || d === 'FLAG') return d;
    if (should_reply === true) return 'APPROVE';
    if (should_reply === false) return 'SKIP';
    if (state === 'SKIPPED') return 'SKIP';
    return null;
  }
  
  setupRoutes() {
    this.app.use(express.json());

    // 可選 Bearer 認證（僅 triage 相關端點）
    const requireAuth = (req, res, next) => {
      const enabled = process.env.REQUIRE_AUTH === 'true';
      if (!enabled) return next();
      const header = req.headers['authorization'] || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const expected = process.env.TRIAGE_BEARER_TOKEN || '';
      if (!token || token !== expected) {
        this.appendTriageAudit({ phase: 'auth', outcome: 'DENY', ip: req.ip, path: req.path });
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    };

    const computeRecencyMinutes = (postedAtIso) => {
      if (!postedAtIso) return undefined;
      const posted = new Date(postedAtIso);
      if (isNaN(posted.getTime())) return undefined;
      const diffMs = Date.now() - posted.getTime();
      return Math.max(0, Math.round(diffMs / 60000));
    };

    // --- TRIAGE A 握手 ---
    // POST /v1/triage/batch
    this.app.post('/v1/triage/batch', requireAuth, async (req, res) => {
      try {
        const qMode = req.query.mode;
        const qWaitMs = req.query.wait_ms ? parseInt(String(req.query.wait_ms)) : undefined;
        const { candidates = [], mode = 'sync', wait_ms = 0 } = req.body || {};
        // 記錄來源（觀測）
        this._lastBatchSource = req.query.source || req.headers['x-source'] || null;
        if (!Array.isArray(candidates) || candidates.length === 0) {
          return res.status(400).json({ error: 'ERR_INVALID_PAYLOAD', message: 'candidates[] required' });
        }
        const effectiveMode = qMode || mode || 'sync';
        const effectiveWaitMs = Number.isFinite(qWaitMs) ? qWaitMs : (wait_ms || 0);

        // 去重參數
        const dedupe = String(req.query.dedupe || '').toLowerCase() === 'true';
        const dedupeField = String(req.query.dedupe_field || 'candidate_id'); // candidate_id | seed.value

        const now = Date.now();
        const results = [];

        for (const c of candidates) {
          const candidateId = c.candidate_id || c.id || uuidv4();

          // 支援 CandidateLite 與相容舊格式
          const isLite = c && typeof c === 'object' && (c.platform || c.features || c.context_digest);
          const snippet = isLite ? (c.context_digest?.target_snippet || '') : (c.snippet || '');
          const features = isLite ? (c.features || {}) : {};
          const engagement = features.engagement || {};
          const likes = Number.isFinite(engagement.likes) ? engagement.likes : 0;
          const comments = Number.isFinite(engagement.comments) ? engagement.comments : 0;
          const author = features.author || c.author || '';
          const lang = features.lang || 'zh-Hant';
          const lenVal = Number.isFinite(features.len) ? features.len : (snippet ? snippet.length : 0);
          const postedIso = features.posted_at_iso;
          const providedRecency = Number.isFinite(features.recency_minutes) ? features.recency_minutes : undefined;
          const computedRecency = computeRecencyMinutes(postedIso);
          const usedRecency = (computedRecency ?? providedRecency);
          if (providedRecency != null && computedRecency != null && providedRecency !== computedRecency) {
            this.appendTriageAudit({ phase: 'normalize', outcome: 'RECENCY_OVERRIDDEN', candidate_id: candidateId, provided_recency: providedRecency, computed_recency: computedRecency, posted_at_iso: postedIso });
          }

          // Gate-0 粗篩（最小長度）
          const tooShort = this.triageDefaults.gate0?.enabled && snippet.length < (this.triageDefaults.gate0.min_len || 0);
          if (tooShort) {
            const skipped = { candidate_id: candidateId, state: 'SKIPPED', decision: 'SKIP', reason: 'policy:min_len' };
            // 索引寫入 SKIPPED
            this.triageIndex.set(candidateId, { state: 'SKIPPED', reason: skipped.reason, at: new Date().toISOString(), triage_ticket_id: null });
            // 審計包含門檻與實際值
            this.appendTriageAudit({
              phase: 'gate0', outcome: 'SKIPPED', candidate_id: candidateId, reason: 'policy:min_len',
              rule: 'g0:min_len',
              thresholds: { min_len: this.triageDefaults.gate0.min_len },
              values: { snippet_len: snippet.length }
            });
            // 快照寫入
            const snap = this._buildSnapshotFromCandidate({ candidate: c, candidate_id: candidateId, state: 'SKIPPED', reason: 'policy:min_len', ticket_id: null });
            this.appendTriageDecision(snap);
            results.push(skipped);
            continue;
          }

          // Gate-0B（數值化粗篩）
          const g0b = this.triageDefaults.gate0b || { enabled: false };
          if (g0b.enabled) {
            if (lenVal < (g0b.min_len ?? 0)) {
              const skipped = { candidate_id: candidateId, state: 'SKIPPED', decision: 'SKIP', reason: 'policy:g0b:min_len' };
              this.triageIndex.set(candidateId, { state: 'SKIPPED', reason: skipped.reason, at: new Date().toISOString(), triage_ticket_id: null });
              this.appendTriageAudit({
                phase: 'gate0b', outcome: 'SKIPPED', candidate_id: candidateId, reason: 'policy:g0b:min_len',
                rule: 'g0b:min_len',
                thresholds: { min_len: g0b.min_len, min_likes: g0b.min_likes, min_comments: g0b.min_comments },
                values: { len: lenVal, likes, comments }
              });
              const snap = this._buildSnapshotFromCandidate({ candidate: c, candidate_id: candidateId, state: 'SKIPPED', reason: 'policy:g0b:min_len', ticket_id: null });
              this.appendTriageDecision(snap);
              results.push(skipped);
              continue;
            }
            if (likes < (g0b.min_likes ?? 0)) {
              const skipped = { candidate_id: candidateId, state: 'SKIPPED', decision: 'SKIP', reason: 'policy:g0b:min_likes' };
              this.triageIndex.set(candidateId, { state: 'SKIPPED', reason: skipped.reason, at: new Date().toISOString(), triage_ticket_id: null });
              this.appendTriageAudit({
                phase: 'gate0b', outcome: 'SKIPPED', candidate_id: candidateId, reason: 'policy:g0b:min_likes',
                rule: 'g0b:min_likes',
                thresholds: { min_len: g0b.min_len, min_likes: g0b.min_likes, min_comments: g0b.min_comments },
                values: { len: lenVal, likes, comments }
              });
              const snap = this._buildSnapshotFromCandidate({ candidate: c, candidate_id: candidateId, state: 'SKIPPED', reason: 'policy:g0b:min_likes', ticket_id: null });
              this.appendTriageDecision(snap);
              results.push(skipped);
              continue;
            }
            if (comments < (g0b.min_comments ?? 0)) {
              const skipped = { candidate_id: candidateId, state: 'SKIPPED', decision: 'SKIP', reason: 'policy:g0b:min_comments' };
              this.triageIndex.set(candidateId, { state: 'SKIPPED', reason: skipped.reason, at: new Date().toISOString(), triage_ticket_id: null });
              this.appendTriageAudit({
                phase: 'gate0b', outcome: 'SKIPPED', candidate_id: candidateId, reason: 'policy:g0b:min_comments',
                rule: 'g0b:min_comments',
                thresholds: { min_len: g0b.min_len, min_likes: g0b.min_likes, min_comments: g0b.min_comments },
                values: { len: lenVal, likes, comments }
              });
              const snap = this._buildSnapshotFromCandidate({ candidate: c, candidate_id: candidateId, state: 'SKIPPED', reason: 'policy:g0b:min_comments', ticket_id: null });
              this.appendTriageDecision(snap);
              results.push(skipped);
              continue;
            }
          }

          // 去重檢查（可選）
          if (dedupe) {
            if (dedupeField === 'candidate_id') {
              const existing = this.triageIndex.get(candidateId);
              if (existing) {
                const base = { candidate_id: candidateId };
                if (existing.state === 'SKIPPED') {
                  results.push({ ...base, state: 'SKIPPED', reason: existing.reason });
                } else if (existing.state === 'PENDING') {
                  results.push({ ...base, state: 'PENDING', triage_ticket_id: existing.ticket_id });
                } else if (existing.state === 'DONE') {
                  results.push({ ...base, state: 'DONE', triage_result: existing.result });
                } else {
                  results.push({ ...base, state: existing.state });
                }
                continue;
              }
            } else if (dedupeField === 'seed.value') {
              const seedVal = (isLite ? (c.seed?.value || '') : '') || '';
              if (seedVal) {
                const mapped = this._seedIndex.get(seedVal);
                if (mapped) {
                  const existing = this.triageIndex.get(mapped);
                  const base = { candidate_id: mapped };
                  if (existing) {
                    if (existing.state === 'SKIPPED') {
                      results.push({ ...base, state: 'SKIPPED', reason: existing.reason });
                    } else if (existing.state === 'PENDING') {
                      results.push({ ...base, state: 'PENDING', triage_ticket_id: existing.ticket_id });
                    } else if (existing.state === 'DONE') {
                      results.push({ ...base, state: 'DONE', triage_result: existing.result });
                    } else {
                      results.push({ ...base, state: existing.state });
                    }
                    continue;
                  }
                }
              }
            }
          }

          // 冪等：若已存在則直接回既有狀態
          const existing = this.triageIndex.get(candidateId);
          if (existing) {
            const ticket = await this.ticketStore.get(existing.ticket_id);
            const base = { candidate_id: candidateId };
            if (ticket && ticket.status === 'drafted' && existing.result) {
              results.push({ ...base, state: 'DONE', triage_result: existing.result });
            } else {
              results.push({ ...base, state: 'PENDING', triage_ticket_id: existing.ticket_id });
            }
            continue;
          }

          // 建立 TRIAGE 票（client-filled）
          const ticketId = uuidv4();
          const threadId = isLite ? (c.account?.handle || candidateId) : (c.thread_id || candidateId);
          const ticket = {
            id: ticketId,
            ticket_id: ticketId,
            type: 'DraftTicket',
            status: 'pending',
            flow_id: 'triage_zh_hant_v1',
            event: {
              type: 'triage_candidate',
              event_id: `triage-${candidateId}`,
              thread_id: threadId,
              content: snippet,
              actor: author || 'threads_bot',
              timestamp: c.created_at || new Date().toISOString()
            },
            context: {
              thread_id: threadId,
              event_id: `triage-${candidateId}`
            },
            constraints: {
              lang: 'zh-tw',
              max_chars: 500
            },
            metadata: {
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              mode: 'client-filled',
              prompt_id: this.triageDefaults.prompt_id,
              candidate_id: candidateId,
              platform: isLite ? (c.platform || 'threads') : undefined,
              account_handle: isLite ? (c.account?.handle || '') : undefined,
              triage_input: {
                url: isLite ? (c.seed?.value || '') : '',
                snippet,
                lang,
                author,
                len: lenVal,
                engagement: { likes, comments },
                recency_minutes: usedRecency,
                posted_at_iso: postedIso,
                is_truncated: isLite ? Boolean(c.context_digest?.is_truncated) : undefined,
                original_len: isLite ? (c.context_digest?.original_len || undefined) : undefined
              }
            }
          };
          await this.ticketStore.create(ticket);
          this.triageIndex.set(candidateId, { ticket_id: ticketId, state: 'PENDING' });
          // 建立 seed 去重映射
          if (ticket.metadata?.triage_input?.url) {
            const seedVal = ticket.metadata.triage_input.url;
            if (seedVal) this._seedIndex.set(seedVal, candidateId);
          }
          this.appendTriageAudit({ phase: 'enqueue', outcome: 'PENDING', candidate_id: candidateId, ticket_id: ticketId });

          results.push({ candidate_id: candidateId, state: 'PENDING', triage_ticket_id: ticketId });
        }

        // sync 模式：在窗口內觀察 drafted → DONE
        if (effectiveMode === 'sync' && effectiveWaitMs > 0) {
          const deadline = now + Math.min(effectiveWaitMs, 5000);
          while (Date.now() < deadline) {
            let anyUpdated = false;
            for (const r of results) {
              if (r.state !== 'PENDING') continue;
              const idx = this.triageIndex.get(r.candidate_id);
              if (!idx) continue;
              const t = await this.ticketStore.get(idx.ticket_id);
              if (t && t.status === 'drafted' && idx.result) {
                r.state = 'DONE';
                r.triage_result = idx.result;
                anyUpdated = true;
              }
            }
            if (!anyUpdated) await new Promise(res2 => setTimeout(res2, 150));
          }
        }

        return res.json({ results });
      } catch (e) {
        this.logger.error('triage.batch failed', { error: e.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    });

    // POST /v1/tickets/lease 只針對 TRIAGE（若 kind=TRIAGE）
    this.app.post('/v1/tickets/lease', requireAuth, async (req, res) => {
      try {
        // Accept both max/limit and lease_sec/lease_ms; clamp limit; normalize kind
        const kind = (req.body?.kind || 'TRIAGE').toUpperCase();
        const askRaw = Number(req.body?.max ?? req.body?.limit);
        const limit = Math.max(1, Math.min(50, Number.isFinite(askRaw) ? askRaw : 3));
        const leaseSecRaw = Number(req.body?.lease_sec ?? req.body?.lease_ms);
        const lease_sec = Number.isFinite(leaseSecRaw) ? leaseSecRaw : 90;
        const workerId = req.headers['x-worker-id'] || 'vscode-worker';
        const pending = await this.ticketStore.list({ status: 'pending', limit: 1000 });
        const flowMap = { TRIAGE: 'triage_zh_hant_v1', REPLY: 'reply_zh_hant_v1' };
        const targetFlow = flowMap[kind] || null;
        const pick = pending.filter(t => !targetFlow || t.flow_id === targetFlow).slice(0, limit);
        this.logger.info('Lease request handled', { kind, ask: limit, returned: pick.length });
        const leased = [];
        const expiresAt = new Date(Date.now() + lease_sec * 1000).toISOString();
        for (const t of pick) {
          t.status = 'leased';
          t.metadata.assigned_to = workerId;
          t.metadata.lease_expires = expiresAt;
          t.metadata.updated_at = new Date().toISOString();
          const schemaRef = kind === 'REPLY' ? 'prompts/reply/schema.json' : 'prompts/triage/schema.json';
          const inputs = kind === 'REPLY' ? (t.metadata.reply_input || {}) : (t.metadata.triage_input || {});
          const extraMeta = kind === 'REPLY' ? {
            candidate_id: t.metadata?.candidate_id,
            triage_ticket_id: t.metadata?.triage_ticket_id,
            triage_decision: t.metadata?.triage_result
          } : undefined;
          leased.push({
            ticket_id: t.id,
            prompt_id: t.metadata.prompt_id,
            schema_ref: schemaRef,
            inputs,
            lease_id: `${t.id}.${Date.now()}`,
            lease_expire_at: expiresAt,
            metadata: extraMeta
          });
        }
        return res.json(leased);
      } catch (e) {
        this.logger.error('tickets.lease failed', { error: e.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    });

    // POST /v1/tickets/:id/fill 接受 triage outputs 格式
    this.app.post('/v1/tickets/:id/fill', requireAuth, async (req, res) => {
      try {
        const { lease_id, outputs, by, tokens } = req.body || {};
        const t = await this.ticketStore.get(req.params.id);
        if (!t) return res.status(404).json({ error: 'Ticket not found' });

  // 允許 VS Code 端回傳 JSON outputs，我們存成 draft 字串
        const draftStr = outputs ? JSON.stringify(outputs) : '';
        let computedConfidence = 0.6;
        if (t.flow_id === 'triage_zh_hant_v1') {
          computedConfidence = outputs?.should_reply ? 0.85 : 0.6;
        } else if (t.flow_id === 'reply_zh_hant_v1') {
          computedConfidence = Number.isFinite(outputs?.confidence) ? outputs.confidence : 0.7;
        }
        const model_info = by ? {
          provider: 'vscode.lm',
          model: String(by),
          latency_ms: 0,
          prompt_tokens: tokens?.input || 0,
          completion_tokens: tokens?.output || 0
        } : undefined;

        const ticket = await this.ticketStore.fill(req.params.id, draftStr, computedConfidence, model_info);

        // 轉換為 TriageResult，寫入 triageIndex
        if (t.flow_id === 'triage_zh_hant_v1') {
          const candidateId = t.metadata?.candidate_id;
          if (candidateId) {
            const normalized = this._normalizeDecision({ decision: outputs?.decision, should_reply: outputs?.should_reply });
            const decision = normalized;
            const result = {
              candidate_id: candidateId,
              decision,
              priority: outputs?.priority || 'P2',
              short_reason: outputs?.short_reason || '',
              topics: outputs?.topics || [],
              sentiment: outputs?.sentiment || 'neutral',
              risk_tags: outputs?.risk_tags || [],
              filled_at: new Date().toISOString()
            };
            const entry = this.triageIndex.get(candidateId) || { ticket_id: req.params.id };
            entry.state = 'DONE';
            entry.result = result;
            entry.last_raw_outputs = outputs;
            this.triageIndex.set(candidateId, entry);

            // 簡要決策日誌
            this.logger.info('Triage decision recorded', {
              candidate_id: candidateId,
              decision: result.decision,
              priority: result.priority,
              topics: result.topics,
              sentiment: result.sentiment
            });

            // 審計：決策完成
            this.appendTriageAudit({ phase: 'fill', outcome: 'DONE', candidate_id: candidateId, ticket_id: req.params.id, result });

            // 快照：DONE
            const snap = this._buildSnapshotFromTicketDone({ ticket: t, candidate_id: candidateId, triage_result: result });
            this.appendTriageDecision(snap);
          }
        }

        if (t.flow_id === 'reply_zh_hant_v1') {
          const candidateId = t.metadata?.candidate_id;
          if (candidateId) {
            let replyPayload = outputs;
            if (!replyPayload && draftStr) {
              try { replyPayload = JSON.parse(draftStr); } catch (_) { replyPayload = null; }
            }
            const replyResult = {
              reply: replyPayload?.reply || '',
              confidence: Number.isFinite(replyPayload?.confidence) ? replyPayload.confidence : computedConfidence,
              citations: Array.isArray(replyPayload?.citations) ? replyPayload.citations : [],
              hashtags: Array.isArray(replyPayload?.hashtags) ? replyPayload.hashtags : [],
              tone_tags: Array.isArray(replyPayload?.tone_tags) ? replyPayload.tone_tags : [],
              needs_followup: Boolean(replyPayload?.needs_followup),
              followup_notes: replyPayload?.followup_notes || ''
            };
            const entry = this.replyIndex.get(candidateId) || {};
            entry.state = 'DONE';
            entry.reply_ticket_id = req.params.id;
            entry.triage_ticket_id = t.metadata?.triage_ticket_id || null;
            entry.reply_result = replyResult;
            entry.triage_result = t.metadata?.triage_result || null;
            entry.last_raw_outputs = replyPayload;
            entry.completed_at = new Date().toISOString();
            this.replyIndex.set(candidateId, entry);

            this.logger.info('Reply drafted', {
              candidate_id: candidateId,
              reply_ticket_id: req.params.id,
              confidence: replyResult.confidence,
              reply_preview: replyResult.reply.slice(0, 80)
            });

            this.appendReplyAudit({ phase: 'fill', outcome: 'DONE', candidate_id: candidateId, reply_ticket_id: req.params.id });
            const snap = this._buildReplySnapshotDone({
              candidateId,
              replyTicketId: req.params.id,
              triageTicket: t,
              triageResult: t.metadata?.triage_result,
              replyResult
            });
            this.appendReplyResult(snap);
          }
        }

        return res.json(ticket);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    });

    // GET /v1/triage/results?ids=a,b,c
    this.app.get('/v1/triage/results', requireAuth, async (req, res) => {
      try {
        const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length === 0) return res.status(400).json({ error: 'ids required' });

        const mapOne = async (echoId) => {
          // 先視為 candidate_id 在 triageIndex 查找
          const entry = this.triageIndex.get(echoId);
          if (entry) {
            if (entry.state === 'SKIPPED') {
              return { id: echoId, state: 'SKIPPED', reason: entry.reason, triage_ticket_id: null };
            }
            if (entry.result) {
              return { id: echoId, state: 'DONE', triage_ticket_id: entry.ticket_id, triage_result: entry.result };
            }
            return { id: echoId, state: 'PENDING', triage_ticket_id: entry.ticket_id };
          }

          // 再視為 ticket_id 反查 candidate_id
          try {
            const t = await this.ticketStore.get(echoId);
            if (t) {
              const cid = t.metadata?.candidate_id;
              const ent2 = cid ? this.triageIndex.get(cid) : undefined;
              if (ent2) {
                if (ent2.state === 'SKIPPED') return { id: echoId, state: 'SKIPPED', reason: ent2.reason, triage_ticket_id: null };
                if (ent2.result) return { id: echoId, state: 'DONE', triage_ticket_id: ent2.ticket_id, triage_result: ent2.result };
                return { id: echoId, state: 'PENDING', triage_ticket_id: ent2.ticket_id };
              }
            }
          } catch (_) {}
          return { id: echoId, state: 'UNKNOWN' };
        };

        const results = await Promise.all(ids.map(mapOne));
        return res.json({ results });
      } catch (e) {
        return res.status(500).json({ error: 'Internal server error' });
      }
    });
    
    // 健康檢查
    this.app.get('/health', async (req, res) => {
      const queueDepth = await this.ticketStore.count({ status: 'pending' });
      const inProgress = await this.ticketStore.count({ status: 'in_progress' });
      res.json({ 
        status: 'healthy', 
        mode: 'client-filled',
        uptime: process.uptime(),
        queue_depth: queueDepth,
        in_progress: inProgress,
        last_poll: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        dry_run: this.dryRun,
        cwd: process.cwd(),
        config_path: './mcp_config.json'
      });
    });
    
    // 事件入口
    this.app.post('/events', async (req, res) => {
      try {
        const event = req.body;
        
        // Schema 驗證
        const { error, value } = eventSchema.validate(event);
        if (error) {
          this.logger.warn('Schema validation failed', { error: error.message });
          return res.status(400).json({ 
            error: 'ERR_SCHEMA_VALIDATION', 
            message: error.message 
          });
        }
        
        // Event ID 去重檢查
        if (this.processedEvents.has(value.event_id)) {
          this.logger.info('Duplicate event ignored', { event_id: value.event_id });
          return res.status(200).json({ 
            message: 'duplicate ignored', 
            event_id: value.event_id 
          });
        }
        
        const ticket = await this.createTicketFromEvent(value);
        this.processedEvents.add(value.event_id);
        
        res.status(202).json({ ticket_id: ticket.id, status: 'queued' });
      } catch (error) {
        this.logger.error('Failed to process event', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });
    
    // Ticket API
    this.app.get('/tickets', async (req, res) => {
      const { status, limit = 10 } = req.query;
      const tickets = await this.ticketStore.list({ status, limit: parseInt(limit) });
      res.json(tickets);
    });
    
    this.app.get('/ticket/:id', async (req, res) => {
      const ticket = await this.ticketStore.get(req.params.id);
      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      res.json(ticket);
    });
    
    this.app.post('/ticket/:id/fill', async (req, res) => {
      try {
        const { draft, confidence, model_info } = req.body;
        const ticket = await this.ticketStore.fill(req.params.id, draft, confidence, model_info);
        
        // 如果是 client-filled 模式，回填後觸發後續 DAG 執行
        if (ticket.metadata.mode === 'client-filled') {
          setImmediate(() => this.executeDAGAfterFill(ticket));
        }

        // 若為 triage 票，將 drafted 草稿解析為 triage_result 並更新 triageIndex
        if (ticket.flow_id === 'triage_zh_hant_v1') {
          try {
            const obj = typeof draft === 'string' ? JSON.parse(draft) : draft;
            const candidateId = ticket.metadata?.candidate_id;
            if (candidateId) {
              const normalized = this._normalizeDecision({ decision: obj?.decision, should_reply: obj?.should_reply });
              const decision = normalized;
              const result = {
                candidate_id: candidateId,
                decision,
                priority: obj?.priority || 'P2',
                short_reason: obj?.short_reason || '',
                topics: obj?.topics || [],
                sentiment: obj?.sentiment || 'neutral',
                risk_tags: obj?.risk_tags || [],
                filled_at: new Date().toISOString()
              };
              const entry = this.triageIndex.get(candidateId) || { ticket_id: req.params.id };
              entry.state = 'DONE';
              entry.result = result;
              entry.last_raw_outputs = obj;
              this.triageIndex.set(candidateId, entry);

              // 簡要決策日誌
              this.logger.info('Triage decision recorded', {
                candidate_id: candidateId,
                decision: result.decision,
                priority: result.priority,
                topics: result.topics,
                sentiment: result.sentiment
              });

              // 審計：決策完成
              this.appendTriageAudit({ phase: 'fill', outcome: 'DONE', candidate_id: candidateId, ticket_id: req.params.id, result });

              // 快照：DONE
              const snap = this._buildSnapshotFromTicketDone({ ticket, candidate_id: candidateId, triage_result: result });
              this.appendTriageDecision(snap);
            }
          } catch (e) {
            this.logger.warn('Failed to parse triage draft as JSON', { error: e.message });
          }
        }
        
        res.json(ticket);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });
    
    this.app.post('/tickets/:id/approve', async (req, res) => {
      try {
        const ticket = await this.ticketStore.approve(req.params.id);
        res.json(ticket);
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });
    
    // 指標端點
    this.app.get('/metrics', async (req, res) => {
      const metrics = await this.getMetrics();
      res.json(metrics);
    });

    // GET /v1/triage/list - 歷史列舉
    this.app.get('/v1/triage/list', requireAuth, async (req, res) => {
      try {
        const p = path.resolve(this._logsDir, 'triage_decisions.jsonl');
        const states = String(req.query.state || '').split(',').map(s => s.trim()).filter(Boolean);
        const decisionFilter = String(req.query.decision || '').trim();
        const reasonLike = String(req.query.reason_like || '').trim();
        const since = req.query.since ? new Date(String(req.query.since)) : null;
        const until = req.query.until ? new Date(String(req.query.until)) : null;
        let limit = parseInt(String(req.query.limit || '100'), 10);
        if (!Number.isFinite(limit) || limit <= 0) limit = 100;
        if (limit > 1000) limit = 1000;
        const format = (String(req.query.format || 'json').toLowerCase());
        let cursor = String(req.query.cursor || '');
        let startIndex = 0;
        if (cursor) {
          try { startIndex = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')).index || 0; } catch(_) { startIndex = 0; }
        }

        let lines = [];
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          lines = raw.split('\n').filter(Boolean);
        }
        const items = [];
        let i = startIndex;
        for (; i < lines.length && items.length < limit; i++) {
          try {
            const obj = JSON.parse(lines[i]);
            // 基本過濾
            if (states.length && !states.includes(obj.state)) continue;
            if (decisionFilter && obj.decision !== decisionFilter) continue;
            if (reasonLike && (!obj.reason || !String(obj.reason).includes(reasonLike))) continue;
            if (since && (!obj.at || new Date(obj.at) < since)) continue;
            if (until && (!obj.at || new Date(obj.at) > until)) continue;
            items.push(obj);
          } catch(_) { /* skip bad line */ }
        }
        const nextCursor = i < lines.length ? Buffer.from(JSON.stringify({ index: i }), 'utf8').toString('base64') : null;

        if (format === 'ndjson') {
          res.set('Content-Type', 'application/x-ndjson');
          res.send(items.map(it => JSON.stringify(it)).join('\n'));
        } else {
          res.json({ items, next_cursor: nextCursor });
        }
      } catch (e) {
        this.logger.error('triage.list failed', { error: e.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // GET /v1/triage/export - 匯出
    this.app.get('/v1/triage/export', requireAuth, async (req, res) => {
      try {
        // 重用 /v1/triage/list 的讀取與過濾
        req.query.format = 'json';
        const fauxRes = { json: (data) => data };
        const listHandler = this.app._router.stack.find(r => r.route && r.route.path === '/v1/triage/list' && r.route.methods.get);
        // 若找不到，直接重讀
        const listData = await (async () => {
          const p = path.resolve(this._logsDir, 'triage_decisions.jsonl');
          const states = String(req.query.state || '').split(',').map(s => s.trim()).filter(Boolean);
          const decisionFilter = String(req.query.decision || '').trim();
          const reasonLike = String(req.query.reason_like || '').trim();
          const since = req.query.since ? new Date(String(req.query.since)) : null;
          const until = req.query.until ? new Date(String(req.query.until)) : null;
          let limit = parseInt(String(req.query.limit || '100'), 10);
          if (!Number.isFinite(limit) || limit <= 0) limit = 100;
          if (limit > 1000) limit = 1000;
          let lines = [];
          if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, 'utf8');
            lines = raw.split('\n').filter(Boolean);
          }
          const items = [];
          for (let i=0; i<lines.length && items.length < limit; i++) {
            try {
              const obj = JSON.parse(lines[i]);
              if (states.length && !states.includes(obj.state)) continue;
              if (decisionFilter && obj.decision !== decisionFilter) continue;
              if (reasonLike && (!obj.reason || !String(obj.reason).includes(reasonLike))) continue;
              if (since && (!obj.at || new Date(obj.at) < since)) continue;
              if (until && (!obj.at || new Date(obj.at) > until)) continue;
              items.push(obj);
            } catch(_) {}
          }
          return { items };
        })();

        const format = (String(req.query.format || 'csv').toLowerCase());
        if (format === 'ndjson') {
          res.set('Content-Type', 'application/x-ndjson');
          res.send(listData.items.map(it => JSON.stringify(it)).join('\n'));
          return;
        }
        // CSV
        res.set('Content-Type', 'text/csv; charset=utf-8');
        const header = ['at','candidate_id','ticket_id','state','decision','priority','author','likes','comments','posted_at_iso','seed_url','short_reason'];
        const lines = [header.join(',')];
        for (const it of listData.items) {
          const decision = it.decision || (it.state === 'SKIPPED' ? 'SKIP' : '');
          const priority = it.triage_result?.priority || '';
          const author = it.features?.author || '';
          const likes = it.features?.engagement?.likes ?? '';
          const comments = it.features?.engagement?.comments ?? '';
          const posted = it.features?.posted_at_iso || '';
          const seedUrl = it.seed?.value || '';
          const shortReason = it.triage_result?.short_reason ? String(it.triage_result.short_reason).replace(/\n|\r|,/g, ' ') : '';
          const row = [it.at, it.candidate_id, it.ticket_id || '', it.state, decision, priority, author, likes, comments, posted, seedUrl, shortReason]
            .map(v => typeof v === 'string' ? '"' + v.replace(/"/g, '""') + '"' : String(v));
          lines.push(row.join(','));
        }
        res.send(lines.join('\n'));
      } catch (e) {
        this.logger.error('triage.export failed', { error: e.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // GET /v1/triage/tickets/:id/raw - 回傳最後一次回填的原始 outputs（隱去潛在敏感）
    this.app.get('/v1/triage/tickets/:id/raw', requireAuth, async (req, res) => {
      try {
        const ticketId = req.params.id;
        // 在 triageIndex 反查 candidate_id
        let found = null;
        for (const [cid, val] of this.triageIndex.entries()) {
          if (val.ticket_id === ticketId) { found = { cid, val }; break; }
        }
        if (!found) return res.status(404).json({ error: 'NOT_FOUND' });
        const raw = found.val.last_raw_outputs || null;
        // 簡單遮蔽：移除可能的密鑰欄位
        const redacted = raw ? JSON.parse(JSON.stringify(raw)) : null;
        const redactKeys = ['access_token','authorization','cookie','email'];
        if (redacted && typeof redacted === 'object') {
          for (const k of redactKeys) if (k in redacted) redacted[k] = '[REDACTED]';
        }
        res.json({ ticket_id: ticketId, candidate_id: found.cid, outputs: redacted });
      } catch (e) {
        this.logger.error('triage.raw failed', { error: e.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // --- Reply workflow APIs ---
    this.app.post('/v1/reply/derive', requireAuth, async (req, res) => {
      try {
        const payload = req.body || {};
        const results = await this.deriveRepliesFromTriage(payload);
        res.json({ results });
      } catch (e) {
        this.logger.error('reply.derive failed', { error: e.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    this.app.get('/v1/reply/list', requireAuth, async (req, res) => {
      try {
        const p = path.resolve(this._logsDir, 'reply_results.jsonl');
        const states = String(req.query.state || '').split(',').map(s => s.trim()).filter(Boolean);
        const candidateFilter = String(req.query.candidate_id || '').trim();
        const since = req.query.since ? new Date(String(req.query.since)) : null;
        const until = req.query.until ? new Date(String(req.query.until)) : null;
        let limit = parseInt(String(req.query.limit || '100'), 10);
        if (!Number.isFinite(limit) || limit <= 0) limit = 100;
        if (limit > 1000) limit = 1000;
        const format = (String(req.query.format || 'json').toLowerCase());
        let cursor = String(req.query.cursor || '');
        let startIndex = 0;
        if (cursor) {
          try { startIndex = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')).index || 0; } catch(_) { startIndex = 0; }
        }

        let lines = [];
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          lines = raw.split('\n').filter(Boolean);
        }
        const items = [];
        let i = startIndex;
        for (; i < lines.length && items.length < limit; i++) {
          try {
            const obj = JSON.parse(lines[i]);
            if (states.length && !states.includes(obj.state)) continue;
            if (candidateFilter && obj.candidate_id !== candidateFilter) continue;
            if (since && (!obj.at || new Date(obj.at) < since)) continue;
            if (until && (!obj.at || new Date(obj.at) > until)) continue;
            items.push(obj);
          } catch(_) { /* skip */ }
        }
        const nextCursor = i < lines.length ? Buffer.from(JSON.stringify({ index: i }), 'utf8').toString('base64') : null;

        if (format === 'ndjson') {
          res.set('Content-Type', 'application/x-ndjson');
          res.send(items.map(it => JSON.stringify(it)).join('\n'));
        } else {
          res.json({ items, next_cursor: nextCursor });
        }
      } catch (e) {
        this.logger.error('reply.list failed', { error: e.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    this.app.get('/v1/reply/export', requireAuth, async (req, res) => {
      try {
        req.query.format = 'json';
        const p = path.resolve(this._logsDir, 'reply_results.jsonl');
        let lines = [];
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          lines = raw.split('\n').filter(Boolean);
        }
        const states = String(req.query.state || '').split(',').map(s => s.trim()).filter(Boolean);
        const candidateFilter = String(req.query.candidate_id || '').trim();
        let limit = parseInt(String(req.query.limit || '100'), 10);
        if (!Number.isFinite(limit) || limit <= 0) limit = 100;
        if (limit > 1000) limit = 1000;

        const items = [];
        for (let i = 0; i < lines.length && items.length < limit; i++) {
          try {
            const obj = JSON.parse(lines[i]);
            if (states.length && !states.includes(obj.state)) continue;
            if (candidateFilter && obj.candidate_id !== candidateFilter) continue;
            items.push(obj);
          } catch(_) {}
        }

        const format = (String(req.query.format || 'csv').toLowerCase());
        if (format === 'ndjson') {
          res.set('Content-Type', 'application/x-ndjson');
          res.send(items.map(it => JSON.stringify(it)).join('\n'));
          return;
        }

        res.set('Content-Type', 'text/csv; charset=utf-8');
        const header = ['at','candidate_id','reply_ticket_id','state','reply','confidence','citation_count','needs_followup','triage_ticket_id'];
        const rows = [header.join(',')];
        for (const it of items) {
          const replyText = it.reply_result?.reply ? String(it.reply_result.reply).replace(/\r|\n|,/g, ' ') : '';
          const confidence = Number.isFinite(it.reply_result?.confidence) ? it.reply_result.confidence : '';
          const cites = Array.isArray(it.reply_result?.citations) ? it.reply_result.citations.length : 0;
          const needsFollowup = typeof it.reply_result?.needs_followup === 'boolean' ? it.reply_result.needs_followup : '';
          const row = [it.at || '', it.candidate_id || '', it.reply_ticket_id || '', it.state || '', replyText, confidence, cites, needsFollowup, it.triage_ticket_id || '']
            .map(v => typeof v === 'string' ? '"' + v.replace(/"/g, '""') + '"' : String(v));
          rows.push(row.join(','));
        }
        res.send(rows.join('\n'));
      } catch (e) {
        this.logger.error('reply.export failed', { error: e.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    this.app.get('/v1/reply/tickets/:id/raw', requireAuth, async (req, res) => {
      try {
        const ticketId = req.params.id;
        let found = null;
        for (const [cid, val] of this.replyIndex.entries()) {
          if (val.reply_ticket_id === ticketId) { found = { cid, val }; break; }
        }
        if (!found) return res.status(404).json({ error: 'NOT_FOUND' });
        const raw = found.val.last_raw_outputs || null;
        const redacted = raw ? JSON.parse(JSON.stringify(raw)) : null;
        const redactKeys = ['access_token','authorization','cookie','email'];
        if (redacted && typeof redacted === 'object') {
          for (const k of redactKeys) if (k in redacted) redacted[k] = '[REDACTED]';
        }
        res.json({ ticket_id: ticketId, candidate_id: found.cid, outputs: redacted });
      } catch (e) {
        this.logger.error('reply.raw failed', { error: e.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }
  
  setupErrorHandling() {
    this.app.use((error, req, res, next) => {
      this.logger.error('Unhandled error', { error: error.message, stack: error.stack });
      res.status(500).json({ error: 'Internal server error' });
    });
  }
  
  async createTicketFromEvent(event) {
    const ticketId = uuidv4();
    const flowId = this.selectFlow(event);
    
    const ticket = {
      id: ticketId,
      ticket_id: ticketId, // 為了測試相容性
      type: 'DraftTicket',
      status: 'pending',
      flow_id: flowId,
      event: event,
      context: {
        thread_id: event.thread_id,
        event_id: event.event_id
      },
      constraints: {
        lang: 'zh-tw',
        max_chars: 500
      },
      metadata: {
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        mode: this.isClientFilledFlow(flowId) ? 'client-filled' : 'auto-execute'
      }
    };
    
    await this.ticketStore.create(ticket);
    this.logger.info('Created ticket', { ticket_id: ticketId, flow_id: flowId, event_id: event.event_id, mode: ticket.metadata.mode });
    
    // 只有非 client-filled 模式才自動執行 DAG
    if (!this.isClientFilledFlow(flowId)) {
      setImmediate(() => this.executeDAG(ticket));
    }
    
    return ticket;
  }
  
  isClientFilledFlow(flowId) {
    // diagnostic_qa_tw 使用 client-filled 模式，等待 Extension 回填
    return flowId === 'diagnostic_qa_tw';
  }
  
  selectFlow(event) {
    // 根據事件類型選擇對應的流程
    if (event.type === 'diagnostic_qa') {
      return 'diagnostic_qa_tw';
    }
    // 預設流程
    return 'reply_basic_tw';
  }
  
  async executeDAG(ticket) {
    try {
      await this.ticketStore.updateStatus(ticket.id, 'in_progress');
      
      const flowSpec = this.flowRegistry.getFlow(ticket.flow_id);
      if (!flowSpec) {
        throw new Error(`Flow not found: ${ticket.flow_id}`);
      }
      
      const result = await this.dagExecutor.execute(flowSpec, ticket);
      
      await this.ticketStore.updateStatus(ticket.id, 'completed');
      this.logger.info('DAG execution completed', { ticket_id: ticket.id });
      
    } catch (error) {
      await this.ticketStore.updateStatus(ticket.id, 'failed');
      this.logger.error('DAG execution failed', { 
        ticket_id: ticket.id, 
        error: error.message 
      });
    }
  }
  
  async executeDAGAfterFill(ticket) {
    try {
      // client-filled 模式下，票據已有草稿，直接執行後續處理（如 guard、reply）
      await this.ticketStore.updateStatus(ticket.id, 'in_progress');
      
      const flowSpec = this.flowRegistry.getFlow(ticket.flow_id);
      if (!flowSpec) {
        throw new Error(`Flow not found: ${ticket.flow_id}`);
      }
      
      // 執行後續 DAG 步驟（跳過已完成的草稿生成）
      const result = await this.dagExecutor.execute(flowSpec, ticket);
      
      await this.ticketStore.updateStatus(ticket.id, 'completed');
      this.logger.info('Post-fill DAG execution completed', { ticket_id: ticket.id });
      
    } catch (error) {
      await this.ticketStore.updateStatus(ticket.id, 'failed');
      this.logger.error('Post-fill DAG execution failed', { 
        ticket_id: ticket.id, 
        error: error.message 
      });
    }
  }
  
  async getMetrics() {
    const totalTickets = await this.ticketStore.count();
    const pendingTickets = await this.ticketStore.count({ status: 'pending' });
    const completedTickets = await this.ticketStore.count({ status: 'completed' });
    const failedTickets = await this.ticketStore.count({ status: 'failed' });

    let replyPending = 0;
    let replyDone = 0;
    for (const val of this.replyIndex.values()) {
      if (val.state === 'DONE') replyDone++;
      else if (val.state === 'PENDING') replyPending++;
    }
    
    return {
      tickets: {
        total: totalTickets,
        pending: pendingTickets,
        completed: completedTickets,
        failed: failedTickets,
        success_rate: totalTickets > 0 ? completedTickets / totalTickets : 0
      },
      triage_rules: this.triageDefaults,
      snapshots: {
        triage: {
          snapshot_path: path.resolve(this._logsDir, 'triage_decisions.jsonl'),
          snapshots_written: this._snapshotsWritten,
          last_batch_source: this._lastBatchSource
        },
        reply: {
          snapshot_path: path.resolve(this._logsDir, 'reply_results.jsonl'),
          snapshots_written: this._replySnapshotsWritten,
          last_derive_source: this._lastReplyDeriveSource
        }
      },
      replies: {
        indexed: this.replyIndex.size,
        pending: replyPending,
        done: replyDone
      },
      timestamp: new Date().toISOString()
    };
  }
  
  async start() {
    if (REINDEX_ON_BOOT) {
      try {
        await this.reindexFromSnapshots();
      } catch (e) {
        this.logger?.warn?.('Warm reindex failed (continuing)', { error: String(e) });
      }
    } else {
      this.logger?.info?.('Warm reindex disabled via ORCH_REINDEX_ON_BOOT');
    }

    const server = this.app.listen(this.port, () => {
      this.logger.info(`Orchestrator started on port ${this.port}`);
      this.logger.info(`Dry run mode: ${this.dryRun}`);
    });

    if (TAIL_SNAPSHOTS) {
      try {
        this.followSnapshots();
      } catch (e) {
        this.logger?.warn?.('Tail follow setup failed', { error: String(e) });
      }
    } else {
      this.logger?.info?.('Tail-follow disabled via ORCH_TAIL_SNAPSHOTS');
    }

    return server;
  }
}

// 如果直接執行此檔案，則啟動服務
if (require.main === module) {
  const orchestrator = new Orchestrator();
  orchestrator.start().catch(err => {
    console.error('Failed to start orchestrator', err);
    process.exitCode = 1;
  });
  
  // 優雅關閉處理
  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    if (orchestrator._leaseReaper) clearInterval(orchestrator._leaseReaper);
    process.exit(0);
  });
}

module.exports = Orchestrator;