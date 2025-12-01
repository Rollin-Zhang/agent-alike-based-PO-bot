"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TicketWorker = void 0;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
const apiClient_1 = require("./apiClient");
const chatInvoker_1 = require("./chatInvoker");
const promptBuilder_1 = require("./promptBuilder");
class TicketWorker {
    constructor(logger, panelProvider) {
        this.isRunning = false;
        this.isRefilling = false;
        // Config
        this.baseWatchdogInterval = 5000;
        this.maxConcurrency = 2;
        this.batchSize = 3;
        this.useV1Lease = true;
        this.kinds = ['TRIAGE'];
        this.kindStrategy = 'triage_first';
        this.kindWeights = { TRIAGE: 7, REPLY: 3 };
        this.replyMaxChars = 320;
        // State
        this.rrIndex = 0;
        this.activeTickets = new Set();
        this.errors = [];
        this.logger = logger;
        this.panelProvider = panelProvider;
        this.apiClient = new apiClient_1.ApiClient(logger);
        this.chatInvoker = new chatInvoker_1.ChatInvoker(logger);
        this.updateConfig();
        this.configDisposable = config_1.Config.onDidChange(() => this.updateConfig());
    }
    /* ────────────────────────────── Lifecycle ───────────────────────────── */
    updateConfig() {
        const cfg = config_1.Config.get();
        this.baseWatchdogInterval = cfg.worker.pollIntervalMs;
        this.maxConcurrency = cfg.worker.concurrency;
        // @ts-ignore contributed in package.json
        this.batchSize = Math.max(1, Number(cfg.worker.batchSize || 3));
        this.useV1Lease = cfg.worker.useV1Lease;
        const configuredKinds = (cfg.worker.kinds && cfg.worker.kinds.length ? cfg.worker.kinds : ['TRIAGE']);
        this.kinds = Array.from(new Set(configuredKinds.filter((k) => k === 'TRIAGE' || k === 'REPLY')));
        if (this.kinds.length === 0)
            this.kinds = ['TRIAGE'];
        this.kindStrategy = cfg.worker.kindStrategy;
        this.kindWeights = {
            TRIAGE: Math.max(0, cfg.worker.kindWeights?.TRIAGE ?? 7),
            REPLY: Math.max(0, cfg.worker.kindWeights?.REPLY ?? 3),
        };
        this.replyMaxChars = Math.max(80, Number(cfg.reply.maxChars || 320));
        this.rrIndex = 0;
        this.logger.debug('Worker configuration updated', {
            watchdogIntervalMs: this.baseWatchdogInterval,
            concurrency: this.maxConcurrency,
            batchSize: this.batchSize,
            useV1Lease: this.useV1Lease,
            kinds: this.kinds,
            kindStrategy: this.kindStrategy,
            kindWeights: this.kindWeights,
            replyMaxChars: this.replyMaxChars,
        });
    }
    start() {
        if (this.isRunning) {
            this.logger.warn('Worker is already running');
            return;
        }
        this.isRunning = true;
        const hostInfo = {
            hostName: vscode.env.appName,
            hostVersion: vscode.version,
            language: vscode.env.language,
            sessionId: vscode.env.sessionId,
            timestamp: new Date().toISOString(),
        };
        const cfg = config_1.Config.get();
        this.logger.info('PO Bot Extension starting (event-driven)', {
            ...hostInfo,
            orchestratorBaseUrl: cfg.orchestrator.baseUrl,
            watchdogInterval: this.baseWatchdogInterval,
            concurrency: this.maxConcurrency,
            batchSize: this.batchSize,
            kinds: this.kinds,
            kindStrategy: this.kindStrategy,
        });
        void this.tryRefillImmediately('startup');
        this.startWatchdog();
    }
    stop() {
        if (!this.isRunning)
            return;
        this.isRunning = false;
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }
        this.logger.info('Stopped ticket worker');
    }
    startWatchdog() {
        const interval = Math.max(2000, Math.min(15000, this.baseWatchdogInterval || 5000));
        if (this.watchdogTimer)
            clearInterval(this.watchdogTimer);
        this.watchdogTimer = setInterval(() => {
            if (!this.isRunning)
                return;
            void this.tryRefillImmediately('watchdog');
        }, interval);
        this.logger.debug('Watchdog started', { intervalMs: interval });
    }
    /* ────────────────────────────── Refill / Lease ───────────────────────────── */
    async tryRefillImmediately(trigger = 'onFinish') {
        if (!this.isRunning)
            return;
        const slots = this.maxConcurrency - this.activeTickets.size;
        if (slots <= 0 || this.isRefilling) {
            this.logger.debug(slots <= 0 ? 'No available slots; skip refill' : 'Refill already in-flight', {
                active: this.activeTickets.size, max: this.maxConcurrency, trigger
            });
            return;
        }
        this.isRefilling = true;
        this.lastPollTime = new Date();
        try {
            const leased = await this.leaseBatch(Math.min(slots, this.batchSize));
            if (leased.length === 0) {
                this.logger.debug('No tickets leased', { trigger });
                return;
            }
            this.logger.info('🎫 Leasing success', { trigger, leased: leased.length });
            for (const t of leased) {
                void this.processTicket(t).catch(err => {
                    this.logger.error(`Failed to process ticket ${t.ticket_id || t.id}`, err);
                    const classified = this.classifyError(err);
                    classified.ticketId = t.ticket_id || t.id;
                    this.recordError(classified);
                });
            }
        }
        finally {
            this.isRefilling = false;
            this.updatePanel();
        }
    }
    async leaseBatch(n) {
        const out = [];
        for (let i = 0; i < n; i++) {
            const kind = this.decideNextKind();
            const t = await this.leaseOne(kind);
            if (t) {
                out.push(t);
                this.logger.info('Leased ticket slot', { kind, ticketId: t.ticket_id });
            }
        }
        return out;
    }
    decideNextKind() {
        const active = (this.kinds.length ? this.kinds : ['TRIAGE']);
        if (active.length === 1)
            return active[0];
        const strategies = {
            reply_first: () => (active.includes('REPLY') ? 'REPLY' : 'TRIAGE'),
            triage_first: () => (active.includes('TRIAGE') ? 'TRIAGE' : 'REPLY'),
            round_robin: () => {
                const k = active[this.rrIndex % active.length];
                this.rrIndex = (this.rrIndex + 1) % active.length;
                return k;
            },
            weighted: () => {
                const ws = active.map(k => Math.max(0, this.kindWeights[k] || 0));
                const total = ws.reduce((a, b) => a + b, 0);
                if (total <= 0)
                    return active.includes('TRIAGE') ? 'TRIAGE' : 'REPLY';
                let roll = Math.random() * total;
                for (let i = 0; i < active.length; i++) {
                    if (roll < ws[i])
                        return active[i];
                    roll -= ws[i];
                }
                return active[0];
            }
        };
        return strategies[this.kindStrategy]();
    }
    async leaseOne(kind) {
        try {
            const acquired = this.useV1Lease
                ? await this.apiClient.leaseTicketsV1(kind, 1, 90, ['llm.generate'])
                : await this.apiClient.leaseTickets({ limit: 1, lease_sec: 90, capabilities: ['llm.generate'], kind });
            if (acquired && acquired.length > 0) {
                const t = acquired[0];
                if (!t.metadata)
                    t.metadata = {};
                t.metadata.kind = kind;
                return t;
            }
        }
        catch (e) {
            this.logger.debug(`Lease error (${kind})`, e);
        }
        return undefined;
    }
    /* ────────────────────────────── Processing (文本路線) ───────────────────────────── */
    async processTicket(ticket) {
        const ticketId = ticket.ticket_id || ticket.id;
        if (this.activeTickets.has(ticketId)) {
            this.logger.warn(`Ticket ${ticketId} is already being processed`);
            return;
        }
        this.activeTickets.add(ticketId);
        const startTime = Date.now();
        this.logger.info('Ticket state transition', {
            ticketId,
            fromStatus: ticket.status,
            toStatus: 'processing',
            transition: 'pending → processing',
            flowId: ticket.flow_id,
            eventType: ticket.event.type,
            timestamp: new Date().toISOString(),
        });
        try {
            const proc = new TicketProcessor({
                ticket,
                apiClient: this.apiClient,
                chatInvoker: this.chatInvoker,
                logger: this.logger,
                replyMaxChars: this.replyMaxChars,
            });
            const result = await proc.run();
            if (result.status === 'failed') {
                if (result.retryable) {
                    try {
                        await this.apiClient.nackTicket(ticketId);
                        this.logger.info('Ticket released for retry', { ticketId, reason: result.reason });
                    }
                    catch (e) {
                        this.logger.debug(`Failed to nack ticket ${ticketId}`, e);
                    }
                }
                else {
                    await this.markFailed(ticketId, result.reason || 'NON_RETRYABLE_ERROR');
                }
                return;
            }
            const processingTime = Date.now() - startTime;
            this.logger.info('Ticket state transition', {
                ticketId,
                fromStatus: 'processing',
                toStatus: 'drafted',
                transition: 'processing → drafted',
                processingTimeMs: processingTime,
                timestamp: new Date().toISOString(),
            });
        }
        catch (error) {
            const processingError = this.classifyError(error);
            processingError.ticketId = ticketId;
            this.logger.error('Ticket state transition', {
                ticketId,
                fromStatus: 'processing',
                toStatus: 'failed',
                transition: 'processing → failed',
                errorType: processingError.type,
                errorCode: this.getErrorCode(processingError),
                retryable: processingError.retryable,
                error: processingError.message,
                timestamp: new Date().toISOString()
            });
            if (processingError.type === 'conflict') {
                this.logger.info(`Ticket ${ticketId} processed by another worker`);
            }
            else if (processingError.retryable) {
                try {
                    await this.apiClient.nackTicket(ticketId);
                    this.logger.info('Ticket released for retry', { ticketId, errorType: processingError.type });
                }
                catch (nackError) {
                    this.logger.debug(`Failed to nack ticket ${ticketId}`, nackError);
                }
            }
            else {
                await this.markFailed(ticketId, 'NON_RETRYABLE_ERROR', processingError.message);
            }
            this.recordError(processingError);
            throw processingError;
        }
        finally {
            this.activeTickets.delete(ticketId);
            this.onTicketFinished();
        }
    }
    onTicketFinished() {
        this.updatePanel();
        void this.tryRefillImmediately('onFinish');
    }
    /* ────────────────────────────── Error & misc ───────────────────────────── */
    getErrorCode(error) {
        switch (error.type) {
            case 'network': return 'ERR_NETWORK_TIMEOUT';
            case 'rate_limit': return 'ERR_RATE_LIMIT';
            case 'conflict': return 'ERR_CONFLICT';
            case 'validation': return 'ERR_VALIDATION';
            case 'timeout': return 'ERR_MODEL_TIMEOUT';
            default: return 'ERR_UNKNOWN';
        }
    }
    classifyError(error) {
        if (error && typeof error === 'object' && 'type' in error)
            return error;
        if (error instanceof promptBuilder_1.UnsupportedTicketKindError || (error && error.code === 'UNSUPPORTED_TICKET_KIND')) {
            return { type: 'validation', message: 'Unsupported ticket kind', retryable: false };
        }
        if (error instanceof Error) {
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('conflict') || msg.includes('409'))
                return { type: 'conflict', message: 'Version conflict', retryable: false };
            if (msg.includes('timeout'))
                return { type: 'timeout', message: 'Request timeout', retryable: true };
            if (msg.includes('rate limit') || msg.includes('429'))
                return { type: 'rate_limit', message: 'Rate limit exceeded', retryable: true };
            if (msg.includes('validation'))
                return { type: 'validation', message: error.message, retryable: false };
            return { type: 'unknown', message: error.message, retryable: true };
        }
        return { type: 'unknown', message: 'Unknown error', retryable: true };
    }
    recordError(error) {
        this.errors.push({ ...error, timestamp: new Date() });
        if (this.errors.length > 50)
            this.errors = this.errors.slice(-50);
    }
    async markFailed(ticketId, reason, detail) {
        const anyClient = this.apiClient;
        try {
            if (typeof anyClient.markTicketFailed === 'function') {
                await anyClient.markTicketFailed(ticketId, { reason, detail });
                this.logger.info('Ticket marked as failed via ApiClient.markTicketFailed', { ticketId, reason });
                return;
            }
            if (typeof anyClient.post === 'function') {
                await anyClient.post(`/tickets/${ticketId}/fail`, { reason, detail });
                this.logger.info('Ticket marked as failed via ApiClient.post(/fail)', { ticketId, reason });
                return;
            }
            this.logger.warn('No fail endpoint available in ApiClient; please implement markTicketFailed()', { ticketId, reason });
        }
        catch (e) {
            this.logger.error('Failed to mark ticket as failed', { ticketId, reason, error: e?.message });
        }
    }
    updatePanel() {
        if (this.panelProvider && typeof this.panelProvider.refresh === 'function') {
            this.panelProvider.refresh();
        }
    }
    getStatus() {
        return {
            isRunning: this.isRunning,
            pollInterval: this.baseWatchdogInterval,
            activeTickets: this.activeTickets.size,
            lastPollTime: this.lastPollTime,
            errors: this.errors.slice(-10),
        };
    }
    async triggerPoll() {
        if (!this.isRunning)
            throw new Error('Worker is not running');
        this.logger.info('Manual refill triggered');
        await this.tryRefillImmediately('watchdog');
    }
    dispose() {
        this.stop();
        this.configDisposable.dispose();
        this.logger.info('Ticket worker disposed');
    }
}
exports.TicketWorker = TicketWorker;
class TicketProcessor {
    constructor({ ticket, apiClient, chatInvoker, logger, replyMaxChars }) {
        this.t = ticket;
        this.api = apiClient;
        this.chat = chatInvoker;
        this.logger = logger;
        this.replyMaxChars = replyMaxChars;
    }
    async run() {
        const kind = this.resolveKind(this.t);
        if (kind === 'UNKNOWN')
            return { status: 'failed', retryable: false, reason: 'UNSUPPORTED_TICKET_KIND' };
        let prompt;
        try {
            prompt = promptBuilder_1.PromptBuilder.buildPrompt(this.t);
        }
        catch (e) {
            if (e instanceof promptBuilder_1.UnsupportedTicketKindError || e?.code === 'UNSUPPORTED_TICKET_KIND') {
                return { status: 'failed', retryable: false, reason: 'UNSUPPORTED_TICKET_KIND' };
            }
            throw e;
        }
        const maxChars = this.getMaxChars(this.t, kind);
        const modelResp = await this.chat.invokeChatModel(prompt, {
            maxTokens: maxChars * 2,
            temperature: 0.7,
            timeout: 30000,
        });
        const parsed = this.parseAndValidate(kind, modelResp?.text ?? '', maxChars);
        if (!parsed.ok)
            return { status: 'failed', retryable: false, reason: 'VALIDATION_ERROR' };
        const finalText = kind === 'REPLY' ? (parsed.value.reply ?? '') : JSON.stringify(parsed.value);
        const confidence = this.computeConfidence(modelResp, finalText);
        await this.fill(kind, parsed.value, {
            confidence,
            model_info: {
                host: vscode.env.appName,
                provider: modelResp?.provider || 'vscode.lm',
                model: modelResp?.modelId || modelResp?.modelName || 'unknown',
                latency_ms: modelResp?.latencyMs ?? 0,
                prompt_tokens: modelResp?.usage?.promptTokens ?? 0,
                completion_tokens: modelResp?.usage?.completionTokens ?? 0,
            },
            // 有些 orchestrator 沒 version；保守傳遞
            ticket_version: this.t?.version ?? undefined,
        });
        return { status: 'drafted' };
    }
    resolveKind(t) {
        const configured = (t.metadata && t.metadata.kind);
        const isReply = configured === 'REPLY' ||
            t.flow_id === 'reply_zh_hant_v1' ||
            t.event.type === 'reply_request' ||
            t.event.type === 'reply_candidate';
        if (isReply)
            return 'REPLY';
        if (configured === 'TRIAGE' || t.flow_id === 'triage_zh_hant_v1' || t.event.type === 'triage_candidate') {
            return 'TRIAGE';
        }
        return 'UNKNOWN';
    }
    getMaxChars(t, kind) {
        const rawMax = Number(t?.constraints?.max_chars) || (kind === 'REPLY' ? this.replyMaxChars : 320);
        return kind === 'REPLY' ? Math.min(rawMax, this.replyMaxChars) : rawMax;
    }
    parseAndValidate(kind, rawText, maxChars) {
        if (kind === 'TRIAGE') {
            const triage = TicketProcessor.validateTriage(rawText);
            if (!triage.valid)
                return { ok: false };
            return { ok: true, value: triage.parsed };
        }
        // === REPLY：純文本 → 文本級 gate
        const text = (rawText ?? '').toString().trim();
        if (!text)
            return { ok: false };
        const gate = promptBuilder_1.PromptBuilder.validateResponse(text, {
            lang: this.t?.constraints?.lang,
            maxChars,
        });
        if (!gate.valid)
            return { ok: false };
        return { ok: true, value: { reply: promptBuilder_1.PromptBuilder.validateAndTrimResponse(text, maxChars) } };
    }
    computeConfidence(modelResponse, finalText) {
        let c = 0.5;
        if ((modelResponse?.latencyMs ?? 0) < 2000)
            c += 0.1;
        else if ((modelResponse?.latencyMs ?? 0) > 10000)
            c -= 0.1;
        const n = (finalText ?? '').length;
        if (n > 50 && n < 300)
            c += 0.1;
        else if (n < 20)
            c -= 0.2;
        if (finalText.includes('？') || finalText.includes('澄清'))
            c += 0.1;
        if (finalText.includes('確認') || finalText.includes('內部'))
            c += 0.1;
        if (!/[。！？]$/.test(finalText))
            c -= 0.1;
        if (finalText.includes('...'))
            c -= 0.1;
        return Math.max(0.1, Math.min(0.95, c));
    }
    async fill(kind, parsed, base) {
        if (kind === 'TRIAGE') {
            const decision = String(parsed.decision || '').toUpperCase();
            const should_reply = decision === 'APPROVE';
            const outputs = {
                decision,
                should_reply,
                topics: parsed.reasons || [],
                sentiment: 'neutral',
                risk_tags: [],
                priority: should_reply ? 'P1' : 'P2',
                short_reason: parsed.summary || '',
            };
            await this.api.fillTicketV1(this.t.ticket_id || this.t.id, {
                outputs,
                by: `${base.model_info.provider}:${base.model_info.model}`,
                tokens: { input: base.model_info.prompt_tokens, output: base.model_info.completion_tokens },
            });
            return;
        }
        // === REPLY：把純文本包成 reply_result ===
        const maxChars = this.getMaxChars(this.t, 'REPLY');
        const replyText = promptBuilder_1.PromptBuilder.validateAndTrimResponse(parsed.reply || '', maxChars);
        const outputs = {
            reply: replyText,
            confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : base.confidence,
            citations: Array.isArray(parsed.citations) ? parsed.citations : [],
            hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
            tone_tags: Array.isArray(parsed.tone_tags) ? parsed.tone_tags : [],
            needs_followup: typeof parsed.needs_followup === 'boolean' ? parsed.needs_followup : false,
            followup_notes: typeof parsed.followup_notes === 'string' ? parsed.followup_notes : '',
        };
        await this.api.fillTicketV1(this.t.ticket_id || this.t.id, {
            outputs,
            by: `${base.model_info.provider}:${base.model_info.model}`,
            tokens: { input: base.model_info.prompt_tokens, output: base.model_info.completion_tokens },
        });
    }
    /* 暫時 triage 驗證，等 triage.yaml schema 定案後替換 */
    static validateTriage(raw) {
        const errors = [];
        const text = (raw ?? '').toString().trim();
        let obj;
        try {
            obj = JSON.parse(text);
        }
        catch {
            return { valid: false, errors: ['JSON 解析失敗'] };
        }
        const validDecision = ['APPROVE', 'SKIP', 'FLAG'];
        if (!validDecision.includes((obj?.decision || '').toUpperCase()))
            errors.push('decision 值不合法');
        if (typeof obj?.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1)
            errors.push('confidence 範圍錯誤');
        if (!Array.isArray(obj?.reasons))
            errors.push('reasons 必須為陣列');
        if (typeof obj?.summary !== 'string' || obj.summary.trim().length < 4)
            errors.push('summary 太短');
        if (!obj?.signals || typeof obj.signals !== 'object')
            errors.push('signals 缺失');
        return { valid: errors.length === 0, errors, parsed: obj };
    }
}
//# sourceMappingURL=ticketWorker.js.map