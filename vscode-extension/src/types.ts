// Orchestrator API 相關型別
export interface Ticket {
    id: string;
    ticket_id: string;
    type: string;
    status: 'pending' | 'in_progress' | 'drafted' | 'completed' | 'approved' | 'failed';
    flow_id: string;
    event: {
        type: string;
        event_id: string;
        thread_id: string;
        content: string;
        actor: string;
        timestamp: string;
    };
    context: {
        thread_id: string;
        event_id: string;
    };
    constraints: {
        lang: string;
        max_chars: number;
    };
    metadata: {
        created_at: string;
        updated_at: string;
        triage_input?: any;
        reply_input?: any;
        triage_result?: any;
        lease_id?: string;
        candidate_id?: string;
        triage_ticket_id?: string;
        source?: string;
        [key: string]: any;
    };
    draft?: {
        content: string;
        confidence: number;
    };
    version?: number;
}

export type LeaseKind = 'TRIAGE' | 'REPLY';

export interface LeaseRequest {
    limit: number;
    lease_sec: number;
    capabilities: string[];
    kind?: LeaseKind;
}

export interface FillRequest {
    draft: string;
    confidence: number;
    model_info: {
        host?: string;
        provider: string;
        model: string;
        latency_ms: number;
        prompt_tokens: number;
        completion_tokens: number;
    };
    ticket_version?: number;
}

export interface ApproveRequest {
    approved: boolean;
    dry_run?: boolean;
}

export interface ApiResponse<T = any> {
    ok?: boolean;
    error?: string;
    message?: string;
    data?: T;
}

// 模型相關型別
export interface ModelResponse {
    text: string;
    usage: {
        promptTokens: number;
        completionTokens: number;
    };
    latencyMs: number;
    modelName: string;
    provider?: string;
    modelId?: string;
}

export interface PromptContext {
    threadSummary: string;
    memorySnippets?: string[];
    constraints: {
        lang: string;
        maxChars: number;
        style?: string;
    };
}

// 錯誤型別
export interface ProcessingError {
    type: 'network' | 'model' | 'validation' | 'conflict' | 'rate_limit' | 'timeout' | 'unknown';
    message: string;
    retryable: boolean;
    ticketId?: string;
}

// 工作器狀態
export interface WorkerStatus {
    isRunning: boolean;
    pollInterval: number;
    activeTickets: number;
    lastPollTime?: Date;
    errors: ProcessingError[];
}