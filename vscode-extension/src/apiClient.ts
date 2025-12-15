// vscode-extension/src/apiClient.ts
import fetch from 'node-fetch';
import { Config } from './config';
import { Logger } from './logger';
import { Ticket, LeaseRequest, FillRequest, ApproveRequest, ApiResponse, ProcessingError } from './types';
import { LeaseKind } from './types';

export class ApiClient {
    private baseUrl: string;
    private logger: Logger;
    private maxRetries: number = 3;
    private baseRetryDelay: number = 1000; // 1s

    constructor(logger: Logger) {
        this.logger = logger;
        this.baseUrl = Config.get().orchestrator.baseUrl;

        // 監聽配置變更
        Config.onDidChange(() => {
            this.baseUrl = Config.get().orchestrator.baseUrl;
        });
    }

    // ---------- helpers ----------

    private async delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private calculateRetryDelay(attempt: number): number {
        // 指數退避：1s, 2s, 4s, 8s ... 上限 60s
        return Math.min(this.baseRetryDelay * Math.pow(2, attempt), 60000);
    }

    private classifyError(statusCode: number, responseText: string): ProcessingError {
        if (statusCode === 409) {
            return { type: 'conflict', message: 'Version conflict', retryable: false };
        }
        if (statusCode === 429) {
            return { type: 'rate_limit', message: 'Rate limit exceeded', retryable: true };
        }
        if (statusCode >= 400 && statusCode < 500) {
            return { type: 'validation', message: `Client error: ${responseText}`, retryable: false };
        }
        if (statusCode >= 500) {
            return { type: 'network', message: `Server error: ${statusCode}`, retryable: true };
        }
        return { type: 'unknown', message: `Unexpected error: ${statusCode}`, retryable: true };
    }

    private authHeaders(): Record<string, string> {
        const cfg = Config.get();
        const h: Record<string, string> = {
            'Content-Type': 'application/json',
            'User-Agent': 'Agent-PO-Bot-VSCode/0.1.0'
        };
        if (cfg.orchestrator.authToken) {
            h['Authorization'] = `Bearer ${cfg.orchestrator.authToken}`;
        }
        return h;
    }

    private async makeRequest<T>(
        method: string,
        path: string,
        body?: any,
        retryCount: number = 0
    ): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const startTime = Date.now();

        try {
            const response = await fetch(url, {
                method,
                headers: this.authHeaders(),
                body: body ? JSON.stringify(body) : undefined,
                // node-fetch v2 支援 timeout（毫秒）
                timeout: 30000
            });

            const latencyMs = Date.now() - startTime;
            const responseText = await response.text();

            this.logger.logApiCall(method, path, response.status, latencyMs);

            if (!response.ok) {
                const error = this.classifyError(response.status, responseText);
                if (error.retryable && retryCount < this.maxRetries) {
                    const delay = this.calculateRetryDelay(retryCount);
                    this.logger.warn(`API call failed, retrying in ${delay}ms`, {
                        url,
                        status: response.status,
                        attempt: retryCount + 1,
                        maxRetries: this.maxRetries
                    });
                    await this.delay(delay);
                    return this.makeRequest<T>(method, path, body, retryCount + 1);
                }
                throw error;
            }

            try {
                return JSON.parse(responseText) as T;
            } catch {
                return responseText as unknown as T;
            }
        } catch (error) {
            const latencyMs = Date.now() - startTime;

            if (error instanceof Error && (error.name === 'AbortError' || error.message?.includes('timeout'))) {
                const timeoutError: ProcessingError = { type: 'timeout', message: 'Request timeout', retryable: true };
                if (retryCount < this.maxRetries) {
                    const delay = this.calculateRetryDelay(retryCount);
                    this.logger.warn(`Request timeout, retrying in ${delay}ms`, { url, attempt: retryCount + 1 });
                    await this.delay(delay);
                    return this.makeRequest<T>(method, path, body, retryCount + 1);
                }
                throw timeoutError;
            }

            if (error && typeof error === 'object' && 'type' in (error as any)) {
                throw error as ProcessingError;
            }

            const networkError: ProcessingError = {
                type: 'network',
                message: error instanceof Error ? error.message : 'Network error',
                retryable: true
            };
            this.logger.logApiCall(method, path, 0, latencyMs, networkError.message);

            if (retryCount < this.maxRetries) {
                const delay = this.calculateRetryDelay(retryCount);
                this.logger.warn(`Network error, retrying in ${delay}ms`, {
                    url,
                    error: networkError.message,
                    attempt: retryCount + 1
                });
                await this.delay(delay);
                return this.makeRequest<T>(method, path, body, retryCount + 1);
            }
            throw networkError;
        }
    }

    // ---------- API methods ----------

    /** v1: 租賃票據（修復版：正確解包 + 強力內容搜索） */
    async leaseTicketsV1(
        kind: LeaseKind,
        max: number,
        leaseSec: number = 90,
        capabilities?: string[]
    ): Promise<Ticket[]> {
        const ask = Math.max(1, max);
        const payload: any = { kind, max: ask, lease_sec: leaseSec };
        if (capabilities) payload.capabilities = capabilities;

        try {
            // 1. 取得原始回應
            const response = await this.makeRequest<any>('POST', '/v1/tickets/lease', payload);
            
            // 2. [關鍵修復] 正確解包
            // Orchestrator 回傳可能是 { tickets: [...] } (新版) 或 [...] (舊版)
            let rawList: any[] = [];
            if (response && Array.isArray(response.tickets)) {
                rawList = response.tickets; // 標準格式
            } else if (Array.isArray(response)) {
                rawList = response; // 舊版格式
            } else {
                rawList = [];
            }

            const list = rawList.slice(0, ask);
            
            // 3. 映射 (這裡會呼叫修復後的 mapLeasedTicket)
            const mapped = list.map((item, index) => {
                try {
                    return this.mapLeasedTicket(kind, item);
                } catch (err) {
                    this.logger.error(`[API] Map failed for item`, err);
                    return null;
                }
            }).filter((t): t is Ticket => t !== null);

            if (mapped.length > 0) {
                this.logger.info(`[API] Successfully LEASED ${mapped.length} tickets (kind=${kind})`);
            } else {
                this.logger.debug(`[API] Polled tickets (kind=${kind}), got none.`);
            }
            
            return mapped;

        } catch (e) {
            this.logger.error(`[API] Lease request failed`, e);
            return []; 
        }
    }

    /** 與舊 API 相容的租賃介面 */
    async leaseTickets(request: LeaseRequest): Promise<Ticket[]> {
        const ask = Math.max(1, request.limit ?? 1);
        this.logger.debug('Leasing tickets', { ...request, ask });

        try {
            const cfg = Config.get();
            const kind = (request.kind ?? 'TRIAGE').toUpperCase() as 'TRIAGE' | 'REPLY';

            if (cfg.worker.useV1Lease) {
                return this.leaseTicketsV1(kind, ask, request.lease_sec ?? 90, request.capabilities);
            }

            // Fallback Legacy Logic
            const { kind: _ignoredKind, ...legacyBase } = request as any;
            const legacyReq: LeaseRequest = {
                ...legacyBase,
                limit: ask,
                lease_sec: request.lease_sec ?? 90
            };
            const response = await this.makeRequest<Ticket[]>('POST', '/tickets/lease', legacyReq);
            const sliced = (response || []).slice(0, ask);
            
            if (sliced.length > 0) {
                this.logger.info(`[API] Leased ${sliced.length} tickets (legacy)`);
            } else {
                this.logger.debug(`[API] Polled tickets (legacy), got none.`);
            }
            
            return sliced;
        } catch (error) {
            this.logger.debug('Lease failed, will fallback to pending query', error);
            return [];
        }
    }

    private mapLeasedTicket(kind: LeaseKind, raw: any): Ticket {
        const nowIso = new Date().toISOString();

        // ------------------------------------------------------------------
        // [關鍵修復] 強力搜索貼文內容 (Robust Content Search)
        // ------------------------------------------------------------------
        // 我們依序查找所有可能的欄位，確保絕對不會漏掉資料
        const contentSource = 
            raw.inputs?.candidate_snippet || 
            raw.inputs?.snippet || 
            raw.event?.content || 
            raw.content || 
            '';

        if (!contentSource) {
            this.logger.warn(`[API] ⚠️ Empty content for ticket ${raw.ticket_id}. LLM might hallucinate. Keys: ${Object.keys(raw).join(',')}`);
        }

        if (kind === 'REPLY') {
            const inputs = raw?.inputs || {};
            const cfg = Config.get();
            const maxChars = cfg.reply?.maxChars ?? 800; // 預設放寬到 800 字
            const candidateId = inputs.candidate_id || raw?.metadata?.candidate_id || raw?.ticket_id;

            return {
                id: raw.ticket_id,
                ticket_id: raw.ticket_id,
                type: 'DraftTicket',
                status: 'pending',
                flow_id: 'reply_zh_hant_v1',
                event: {
                    type: 'reply_candidate',
                    event_id: `reply-${raw.ticket_id}`,
                    thread_id: candidateId,
                    content: contentSource, // [FIX] 使用我們強力搜索到的內容
                    actor: 'reply',
                    timestamp: nowIso
                },
                context: { thread_id: candidateId, event_id: `reply-${raw.ticket_id}` },
                constraints: { lang: 'zh-tw', max_chars: maxChars },
                metadata: {
                    created_at: nowIso,
                    updated_at: nowIso,
                    reply_input: inputs,
                    lease_id: raw.lease_id,
                    candidate_id: candidateId,
                    triage_ticket_id: raw?.metadata?.triage_ticket_id,
                    triage_result: raw?.metadata?.triage_result,
                    source: raw?.metadata?.source || 'triage',
                    prompt_id: raw?.metadata?.prompt_id,
                    kind: 'REPLY'
                },
                version: 1
            };
        }

        // TRIAGE Mapping
        return {
            id: raw.ticket_id,
            ticket_id: raw.ticket_id,
            type: 'DraftTicket',
            status: 'pending',
            flow_id: 'triage_zh_hant_v1',
            event: {
                type: 'triage_candidate',
                event_id: `triage-${raw.ticket_id}`,
                thread_id: raw.ticket_id,
                content: contentSource, // [FIX] 使用我們強力搜索到的內容
                actor: 'triage',
                timestamp: nowIso
            },
            context: { thread_id: raw.ticket_id, event_id: `triage-${raw.ticket_id}` },
            constraints: { lang: 'zh-tw', max_chars: 500 },
            metadata: {
                created_at: nowIso,
                updated_at: nowIso,
                triage_input: raw.inputs,
                lease_id: raw.lease_id,
                kind: 'TRIAGE'
            },
            version: 1
        };
    }

    /** 備用：取得 pending 票據 */
    async getPendingTickets(limit?: number): Promise<Ticket[]> {
        this.logger.debug('Fetching pending tickets');
        try {
            const response = await this.makeRequest<Ticket[]>('GET', '/v1/tickets?status=pending');
            const list = response || [];
            this.logger.debug(`Fetched ${list.length} pending tickets`);
            return typeof limit === 'number' ? list.slice(0, Math.max(0, limit)) : list;
        } catch (error) {
            this.logger.error('Failed to fetch pending tickets', error);
            throw error;
        }
    }

    /** 取得單張票據 */
    async getTicket(ticketId: string): Promise<Ticket> {
        this.logger.debug(`Fetching ticket ${ticketId}`);
        try {
            return await this.makeRequest<Ticket>('GET', `/v1/tickets/${ticketId}`);
        } catch (error) {
            this.logger.error(`Failed to fetch ticket ${ticketId}`, error);
            throw error;
        }
    }

    /** 回填草稿（舊版） */
    async fillTicket(ticketId: string, request: FillRequest): Promise<ApiResponse> {
        const draftLen = request.draft?.length || 0;
        this.logger.debug(`Filling ticket ${ticketId}`, {
            confidence: request.confidence,
            model: request.model_info?.model || 'unknown',
            draftLength: draftLen
        });
        try {
            const res = await this.makeRequest<ApiResponse>('POST', `/v1/tickets/${ticketId}/fill`, request);
            this.logger.info(`Successfully filled ticket ${ticketId}`);
            return res;
        } catch (error) {
            this.logger.error(`Failed to fill ticket ${ticketId}`, error);
            throw error;
        }
    }

    /** v1: TRIAGE 專用回填 */
    async fillTicketV1(
        ticketId: string,
        body: { lease_id?: string; outputs: any; by?: string; tokens?: { input?: number; output?: number } }
    ): Promise<ApiResponse> {
        const payloadSize = body.outputs ? JSON.stringify(body.outputs).length : 0;
        this.logger.debug(`Filling ticket (v1) ${ticketId}`, { 
            hasOutputs: !!body.outputs,
            payloadSize
        });
        
        try {
            const res = await this.makeRequest<ApiResponse>('POST', `/v1/tickets/${ticketId}/fill`, body);
            this.logger.info(`Successfully filled ticket (v1) ${ticketId}`);
            return res;
        } catch (error) {
            this.logger.error(`Failed to fill ticket (v1) ${ticketId}`, error);
            throw error;
        }
    }

    /** 呼叫工具 */
    async callTool(server: string, tool: string, args: any): Promise<any> {
        this.logger.info(`[API] Calling tool ${server}.${tool}`);
        try {
            return await this.makeRequest<any>('POST', '/v1/tools/execute', {
                server,
                tool,
                arguments: args
            });
        } catch (error) {
            this.logger.error(`Failed to call tool ${server}.${tool}`, error);
            throw error;
        }
    }

    /** 核准票據 */
    async approveTicket(ticketId: string, request: ApproveRequest): Promise<ApiResponse> {
        this.logger.debug(`Approving ticket ${ticketId}`, request);
        try {
            const res = await this.makeRequest<ApiResponse>('POST', `/tickets/${ticketId}/approve`, request);
            this.logger.info(`Successfully approved ticket ${ticketId}`);
            return res;
        } catch (error) {
            this.logger.error(`Failed to approve ticket ${ticketId}`, error);
            throw error;
        }
    }

    /** 心跳 */
    async heartbeat(ticketId: string): Promise<ApiResponse> {
        this.logger.debug(`Sending heartbeat for ticket ${ticketId}`);
        try {
            return await this.makeRequest<ApiResponse>('POST', `/tickets/${ticketId}/heartbeat`);
        } catch (error) {
            this.logger.debug(`Heartbeat failed for ticket ${ticketId}`, error);
            throw error;
        }
    }

    /** v1: 心跳 */
    async heartbeatV1(ticketId: string, lease_id: string): Promise<ApiResponse> {
        this.logger.debug(`Sending v1 heartbeat for ticket ${ticketId}`);
        try {
            return await this.makeRequest<ApiResponse>('POST', `/v1/tickets/${ticketId}/heartbeat`, { lease_id });
        } catch (error) {
            this.logger.debug(`Heartbeat (v1) failed for ticket ${ticketId}`, error);
            throw error;
        }
    }

    /** v1: 放棄票據 (修復版：退回 Legacy 路徑，解決 404 問題) */
    async nackTicketV1(ticketId: string, lease_id: string): Promise<ApiResponse> {
        this.logger.debug(`Nacking ticket (v1) ${ticketId}`);
        try {
            // [FIX] 改用 /tickets/... (移除 /v1)，以配合目前的 Server 路由
            const res = await this.makeRequest<ApiResponse>('POST', `/tickets/${ticketId}/nack`, { lease_id });
            this.logger.info(`Successfully nacked ticket (v1) ${ticketId}`);
            return res;
        } catch (error) {
            this.logger.error(`Failed to nack ticket (v1) ${ticketId}`, error);
            throw error;
        }
    }

    /** 放棄票據 (修復版：退回 Legacy 路徑) */
    async nackTicket(ticketId: string): Promise<ApiResponse> {
        this.logger.debug(`Nacking ticket ${ticketId}`);
        try {
            // [FIX] 改用 /tickets/... (移除 /v1)
            const res = await this.makeRequest<ApiResponse>('POST', `/tickets/${ticketId}/nack`);
            this.logger.info(`Successfully nacked ticket ${ticketId}`);
            return res;
        } catch (error) {
            this.logger.error(`Failed to nack ticket ${ticketId}`, error);
            throw error;
        }
    }

    /** 健康檢查 */
    async healthCheck(): Promise<{ status: string; uptime: number; queue_depth: number }> {
        try {
            return await this.makeRequest<{ status: string; uptime: number; queue_depth: number }>('GET', '/health');
        } catch (error) {
            this.logger.error('Health check failed', error);
            throw error;
        }
    }
}