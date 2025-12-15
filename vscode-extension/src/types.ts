// src/types.ts

// ==========================================
// [NEW] 戰略與後勤相關介面 (Strategic & Logistics)
// ==========================================

export interface InformationNeed {
    question: string;
    purpose: string;
}

/**
 * Orchestrator 準備給 Reply Worker 的輸入資料
 * 包含 Triage 的戰略指導與 MCP 查好的資料
 */
export interface ReplyInput {
    strategy?: string;          // 來自 Triage 的戰略指導
    context_notes?: string;     // 來自 Orchestrator (MCP) 查好的資料
    candidate_snippet?: string; // 原始貼文內容 (備份)
    brand_voice?: string;       // 品牌語氣設定
    [key: string]: any;
}

/**
 * Triage Worker 產出的結構化決策
 */
export interface TriageOutput {
    decision: 'APPROVE' | 'SKIP';
    confidence: number;
    reasons: string[];
    summary: string;
    target_prompt_id?: string;      // 指定戰術模組 ID
    reply_strategy?: string;        // 戰略指導
    information_needs?: InformationNeed[]; // 資料需求
    signals?: {
        urgency?: number;
        risk_level?: string;
    };
    [key: string]: any;
}

// ==========================================
// Orchestrator API 基礎型別
// ==========================================

export interface Ticket {
    id: string;
    ticket_id: string;
    type: string;
    status: 'pending' | 'in_progress' | 'drafted' | 'completed' | 'approved' | 'failed' | 'leased';
    flow_id: string;
    event: {
        type: string;
        event_id: string;
        thread_id: string;
        content: string;
        actor: string;
        timestamp: string;
        features?: any;
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
        
        // [MODIFIED] 支援結構化輸入
        triage_input?: any;
        reply_input?: ReplyInput; // 使用強型別介面
        
        // [NEW] 戰略路由與追溯
        prompt_id?: string;            // 例如 "reply.debunk"
        triage_reference_id?: string;  // 追溯來源 Triage Ticket ID
        triage_result?: TriageOutput;  // 原始 Triage 結果備份

        lease_id?: string;
        candidate_id?: string;
        triage_ticket_id?: string;
        source?: string;
        
        // 允許其他動態欄位
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
    lease_sec: number; // 建議設為 300 以容納 MCP 查詢
    capabilities?: string[];
    kind?: LeaseKind;
}

export interface FillRequest {
    // [MODIFIED] 新版 Orchestrator 優先讀取 outputs
    outputs?: any; 
    
    // 舊版相容 (若 outputs 為空，則嘗試解析 draft 字串)
    draft?: string; 
    
    confidence: number;
    
    // 辨識是誰填寫的 (通常是 'vscode.lm')
    by?: string;

    model_info: {
        host?: string;
        provider: string;
        model: string;
        latency_ms: number;
        prompt_tokens: number;
        completion_tokens: number;
    };
    
    // 額外的 Token 統計
    tokens?: {
        input: number;
        output: number;
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
    // 支援直接回傳 T 或 { tickets: T[] } 的結構
    tickets?: T; 
    status?: string;
}

// ==========================================
// 模型與工具型別
// ==========================================

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