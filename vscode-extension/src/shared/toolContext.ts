export interface Evidence {
  source: string;
  snippet: string;
  relevance_score: number;
  url?: string;
  entity_type?: string;
  relation_type?: string;
}

export interface ToolTraceEntry {
  tool_name: string;
  error?: string;
  detail?: Record<string, any>;
  timestamp?: string;
}

export interface AdapterResult {
  evidence: Evidence[];
  error?: string;
  detail?: Record<string, any>;
  tool_trace?: ToolTraceEntry[];
}

export interface ToolContext {
  evidence: Evidence[];
  tool_trace: ToolTraceEntry[];
  truncated: boolean;
}
