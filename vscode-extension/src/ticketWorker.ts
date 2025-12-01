import * as vscode from 'vscode';
import { Logger } from './logger';
import { Config } from './config';
import { ApiClient } from './apiClient';
import { ChatInvoker } from './chatInvoker';
import { PromptBuilder, UnsupportedTicketKindError } from './promptBuilder';
import { Ticket, ProcessingError, WorkerStatus, FillRequest } from './types';

type Kind = 'TRIAGE' | 'REPLY';

export class TicketWorker implements vscode.Disposable {
  private logger: Logger;
  private apiClient: ApiClient;
  private chatInvoker: ChatInvoker;
  private panelProvider: any; // TicketPanel, avoid circular dep

  private isRunning = false;
  private watchdogTimer: NodeJS.Timeout | undefined;
  private isRefilling = false;

  // Config
  private baseWatchdogInterval = 5000;
  private maxConcurrency = 2;
  private batchSize = 3;
  private useV1Lease = true;
  private kinds: Kind[] = ['TRIAGE'];
  private kindStrategy: 'triage_first' | 'reply_first' | 'round_robin' | 'weighted' = 'triage_first';
  private kindWeights: Record<Kind, number> = { TRIAGE: 7, REPLY: 3 };
  private replyMaxChars = 320;

  // State
  private rrIndex = 0;
  private activeTickets: Set<string> = new Set();
  private errors: ProcessingError[] = [];
  private lastPollTime?: Date;

  private configDisposable: vscode.Disposable;

  constructor(logger: Logger, panelProvider?: any) {
    this.logger = logger;
    this.panelProvider = panelProvider;
    this.apiClient = new ApiClient(logger);
    this.chatInvoker = new ChatInvoker(logger);
    this.updateConfig();
    this.configDisposable = Config.onDidChange(() => this.updateConfig());
  }

  /* ────────────────────────────── Lifecycle ───────────────────────────── */

  private updateConfig(): void {
    const cfg = Config.get();
    this.baseWatchdogInterval = cfg.worker.pollIntervalMs;
    this.maxConcurrency = cfg.worker.concurrency;
    // @ts-ignore contributed in package.json
    this.batchSize = Math.max(1, Number(cfg.worker.batchSize || 3));
    this.useV1Lease = cfg.worker.useV1Lease;

    const configuredKinds = (cfg.worker.kinds && cfg.worker.kinds.length ? cfg.worker.kinds : ['TRIAGE']) as Kind[];
    this.kinds = Array.from(new Set(configuredKinds.filter((k): k is Kind => k === 'TRIAGE' || k === 'REPLY')));
    if (this.kinds.length === 0) this.kinds = ['TRIAGE'];

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

  start(): void {
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
    const cfg = Config.get();
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

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    this.logger.info('Stopped ticket worker');
  }

  private startWatchdog(): void {
    const interval = Math.max(2000, Math.min(15000, this.baseWatchdogInterval || 5000));
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (!this.isRunning) return;
      void this.tryRefillImmediately('watchdog');
    }, interval);
    this.logger.debug('Watchdog started', { intervalMs: interval });
  }

  /* ────────────────────────────── Refill / Lease ───────────────────────────── */

  private async tryRefillImmediately(trigger: 'startup' | 'onFinish' | 'watchdog' = 'onFinish'): Promise<void> {
    if (!this.isRunning) return;

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
          this.logger.error(`Failed to process ticket ${(t as any).ticket_id || t.id}`, err);
          const classified = this.classifyError(err);
          classified.ticketId = (t as any).ticket_id || t.id;
          this.recordError(classified);
        });
      }
    } finally {
      this.isRefilling = false;
      this.updatePanel();
    }
  }

  private async leaseBatch(n: number): Promise<Ticket[]> {
    const out: Ticket[] = [];
    for (let i = 0; i < n; i++) {
      const kind = this.decideNextKind();
      const t = await this.leaseOne(kind);
      if (t) {
        out.push(t);
        this.logger.info('Leased ticket slot', { kind, ticketId: (t as any).ticket_id });
      }
    }
    return out;
  }

  private decideNextKind(): Kind {
    const active = (this.kinds.length ? this.kinds : ['TRIAGE']) as Kind[];
    if (active.length === 1) return active[0];

    const strategies: Record<typeof this.kindStrategy, () => Kind> = {
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
        if (total <= 0) return active.includes('TRIAGE') ? 'TRIAGE' : 'REPLY';
        let roll = Math.random() * total;
        for (let i = 0; i < active.length; i++) {
          if (roll < ws[i]) return active[i];
          roll -= ws[i];
        }
        return active[0];
      }
    };

    return strategies[this.kindStrategy]();
  }

  private async leaseOne(kind: Kind): Promise<Ticket | undefined> {
    try {
      const acquired = this.useV1Lease
        ? await this.apiClient.leaseTicketsV1(kind, 1, 90, ['llm.generate'])
        : await this.apiClient.leaseTickets({ limit: 1, lease_sec: 90, capabilities: ['llm.generate'], kind });

      if (acquired && acquired.length > 0) {
        const t = acquired[0];
        if (!t.metadata) t.metadata = {} as any;
        (t.metadata as any).kind = kind;
        return t;
      }
    } catch (e) {
      this.logger.debug(`Lease error (${kind})`, e);
    }
    return undefined;
  }

  /* ────────────────────────────── Processing (文本路線) ───────────────────────────── */

  private async processTicket(ticket: Ticket): Promise<void> {
    const ticketId = (ticket as any).ticket_id || ticket.id;
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
          } catch (e) {
            this.logger.debug(`Failed to nack ticket ${ticketId}`, e);
          }
        } else {
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

    } catch (error) {
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
      } else if (processingError.retryable) {
        try {
          await this.apiClient.nackTicket(ticketId);
          this.logger.info('Ticket released for retry', { ticketId, errorType: processingError.type });
        } catch (nackError) {
          this.logger.debug(`Failed to nack ticket ${ticketId}`, nackError);
        }
      } else {
        await this.markFailed(ticketId, 'NON_RETRYABLE_ERROR', processingError.message);
      }

      this.recordError(processingError);
      throw processingError;

    } finally {
      this.activeTickets.delete(ticketId);
      this.onTicketFinished();
    }
  }

  private onTicketFinished(): void {
    this.updatePanel();
    void this.tryRefillImmediately('onFinish');
  }

  /* ────────────────────────────── Error & misc ───────────────────────────── */

  private getErrorCode(error: ProcessingError): string {
    switch (error.type) {
      case 'network':    return 'ERR_NETWORK_TIMEOUT';
      case 'rate_limit': return 'ERR_RATE_LIMIT';
      case 'conflict':   return 'ERR_CONFLICT';
      case 'validation': return 'ERR_VALIDATION';
      case 'timeout':    return 'ERR_MODEL_TIMEOUT';
      default:           return 'ERR_UNKNOWN';
    }
  }

  private classifyError(error: any): ProcessingError {
    if (error && typeof error === 'object' && 'type' in error) return error as ProcessingError;
    if (error instanceof UnsupportedTicketKindError || (error && error.code === 'UNSUPPORTED_TICKET_KIND')) {
      return { type: 'validation', message: 'Unsupported ticket kind', retryable: false };
    }
    if (error instanceof Error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('conflict') || msg.includes('409'))  return { type: 'conflict', message: 'Version conflict', retryable: false };
      if (msg.includes('timeout'))                           return { type: 'timeout', message: 'Request timeout', retryable: true };
      if (msg.includes('rate limit') || msg.includes('429')) return { type: 'rate_limit', message: 'Rate limit exceeded', retryable: true };
      if (msg.includes('validation'))                        return { type: 'validation', message: error.message, retryable: false };
      return { type: 'unknown', message: error.message, retryable: true };
    }
    return { type: 'unknown', message: 'Unknown error', retryable: true };
  }

  private recordError(error: ProcessingError): void {
    this.errors.push({ ...error, timestamp: new Date() } as any);
    if (this.errors.length > 50) this.errors = this.errors.slice(-50);
  }

  private async markFailed(ticketId: string, reason: string, detail?: any): Promise<void> {
    const anyClient = this.apiClient as any;
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
    } catch (e) {
      this.logger.error('Failed to mark ticket as failed', { ticketId, reason, error: (e as Error)?.message });
    }
  }

  private updatePanel(): void {
    if (this.panelProvider && typeof this.panelProvider.refresh === 'function') {
      this.panelProvider.refresh();
    }
  }

  getStatus(): WorkerStatus {
    return {
      isRunning: this.isRunning,
      pollInterval: this.baseWatchdogInterval,
      activeTickets: this.activeTickets.size,
      lastPollTime: this.lastPollTime,
      errors: this.errors.slice(-10),
    };
  }

  async triggerPoll(): Promise<void> {
    if (!this.isRunning) throw new Error('Worker is not running');
    this.logger.info('Manual refill triggered');
    await this.tryRefillImmediately('watchdog');
  }

  dispose(): void {
    this.stop();
    this.configDisposable.dispose();
    this.logger.info('Ticket worker disposed');
  }
}

/* ────────────────────────────── Ticket Processor ───────────────────────────── */

type ProcessorDeps = {
  ticket: Ticket;
  apiClient: ApiClient;
  chatInvoker: ChatInvoker;
  logger: Logger;
  replyMaxChars: number;
};

type RunResult =
  | { status: 'drafted' }
  | { status: 'failed'; retryable: boolean; reason?: string };

class TicketProcessor {
  private t: Ticket;
  private api: ApiClient;
  private chat: ChatInvoker;
  private logger: Logger;
  private replyMaxChars: number;

  constructor({ ticket, apiClient, chatInvoker, logger, replyMaxChars }: ProcessorDeps) {
    this.t = ticket;
    this.api = apiClient;
    this.chat = chatInvoker;
    this.logger = logger;
    this.replyMaxChars = replyMaxChars;
  }

  async run(): Promise<RunResult> {
    const kind = this.resolveKind(this.t);
    if (kind === 'UNKNOWN') return { status: 'failed', retryable: false, reason: 'UNSUPPORTED_TICKET_KIND' };

    let prompt: string;
    try {
      prompt = PromptBuilder.buildPrompt(this.t);
    } catch (e: any) {
      if (e instanceof UnsupportedTicketKindError || e?.code === 'UNSUPPORTED_TICKET_KIND') {
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
    if (!parsed.ok) return { status: 'failed', retryable: false, reason: 'VALIDATION_ERROR' };

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
      ticket_version: (this.t as any)?.version ?? undefined,
    });

    return { status: 'drafted' };
  }

  private resolveKind(t: Ticket): Kind | 'UNKNOWN' {
    const configured = (t.metadata && (t.metadata as any).kind) as Kind | undefined;
    const isReply =
      configured === 'REPLY' ||
      t.flow_id === 'reply_zh_hant_v1' ||
      t.event.type === 'reply_request' ||
      t.event.type === 'reply_candidate';

    if (isReply) return 'REPLY';
    if (configured === 'TRIAGE' || t.flow_id === 'triage_zh_hant_v1' || t.event.type === 'triage_candidate') {
      return 'TRIAGE';
    }
    return 'UNKNOWN';
  }

  private getMaxChars(t: Ticket, kind: Kind): number {
    const rawMax = Number((t as any)?.constraints?.max_chars) || (kind === 'REPLY' ? this.replyMaxChars : 320);
    return kind === 'REPLY' ? Math.min(rawMax, this.replyMaxChars) : rawMax;
  }

  private parseAndValidate(kind: Kind, rawText: string, maxChars: number):
    | { ok: true; value: any }
    | { ok: false } {
    if (kind === 'TRIAGE') {
      const triage = TicketProcessor.validateTriage(rawText);
      if (!triage.valid) return { ok: false };
      return { ok: true, value: triage.parsed };
    }

    // === REPLY：純文本 → 文本級 gate
    const text = (rawText ?? '').toString().trim();
    if (!text) return { ok: false };

    const gate = PromptBuilder.validateResponse(text, {
      lang: (this.t as any)?.constraints?.lang,
      maxChars,
    });
    if (!gate.valid) return { ok: false };

    return { ok: true, value: { reply: PromptBuilder.validateAndTrimResponse(text, maxChars) } };
  }

  private computeConfidence(modelResponse: any, finalText: string): number {
    let c = 0.5;
    if ((modelResponse?.latencyMs ?? 0) < 2000) c += 0.1;
    else if ((modelResponse?.latencyMs ?? 0) > 10000) c -= 0.1;

    const n = (finalText ?? '').length;
    if (n > 50 && n < 300) c += 0.1;
    else if (n < 20) c -= 0.2;

    if (finalText.includes('？') || finalText.includes('澄清')) c += 0.1;
    if (finalText.includes('確認') || finalText.includes('內部')) c += 0.1;
    if (!/[。！？]$/.test(finalText)) c -= 0.1;
    if (finalText.includes('...')) c -= 0.1;

    return Math.max(0.1, Math.min(0.95, c));
  }

  private async fill(kind: Kind, parsed: any, base: Omit<FillRequest, 'draft'>): Promise<void> {
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
      await this.api.fillTicketV1((this.t as any).ticket_id || this.t.id, {
        outputs,
        by: `${base.model_info.provider}:${base.model_info.model}`,
        tokens: { input: base.model_info.prompt_tokens, output: base.model_info.completion_tokens },
      });
      return;
    }

    // === REPLY：把純文本包成 reply_result ===
    const maxChars = this.getMaxChars(this.t, 'REPLY');
    const replyText = PromptBuilder.validateAndTrimResponse(parsed.reply || '', maxChars);

    const outputs = {
      reply: replyText,
      confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : base.confidence,
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
      tone_tags: Array.isArray(parsed.tone_tags) ? parsed.tone_tags : [],
      needs_followup: typeof parsed.needs_followup === 'boolean' ? parsed.needs_followup : false,
      followup_notes: typeof parsed.followup_notes === 'string' ? parsed.followup_notes : '',
    };

    await this.api.fillTicketV1((this.t as any).ticket_id || this.t.id, {
      outputs,
      by: `${base.model_info.provider}:${base.model_info.model}`,
      tokens: { input: base.model_info.prompt_tokens, output: base.model_info.completion_tokens },
    });
  }

  /* 暫時 triage 驗證，等 triage.yaml schema 定案後替換 */
  private static validateTriage(raw: string): { valid: boolean; errors: string[]; parsed?: any } {
    const errors: string[] = [];
    const text = (raw ?? '').toString().trim();
    let obj: any;
    try { obj = JSON.parse(text); } catch { return { valid: false, errors: ['JSON 解析失敗'] }; }

    const validDecision = ['APPROVE','SKIP','FLAG'];
    if (!validDecision.includes((obj?.decision || '').toUpperCase())) errors.push('decision 值不合法');
    if (typeof obj?.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) errors.push('confidence 範圍錯誤');
    if (!Array.isArray(obj?.reasons)) errors.push('reasons 必須為陣列');
    if (typeof obj?.summary !== 'string' || obj.summary.trim().length < 4) errors.push('summary 太短');
    if (!obj?.signals || typeof obj.signals !== 'object') errors.push('signals 缺失');

    return { valid: errors.length === 0, errors, parsed: obj };
  }
}