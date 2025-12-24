import * as vscode from 'vscode';
import { Logger } from './logger';
import { Config } from './config';
import { ApiClient } from './apiClient';
import { ChatInvoker } from './chatInvoker';
// [FIX] 導入 LoadedSpec
import { PromptBuilder, LoadedSpec } from './promptBuilder';
import { Ticket, ProcessingError, WorkerStatus } from './types';

type Kind = 'TRIAGE' | 'REPLY';

export class TicketWorker implements vscode.Disposable {
  private logger: Logger;
  private apiClient: ApiClient;
  private chatInvoker: ChatInvoker;
  private panelProvider: any;

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
  private activeTickets: Set<string> = new Set();
  private errors: ProcessingError[] = [];
  private lastPollTime?: Date;
  private rrIndex = 0; // for round_robin

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
    // @ts-ignore
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
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('TicketWorker started');
    void this.tryRefillImmediately('startup');
    this.startWatchdog();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.logger.info('TicketWorker stopped');
  }

  private startWatchdog(): void {
    const interval = Math.max(2000, Math.min(15000, this.baseWatchdogInterval || 5000));
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (!this.isRunning) return;
      void this.tryRefillImmediately('watchdog');
    }, interval);
  }

  /* ────────────────────────────── Lease Logic ───────────────────────────── */

  private async tryRefillImmediately(trigger: string): Promise<void> {
    if (!this.isRunning) return;
    const slots = this.maxConcurrency - this.activeTickets.size;
    if (slots <= 0 || this.isRefilling) return;

    this.isRefilling = true;
    this.lastPollTime = new Date();

    try {
      const batch = Math.min(slots, this.batchSize);
      const leased = await this.leaseBatch(batch);
      
      if (leased.length > 0) {
        // [LOG] 只有真的領到票才印出，避免洗版
        for (const t of leased) {
          void this.processTicket(t).catch(err => {
            this.logger.error(`Unhandled process error ticket=${t.id}`, err);
          });
        }
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
      if (t) out.push(t);
    }
    return out;
  }

  private decideNextKind(): Kind {
    const active = this.kinds;
    if (!active.length) return 'TRIAGE';
    if (active.length === 1) return active[0];
    const k = active[this.rrIndex % active.length];
    this.rrIndex = (this.rrIndex + 1) % active.length;
    return k;
  }

  private async leaseOne(kind: Kind): Promise<Ticket | undefined> {
    try {
      const caps = ['llm.generate'];
      const leaseSec = 300; 

      const acquired = this.useV1Lease
        ? await this.apiClient.leaseTicketsV1(kind, 1, leaseSec, caps)
        : await this.apiClient.leaseTickets({ limit: 1, lease_sec: leaseSec, capabilities: caps, kind });

      if (acquired && acquired.length > 0) {
        const t = acquired[0];
        if (!t.metadata) t.metadata = {} as any;
        (t.metadata as any).kind = kind;
        return t;
      }
    } catch (e) { /* ignore */ }
    return undefined;
  }

  /* ────────────────────────────── Processing ───────────────────────────── */

  private async processTicket(ticket: Ticket): Promise<void> {
    const ticketId = (ticket as any).ticket_id || ticket.id;
    if (this.activeTickets.has(ticketId)) return;
    this.activeTickets.add(ticketId);

    // [LOG] 加入生命週期日誌：開始
    const flowType = (ticket.metadata as any)?.kind || ticket.flow_id;
    this.logger.info(`🚀 [START] Processing Ticket: ${ticketId} (${flowType})`);

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
          await this.apiClient.nackTicket(ticketId);
          this.logger.info(`⚠️ [NACK] Ticket ${ticketId} returned to queue`, { reason: result.reason });
        } else {
          await this.markFailed(ticketId, result.reason || 'UNKNOWN_ERROR');
          this.logger.error(`❌ [FAIL] Ticket ${ticketId} failed permanently`, { reason: result.reason });
        }
      } else {
        // [LOG] 加入生命週期日誌：完成
        this.logger.info(`✅ [DONE] Ticket ${ticketId} completed successfully.`);
      }

    } catch (error: any) {
      // [FIX] 改進錯誤日誌，顯示 Stack Trace 以便除錯
      const msg = error?.message || String(error);
      const stack = error?.stack || '';
      
      this.logger.error(`🔥 [CRASH] Ticket ${ticketId}`, { message: msg, stack });
      
      await this.apiClient.nackTicket(ticketId); 
      this.recordError({ type: 'unknown', message: msg, retryable: true, ticketId });
    } finally {
      this.activeTickets.delete(ticketId);
      this.updatePanel();
      void this.tryRefillImmediately('onFinish');
    }
  }

  private async markFailed(ticketId: string, reason: string): Promise<void> {
    try {
        await (this.apiClient as any).post(`/tickets/${ticketId}/fail`, { reason });
    } catch (e) {
        this.logger.warn(`Failed to mark ticket ${ticketId} as failed`, e);
    }
  }

  private updatePanel(): void {
    if (this.panelProvider?.refresh) this.panelProvider.refresh();
  }

  private recordError(err: ProcessingError): void {
    this.errors.push({ ...err, timestamp: new Date() } as any);
    if (this.errors.length > 50) this.errors.shift();
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
    await this.tryRefillImmediately('manual');
  }

  dispose(): void {
    this.stop();
    this.configDisposable.dispose();
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
  private maxRetries = 2;

  constructor({ ticket, apiClient, chatInvoker, logger, replyMaxChars }: ProcessorDeps) {
    this.t = ticket;
    this.api = apiClient;
    this.chat = chatInvoker;
    this.logger = logger;
    this.replyMaxChars = replyMaxChars;
  }

  async run(): Promise<RunResult> {
    const kind = this.resolveKind(this.t);
    if (kind === 'UNKNOWN') {
      return { status: 'failed', retryable: false, reason: 'UNSUPPORTED_TICKET_KIND' };
    }

    if (kind === 'TRIAGE') return this.runTriage();
    if (kind === 'REPLY') return this.runReply();

    return { status: 'failed', retryable: false, reason: 'LOGIC_ERROR' };
  }

  private resolveKind(t: Ticket): Kind | 'UNKNOWN' {
    const configured = (t.metadata && (t.metadata as any).kind) as Kind | undefined;
    if (configured) return configured;
    
    const fid = t.flow_id || '';
    const eid = t.event?.type || '';
    if (fid.includes('reply') || eid.includes('reply')) return 'REPLY';
    if (fid.includes('triage') || eid.includes('triage')) return 'TRIAGE';
    
    return 'UNKNOWN';
  }

  /* === TRIAGE FLOW (X-RAY 診斷版 v2) === */
  private async runTriage(): Promise<RunResult> {
    
    // [X-RAY 1] 檢查從 ApiClient 拿到的「完整」票據內容
    const fullContent = this.t.event?.content || "";
    this.logger.info(`🔍 [X-RAY 1] Worker Input Data (Ticket Raw)`, {
        id: this.t.id,
        // 這裡會印出全部內容，請在 Console 確認它是否完整
        event_content_full: fullContent ? fullContent : "❌ MISSING (ApiClient Fault)",
        content_length: fullContent.length,
        full_metadata: this.t.metadata
    });

    // 呼叫 PromptBuilder (如果讀不到檔案，這裡會拋出 Error，被 processTicket 接住並印出 Stack)
    const prompt = PromptBuilder.buildTriagePrompt(this.t);
    
    // [X-RAY 2] 檢查 PromptBuilder 的產出
    const targetIdx = prompt.indexOf("TARGET CONTENT");
    const contentInPrompt = fullContent ? prompt.includes(fullContent.substring(0, 20)) : false;

    this.logger.info(`🔍 [X-RAY 2] Builder Output Check`, {
        has_target_section: targetIdx !== -1,
        content_injected_successfully: contentInPrompt ? "✅ YES" : "❌ NO (Builder/YAML Fault)",
        prompt_snippet: targetIdx !== -1 
            ? prompt.substring(targetIdx, targetIdx + 300).replace(/\n/g, ' ') 
            : "Prompt structure seems broken (Header missing)"
    });

    // Crash Diagnosis
    if (fullContent && !contentInPrompt) {
        this.logger.error(`🔥 [CRASH DIAGNOSIS] Data dropped between Worker and Builder! Check variable names in YAML.`);
    }

    // 呼叫 LLM
    const modelResp = await this.chat.invokeChatModel(prompt, { 
      maxTokens: 1000,
      temperature: 0.2 
    });
    const rawText = modelResp?.text ?? '';

    // 載入 Schema 進行驗證
    const spec = PromptBuilder.getSpec('triage', (this.t.metadata as any)?.prompt_id);
    const schema = spec.outputs?.schema;

    const validation = this.validateJsonWithSchema(rawText, schema);
    if (!validation.ok) {
      this.logger.warn('Triage validation failed', { errors: validation.errors, raw: rawText });
      return { status: 'failed', retryable: true, reason: `VALIDATION: ${validation.errors.join(', ')}` };
    }

    const parsed = validation.value;
    const decision = String(parsed.decision || '').toUpperCase();
    const should_reply = decision === 'APPROVE';

    this.logger.info(`🧠 [TRIAGE] Decision: ${decision}`, {
        reason: parsed.summary || parsed.short_reason,
        target_content_detected: this.t.event?.content ? "YES" : "NO"
    });

    const outputs = {
      decision,
      should_reply,
      priority: should_reply ? 'P1' : 'P2',
      short_reason: parsed.summary || '',
      topics: parsed.reasons || [],
      sentiment: 'neutral',
      risk_tags: [],
      target_prompt_id: parsed.target_prompt_id, 
      reply_strategy: parsed.reply_strategy,
      information_needs: parsed.information_needs || [],
      ...parsed
    };

    await this.api.fillTicketV1(this.getTicketId(), {
      outputs,
      by: this.formatModelId(modelResp),
      tokens: this.extractTokens(modelResp)
    });

    return { status: 'drafted' };
  }

  /* === REPLY FLOW === */
  private async runReply(): Promise<RunResult> {
    const metadata = this.t.metadata || {};
    const replyInput = metadata.reply_input || {};
    const promptId = metadata.prompt_id || process.env.ORCH_REPLY_PROMPT_ID || 'reply.standard'; 
    
    // [LOG] 顯示收到的彈藥與戰略
    this.logger.info(`📦 [REPLY INPUT] Strategy: "${replyInput.strategy || 'N/A'}"`);
    if (replyInput.context_notes && replyInput.context_notes.length > 5) {
        this.logger.info(`📚 [CONTEXT] Received NotebookLM data (${replyInput.context_notes.length} chars)`);
    } else {
        this.logger.warn(`⚠️ [CONTEXT] No context data received from Orchestrator`);
    }

    const spec = PromptBuilder.getSpec('reply', promptId);
    
    const originalSystemConstraints = [
      spec.sections?.system,
      spec.sections?.assistant_style
    ].filter(Boolean).join('\n\n');

    const initialGenPrompt = PromptBuilder.buildReplyPrompt(this.t);

    let currentDraft = '';
    let suggestion = '';
    const processTrace: any[] = []; 

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const isRetry = attempt > 0;
      const generationPrompt = isRetry
        ? `${initialGenPrompt}\n\n[PREVIOUS DRAFT]\n${currentDraft}\n\n[REVIEWER FEEDBACK]\n${suggestion}\n\nPlease rewrite carefully based on the feedback.`
        : initialGenPrompt;

      const genResp = await this.chat.invokeChatModel(generationPrompt, { 
        maxTokens: this.replyMaxChars * 2,
        temperature: 0.7 
      });
      currentDraft = genResp?.text?.trim() ?? '';

      if (!currentDraft) {
        return { status: 'failed', retryable: true, reason: 'EMPTY_GENERATION' };
      }

      // Hard Guardrails
      const hardCheck = PromptBuilder.validateReplyFormat(currentDraft, this.replyMaxChars);
      if (!hardCheck.valid) {
        const errorMsg = `Hard guardrail failed: ${hardCheck.errors.join(', ')}`;
        this.logger.warn(errorMsg);
        
        processTrace.push({
          step: attempt + 1,
          timestamp: new Date().toISOString(),
          action: 'hard_guard_check',
          status: 'FAIL',
          reason: errorMsg,
          draft_snippet: currentDraft.slice(0, 50) + '...'
        });

        suggestion = `System check failed: ${hardCheck.errors.join(', ')}. Please strictly follow format rules.`;
        if (attempt < this.maxRetries) continue;
        else return { status: 'failed', retryable: false, reason: 'HARD_GUARDRAIL_FAIL' };
      }

      // Reviewer Check
      const reviewerPrompt = PromptBuilder.buildReviewerPrompt(
        promptId,
        originalSystemConstraints,
        currentDraft
      );

      const reviewResp = await this.chat.invokeChatModel(reviewerPrompt, { 
        maxTokens: 1000, 
        temperature: 0.1 
      });
      
      const reviewValidation = this.validateJsonWithSchema(reviewResp?.text ?? '', spec.outputs?.reviewer_schema);
      
      if (!reviewValidation.ok) {
        this.logger.warn('Reviewer output invalid JSON', { raw: reviewResp?.text });
        processTrace.push({
          step: attempt + 1,
          timestamp: new Date().toISOString(),
          action: 'reviewer_check',
          status: 'ERROR',
          raw_output: reviewResp?.text
        });
        suggestion = 'Reviewer system error. Please ensure standard output.';
        continue;
      }

      const reviewResult = reviewValidation.value;
      const verdict = String(reviewResult.final_verdict || 'FAIL').toUpperCase();
      
      processTrace.push({
        step: attempt + 1,
        timestamp: new Date().toISOString(),
        action: 'reviewer_check',
        verdict,
        safety: reviewResult.safety_check,
        quality: reviewResult.quality_check,
        suggestion: reviewResult.suggestion
      });

      if (verdict === 'PASS') {
        this.logger.info(`Reply passed review at attempt ${attempt + 1}`);
        break; 
      } else if (verdict === 'FAIL') {
        return { 
          status: 'failed', 
          retryable: false, 
          reason: `REVIEWER_BLOCK: ${reviewResult.safety_check?.violation_reason || 'Safety Violation'}` 
        };
      } else {
        suggestion = reviewResult.suggestion || 'Please improve quality and alignment.';
        if (attempt === this.maxRetries) {
          this.logger.warn('Max retries reached in agent loop');
          return { status: 'failed', retryable: false, reason: 'MAX_RETRIES_EXCEEDED' };
        }
      }
    }

    const finalReply = PromptBuilder.validateAndTrimResponse(currentDraft, this.replyMaxChars);

    // [LOG] 顯示生成的預覽
    this.logger.info(`✍️ [GENERATED] Reply Preview: "${finalReply.slice(0, 50)}..."`);

    await this.api.fillTicketV1(this.getTicketId(), {
      outputs: {
        reply: finalReply,
        confidence: 0.95, 
        needs_followup: false,
        followup_notes: '',
        citations: [],
        hashtags: [],
        tone_tags: [],
        used_strategy: promptId,
        process_trace: processTrace
      },
      by: 'vscode-worker-reviewed',
      tokens: { input: 0, output: 0 } 
    });

    return { status: 'drafted' };
  }

  /* === TOOL FLOW === */
  private async runTool(ticket: any): Promise<any> {
    return {
      tool_context: { evidence: {}, tool_trace: [] },
      tool_verdict: { status: "DEFER", reason: "stub" }
    };
  }

  /* === Helpers === */

  private getTicketId(): string {
    return (this.t as any).ticket_id || this.t.id;
  }

  private formatModelId(resp: any): string {
    return `${resp?.provider || 'vscode'}:${resp?.modelName || 'unknown'}`;
  }

  private extractTokens(resp: any): { input: number; output: number } {
    return {
      input: resp?.usage?.promptTokens || 0,
      output: resp?.usage?.completionTokens || 0
    };
  }

  private validateJsonWithSchema(text: string, schema: any): { ok: true; value: any } | { ok: false; errors: string[] } {
    const json = this.safeParseJson(text);
    if (!json) return { ok: false, errors: ['JSON_PARSE_FAILED'] };

    if (!schema) return { ok: true, value: json };

    const errors: string[] = [];
    
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in json)) errors.push(`Missing field: ${field}`);
      }
    }
    
    if (schema.properties) {
      for (const [key, propSpec] of Object.entries(schema.properties) as [string, any][]) {
        const val = json[key];
        if (val !== undefined) {
           if (propSpec.enum && !propSpec.enum.includes(val)) {
             errors.push(`Invalid enum for ${key}: got ${val}`);
           }
           if (propSpec.type === 'object' && propSpec.required && typeof val === 'object') {
             for (const nestedReq of propSpec.required) {
               if (!(nestedReq in val)) errors.push(`Missing nested field: ${key}.${nestedReq}`);
             }
           }
        }
      }
    }

    return errors.length ? { ok: false, errors } : { ok: true, value: json };
  }

  private safeParseJson(text?: string): any {
    if (!text) return null;
    try {
      const clean = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      return JSON.parse(clean);
    } catch { return null; }
  }
}