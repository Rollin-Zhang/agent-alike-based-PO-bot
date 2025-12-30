/**
 * Filesystem Adapter - Single choke point for all filesystem MCP operations
 * 
 * Commit 8: Client Hardening (v7 Evidence-Based)
 * - Strict path allowlist (./logs, ./docs only)
 * - Forced literal search (Glob escaping, NOT regex)
 * - Deterministic truncation using shared constants
 * - No normalize/sanitize/rewrite
 * 
 * Security guarantees:
 * - All filesystem access must go through this adapter
 * - Invalid paths blocked at client, never reach MCP
 * - No scattered filesystem server id or tool name references
 */

import {
  MAX_HITS_PER_TOOL,
  MAX_CHARS_PER_HIT,
  MAX_READ_CHARS
} from '../../../orchestrator/shared/constants';

// ============================================================================
// TOOL CONTRACT LOCK (Pinned SSOT, hardcoded from official MCP filesystem)
// ============================================================================

const FS_SERVER_ID = "filesystem";
const FS_TOOL_LIST = "list_directory";
const FS_TOOL_READ = "read_file";
const FS_TOOL_SEARCH = "search_files";

// ============================================================================
// PATH PREFIX GUARD (Pre-call validation)
// ============================================================================

/**
 * Validates path against strict allowlist rules.
 * Throws Error("FS_PATH_BLOCKED") if invalid.
 * 
 * Allowed:
 * - ./logs
 * - ./logs/**
 * - ./docs
 * - ./docs/**
 * 
 * Blocked:
 * - logs, logs/**, docs, docs/** (no ./ prefix)
 * - Absolute paths (starts with /)
 * - UNC paths (contains backslash)
 * - Parent traversal (../ or ..\)
 * - Drive letters (:)
 * - Home directory (~)
 * 
 * NO normalize, sanitize, or automatic correction.
 */
function validatePath(path: unknown): void {
  // Type check
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error("FS_PATH_BLOCKED");
  }

  // Absolute path (POSIX)
  if (path.startsWith('/')) {
    throw new Error("FS_PATH_BLOCKED");
  }

  // Backslash (Windows paths, UNC)
  if (path.includes('\\')) {
    throw new Error("FS_PATH_BLOCKED");
  }

  // Parent traversal (segment-based check)
  // Split by '/' and check if any segment is exactly ".."
  // This catches ../foo, foo/../bar, foo/.., etc.
  const segments = path.split('/');
  if (segments.some(seg => seg === '..')) {
    throw new Error("FS_PATH_BLOCKED");
  }

  // Drive letters / URI schemes
  if (path.includes(':')) {
    throw new Error("FS_PATH_BLOCKED");
  }

  // Home directory expansion
  if (path.includes('~')) {
    throw new Error("FS_PATH_BLOCKED");
  }

  // Allowlist check (must start with ./logs or ./docs)
  if (!path.startsWith('./logs') && !path.startsWith('./docs')) {
    throw new Error("FS_PATH_BLOCKED");
  }
}

// ============================================================================
// GLOB ESCAPE (Forced Literal Search for search_files)
// ============================================================================

/**
 * Escapes glob metacharacters to treat query as literal string.
 * 
 * search_files uses Glob-style patterns (NOT regex).
 * To force literal search, we must escape all glob control characters.
 * 
 * Escape order matters: backslash must be escaped FIRST to avoid
 * double-escaping issues.
 * 
 * Glob metacharacters escaped:
 * - \ (backslash, escape character itself)
 * - * (star, matches any string)
 * - ? (question, matches single char)
 * - [ ] (brackets, character class)
 * - { } (braces, alternation)
 * - ( ) (parens, grouping in some implementations)
 * - ! (exclamation, negation in character classes)
 * 
 * Examples:
 * - "foo*bar" -> "foo\*bar" (literal asterisk)
 * - "a?b" -> "a\?b" (literal question mark)
 * - "[abc]" -> "\[abc\]" (literal brackets)
 * - "foo\bar" -> "foo\\bar" (literal backslash)
 */
function escapeGlobLiteral(query: string): string {
  // CRITICAL: Escape backslash FIRST
  let escaped = query.replace(/\\/g, '\\\\');
  
  // Then escape other glob metacharacters
  escaped = escaped.replace(/\*/g, '\\*');
  escaped = escaped.replace(/\?/g, '\\?');
  escaped = escaped.replace(/\[/g, '\\[');
  escaped = escaped.replace(/\]/g, '\\]');
  escaped = escaped.replace(/\{/g, '\\{');
  escaped = escaped.replace(/\}/g, '\\}');
  escaped = escaped.replace(/\(/g, '\\(');
  escaped = escaped.replace(/\)/g, '\\)');
  escaped = escaped.replace(/!/g, '\\!');
  
  return escaped;
}

// ============================================================================
// MCP CallToolResult UNPACKING (Shared utility from mcpUtils)
// ============================================================================

import { extractTextContent } from './mcpUtils';

// ============================================================================
// PUBLIC API (Fixed signatures)
// ============================================================================

/**
 * Lists directory contents.
 * 
 * @param mcp - MCP client instance
 * @param path - Directory path (must be ./logs/** or ./docs/**)
 * @returns Array of entry strings, truncated to MAX_HITS_PER_TOOL
 * @throws Error("FS_PATH_BLOCKED") if path is invalid
 * 
 * Implementation:
 * - Calls list_directory MCP tool
 * - Extracts text blocks from result.content
 * - Returns string array (deterministic truncation to MAX_HITS_PER_TOOL)
 */
export async function fsList(mcp: any, { path }: { path: string }): Promise<string[]> {
  validatePath(path);
  
  const result = await mcp.callTool(FS_SERVER_ID, FS_TOOL_LIST, { path });
  
  // Extract text blocks from MCP CallToolResult
  const texts = extractTextContent(result);
  
  // Deterministic truncation: take first N
  return texts.slice(0, MAX_HITS_PER_TOOL);
}

/**
 * Reads file contents.
 * 
 * @param mcp - MCP client instance
 * @param path - File path (must be ./logs/** or ./docs/**)
 * @returns File content string, truncated to MAX_READ_CHARS
 * @throws Error("FS_PATH_BLOCKED") if path is invalid
 * 
 * Implementation:
 * - Calls read_file MCP tool
 * - Extracts all text blocks from result.content
 * - Concatenates texts in order
 * - Returns truncated string (first N chars)
 */
export async function fsRead(mcp: any, { path }: { path: string }): Promise<string> {
  validatePath(path);
  
  const result = await mcp.callTool(FS_SERVER_ID, FS_TOOL_READ, { path });
  
  // Extract and concatenate text blocks from MCP CallToolResult
  const texts = extractTextContent(result);
  const fullText = texts.join('');
  
  // Deterministic truncation: take first N characters
  return fullText.slice(0, MAX_READ_CHARS);
}

/**
 * Searches files for a query string (forced literal Glob search).
 * 
 * @param mcp - MCP client instance
 * @param path - Search root path (must be ./logs/** or ./docs/**)
 * @param query - Search query (treated as literal string, all glob metacharacters escaped)
 * @returns Array of matched file paths, truncated to MAX_HITS_PER_TOOL
 * @throws Error("FS_PATH_BLOCKED") if path is invalid
 * 
 * Implementation:
 * - Escapes query to literal glob pattern
 * - Calls search_files MCP tool with pattern parameter
 * - Extracts text blocks from result.content (each text = file path hit)
 * - Returns string array (deterministic truncation to MAX_HITS_PER_TOOL)
 * 
 * Parameter mapping:
 * - External API uses "query" for user-facing clarity
 * - Internal tool call uses "pattern" per search_files contract
 */
export async function fsSearch(mcp: any, { path, query }: { path: string; query: string }): Promise<string[]> {
  validatePath(path);
  
  // Force literal search: escape all glob metacharacters
  const literalPattern = escapeGlobLiteral(query);
  
  // Parameter mapping: query -> pattern
  const result = await mcp.callTool(FS_SERVER_ID, FS_TOOL_SEARCH, { 
    path, 
    pattern: literalPattern 
  });
  
  // Extract text blocks from MCP CallToolResult
  // Each text block represents a matched file path
  const texts = extractTextContent(result);
  
  // Deterministic truncation: take first N hits
  return texts.slice(0, MAX_HITS_PER_TOOL);
}
