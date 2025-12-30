/**
 * MCP Utilities - Shared helpers for MCP result parsing
 * 
 * Commit 9c: Extracted from fsAdapter for reuse across adapters
 */

/**
 * Extracts text content from MCP CallToolResult.
 * 
 * CallToolResult structure (MCP Protocol Standard):
 * {
 *   content: ContentBlock[],
 *   isError?: boolean
 * }
 * 
 * ContentBlock can be:
 * - { type: "text", text: string }
 * - { type: "image", data: string, mimeType: string }
 * - { type: "resource", ... }
 * 
 * We only extract text blocks, ignore other types (no error thrown).
 * 
 * @param result - MCP CallToolResult
 * @returns Array of text strings from text blocks
 */
export function extractTextContent(result: any): string[] {
  if (!result || !Array.isArray(result.content)) {
    return [];
  }
  
  const texts: string[] = [];
  
  for (const block of result.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    }
    // Ignore non-text blocks (image, resource, etc.)
  }
  
  return texts;
}

/**
 * Parses JSON from the first text block of an MCP result.
 * Returns null if parsing fails or no text content found.
 * 
 * @param result - MCP CallToolResult
 * @returns Parsed JSON object or null
 */
export function parseJsonFromResult(result: any): any {
  const texts = extractTextContent(result);
  if (texts.length === 0) {
    return null;
  }
  
  try {
    return JSON.parse(texts[0]);
  } catch {
    return null;
  }
}
