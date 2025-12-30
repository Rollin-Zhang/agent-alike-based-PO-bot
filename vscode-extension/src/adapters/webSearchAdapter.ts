/**
 * Web Search Adapter - Single choke point for all web search MCP operations
 * 
 * Commit 10c: Web Search Client Hardening
 * - Tool whitelist enforcement (get-web-search-summaries, get-single-web-page-content)
 * - Content parsing and evidence transformation
 * - Deterministic error codes (no details in error messages)
 * 
 * Security guarantees:
 * - full-web-search blocked at client (WEB_TOOL_FORBIDDEN)
 * - All web search access must go through this adapter
 * - No scattered web search server id or tool name references
 */

import { extractTextContent } from './mcpUtils';

import type { AdapterResult, Evidence, ToolTraceEntry } from '../shared/toolContext';

// ============================================================================
// TOOL CONTRACT LOCK (Pinned SSOT, hardcoded from local web-search-mcp)
// ============================================================================

const WEB_SEARCH_SERVER_ID = "web_search";
const TOOL_SUMMARIES = "get-web-search-summaries";
const TOOL_PAGE_CONTENT = "get-single-web-page-content";

// ============================================================================
// TOOL WHITELIST (Summaries and single page only; full-web-search blocked)
// ============================================================================

/**
 * Allowed tools for this adapter.
 * full-web-search is intentionally excluded (too heavy, unpredictable latency).
 */
const ALLOWED_WEB_TOOLS = new Set([
  TOOL_SUMMARIES,
  TOOL_PAGE_CONTENT
]);

// ============================================================================
// ERROR CODES (Pure codes, no suffix or detail in message)
// ============================================================================

const WEB_TOOL_FORBIDDEN = "WEB_TOOL_FORBIDDEN";
const WEB_PARSE_FAILED = "WEB_PARSE_FAILED";
const WEB_NO_RESULTS = "WEB_NO_RESULTS";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageAdapterResult {
  content: string;
  error?: string;
  detail?: Record<string, any>;
  tool_trace?: ToolTraceEntry[];
}

// NOTE: Evidence/AdapterResult/ToolTraceEntry are SSOT in src/shared/toolContext.ts

// ============================================================================
// TOOL WHITELIST ENFORCEMENT
// ============================================================================

/**
 * Asserts that the requested tool is in the allowed whitelist.
 * Throws error code only (no tool name in error message).
 */
function assertAllowedTool(toolName: string): void {
  if (!ALLOWED_WEB_TOOLS.has(toolName)) {
    throw new Error(WEB_TOOL_FORBIDDEN);
  }
}

// ============================================================================
// CONTENT PARSING
// ============================================================================

/**
 * Parses search summaries response into structured results.
 * 
 * Expected format from get-web-search-summaries:
 * ```
 * Search summaries for "query" with N results:
 * 
 * **1. Title**
 * URL: https://...
 * Description: ...
 * 
 * ---
 * 
 * **2. Title**
 * ...
 * ```
 */
function parseSummaries(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  
  // Split by the separator line
  const sections = text.split(/\n---\n/);
  
  for (const section of sections) {
    // Extract title (format: **N. Title**)
    const titleMatch = section.match(/\*\*\d+\.\s*(.+?)\*\*/);
    // Extract URL
    const urlMatch = section.match(/URL:\s*(https?:\/\/[^\s\n]+)/);
    // Extract description
    const descMatch = section.match(/Description:\s*(.+?)(?:\n|$)/s);
    
    if (titleMatch && urlMatch) {
      results.push({
        title: titleMatch[1].trim(),
        url: urlMatch[1].trim(),
        snippet: descMatch ? descMatch[1].trim().substring(0, 500) : ''
      });
    }
  }
  
  return results;
}

/**
 * Parses page content response.
 * 
 * Expected format from get-single-web-page-content:
 * ```
 * **Page Content from: URL**
 * 
 * **Title:** ...
 * **Word Count:** N
 * **Content Length:** N characters
 * 
 * **Content:**
 * ...actual content...
 * ```
 */
function parsePageContent(text: string): { title: string; content: string; url: string } {
  // Extract URL from header
  const urlMatch = text.match(/\*\*Page Content from:\s*(https?:\/\/[^\s*]+)/);
  // Extract title
  const titleMatch = text.match(/\*\*Title:\*\*\s*(.+?)(?:\n|$)/);
  // Extract content (everything after **Content:**)
  const contentMatch = text.match(/\*\*Content:\*\*\s*\n?([\s\S]*)/);
  
  return {
    url: urlMatch ? urlMatch[1].trim() : '',
    title: titleMatch ? titleMatch[1].trim() : '',
    content: contentMatch ? contentMatch[1].trim() : text
  };
}

// ============================================================================
// EVIDENCE TRANSFORMATION
// ============================================================================

/**
 * Transforms search results into evidence array.
 */
function searchResultsToEvidence(results: SearchResult[]): Evidence[] {
  return results.map((result, index) => ({
    source: `web_search:${index + 1}`,
    snippet: `${result.title}\n${result.snippet}`,
    relevance_score: Math.max(0.4, 0.6 - index * 0.02),
    url: result.url
  }));
}

// ============================================================================
// MCP CLIENT INTERFACE
// ============================================================================

interface McpClient {
  callTool(serverId: string, toolName: string, args: Record<string, any>): Promise<any>;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Searches the web and returns summarized results.
 * 
 * @param mcp - MCP client instance
 * @param params.query - Search query
 * @param params.limit - Maximum number of results (default: 5)
 */
export async function searchWeb(
  mcp: McpClient,
  params: { query: string; limit?: number }
): Promise<AdapterResult> {
  const tool_trace: ToolTraceEntry[] = [];
  const timestamp = new Date().toISOString();
  
  try {
    assertAllowedTool(TOOL_SUMMARIES);
    
    const result = await mcp.callTool(WEB_SEARCH_SERVER_ID, TOOL_SUMMARIES, {
      query: params.query,
      limit: params.limit ?? 5
    });
    
    tool_trace.push({
      tool_name: TOOL_SUMMARIES,
      timestamp,
      detail: { query: params.query, limit: params.limit ?? 5 }
    });
    
    const texts = extractTextContent(result);
    
    if (texts.length === 0) {
      return {
        evidence: [],
        error: WEB_NO_RESULTS,
        detail: { reason: 'No text content in response' },
        tool_trace
      };
    }
    
    const parsed = parseSummaries(texts[0]);
    
    if (parsed.length === 0) {
      return {
        evidence: [],
        error: WEB_PARSE_FAILED,
        detail: { reason: 'Failed to parse summaries from response' },
        tool_trace
      };
    }
    
    const evidence = searchResultsToEvidence(parsed);
    
    return {
      evidence,
      tool_trace
    };
    
  } catch (err: any) {
    if (err.message === WEB_TOOL_FORBIDDEN) {
      tool_trace.push({
        tool_name: WEB_SEARCH_SERVER_ID,
        error: WEB_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_SUMMARIES }
      });
      
      return {
        evidence: [],
        error: WEB_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_SUMMARIES },
        tool_trace
      };
    }
    
    return {
      evidence: [],
      error: 'WEB_CALL_FAILED',
      detail: { message: err.message },
      tool_trace
    };
  }
}

/**
 * Fetches content from a single web page.
 * 
 * @param mcp - MCP client instance
 * @param params.url - URL to fetch
 * @param params.maxContentLength - Maximum content length (default: 2000)
 */
export async function fetchPage(
  mcp: McpClient,
  params: { url: string; maxContentLength?: number }
): Promise<PageAdapterResult> {
  const tool_trace: ToolTraceEntry[] = [];
  const timestamp = new Date().toISOString();
  
  try {
    assertAllowedTool(TOOL_PAGE_CONTENT);
    
    const result = await mcp.callTool(WEB_SEARCH_SERVER_ID, TOOL_PAGE_CONTENT, {
      url: params.url,
      maxContentLength: params.maxContentLength ?? 2000
    });
    
    tool_trace.push({
      tool_name: TOOL_PAGE_CONTENT,
      timestamp,
      detail: { url: params.url, maxContentLength: params.maxContentLength ?? 2000 }
    });
    
    const texts = extractTextContent(result);
    
    if (texts.length === 0) {
      return {
        content: '',
        error: WEB_NO_RESULTS,
        detail: { reason: 'No text content in response' },
        tool_trace
      };
    }
    
    const parsed = parsePageContent(texts[0]);
    
    return {
      content: parsed.content,
      tool_trace
    };
    
  } catch (err: any) {
    if (err.message === WEB_TOOL_FORBIDDEN) {
      tool_trace.push({
        tool_name: WEB_SEARCH_SERVER_ID,
        error: WEB_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_PAGE_CONTENT }
      });
      
      return {
        content: '',
        error: WEB_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_PAGE_CONTENT },
        tool_trace
      };
    }
    
    return {
      content: '',
      error: 'WEB_CALL_FAILED',
      detail: { message: err.message },
      tool_trace
    };
  }
}

/**
 * Evidence-only wrapper for callers that want AdapterResult output.
 * Keeps fetchPage() v6-compatible ({ content }) while enabling unified aggregation.
 */
export async function fetchPageEvidence(
  mcp: McpClient,
  params: { url: string; maxContentLength?: number }
): Promise<AdapterResult> {
  const page = await fetchPage(mcp, params);
  if (page.error) {
    return {
      evidence: [],
      error: page.error,
      detail: page.detail,
      tool_trace: page.tool_trace
    };
  }

  return {
    evidence: [
      {
        source: `web_page:${params.url}`,
        snippet: page.content,
        relevance_score: 0.65,
        url: params.url
      }
    ],
    tool_trace: page.tool_trace
  };
}

// ============================================================================
// EXPORTS (for testing forbidden tool behavior)
// ============================================================================

export const _testing = {
  assertAllowedTool,
  WEB_TOOL_FORBIDDEN,
  WEB_PARSE_FAILED,
  WEB_NO_RESULTS,
  ALLOWED_WEB_TOOLS,
  parseSummaries,
  parsePageContent
};
