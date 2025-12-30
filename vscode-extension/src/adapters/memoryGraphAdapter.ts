/**
 * Memory Graph Adapter - Single choke point for all memory MCP operations
 * 
 * Commit 9c: Knowledge Graph Client Hardening
 * - Tool whitelist enforcement (read-only: read_graph, search_nodes, open_nodes)
 * - Schema validation for entities and relations
 * - Schema drift detection
 * - Deterministic error codes (no details in error messages)
 * 
 * Security guarantees:
 * - Write operations blocked at client (MEM_TOOL_FORBIDDEN)
 * - Unknown entity types flagged (MEM_ENTITY_TYPE_UNKNOWN)
 * - Schema drift detected early (MEM_SCHEMA_DRIFT)
 * - All memory access must go through this adapter
 */

import { extractTextContent, parseJsonFromResult } from './mcpUtils';
import { ENTITY_TYPES, RELATION_TYPES } from '../../../orchestrator/shared/constants';

// ============================================================================
// TOOL CONTRACT LOCK (Pinned SSOT, hardcoded from @modelcontextprotocol/server-memory)
// ============================================================================

const MEMORY_SERVER_ID = "memory";
const TOOL_READ_GRAPH = "read_graph";
const TOOL_SEARCH_NODES = "search_nodes";
const TOOL_OPEN_NODES = "open_nodes";

// ============================================================================
// TOOL WHITELIST (Read-only operations only)
// ============================================================================

/**
 * Allowed tools for this adapter.
 * Write operations (create_*, add_*, delete_*) are intentionally excluded.
 */
const ALLOWED_MEMORY_TOOLS = new Set([
  TOOL_READ_GRAPH,
  TOOL_SEARCH_NODES,
  TOOL_OPEN_NODES
]);

// ============================================================================
// ERROR CODES (Pure codes, no suffix or detail in message)
// ============================================================================

const MEM_TOOL_FORBIDDEN = "MEM_TOOL_FORBIDDEN";
const MEM_SCHEMA_INVALID = "MEM_SCHEMA_INVALID";
const MEM_SCHEMA_DRIFT = "MEM_SCHEMA_DRIFT";
const MEM_ENTITY_TYPE_UNKNOWN = "MEM_ENTITY_TYPE_UNKNOWN";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface Entity {
  type?: string;       // "entity" (from server)
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  type?: string;       // "relation" (from server)
  from: string;
  to: string;
  relationType: string;
}

export interface GraphData {
  entities: Entity[];
  relations: Relation[];
}

export interface Evidence {
  source: string;
  content: string;
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
  schema_warnings?: string[];
}

// ============================================================================
// TOOL WHITELIST ENFORCEMENT
// ============================================================================

/**
 * Asserts that the requested tool is in the allowed whitelist.
 * Throws error code only (no tool name in error message).
 */
function assertAllowedTool(toolName: string): void {
  if (!ALLOWED_MEMORY_TOOLS.has(toolName)) {
    throw new Error(MEM_TOOL_FORBIDDEN);
  }
}

// ============================================================================
// SCHEMA VALIDATION
// ============================================================================

/**
 * Validates entity structure and checks for known entity types.
 * Returns warnings for unknown types (does not throw).
 */
function validateEntity(entity: any): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  // Required fields
  if (typeof entity?.name !== 'string' || entity.name.length === 0) {
    return { valid: false, warnings: ['Entity missing name'] };
  }
  
  if (typeof entity?.entityType !== 'string' || entity.entityType.length === 0) {
    return { valid: false, warnings: ['Entity missing entityType'] };
  }
  
  if (!Array.isArray(entity?.observations)) {
    return { valid: false, warnings: ['Entity missing observations array'] };
  }
  
  // Check for known entity types
  const knownTypes = new Set(ENTITY_TYPES);
  if (!knownTypes.has(entity.entityType)) {
    warnings.push(`${MEM_ENTITY_TYPE_UNKNOWN}: ${entity.entityType}`);
  }
  
  return { valid: true, warnings };
}

/**
 * Validates relation structure.
 */
function validateRelation(relation: any): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  if (typeof relation?.from !== 'string' || relation.from.length === 0) {
    return { valid: false, warnings: ['Relation missing from'] };
  }
  
  if (typeof relation?.to !== 'string' || relation.to.length === 0) {
    return { valid: false, warnings: ['Relation missing to'] };
  }
  
  if (typeof relation?.relationType !== 'string' || relation.relationType.length === 0) {
    return { valid: false, warnings: ['Relation missing relationType'] };
  }
  
  // Check for known relation types
  const knownTypes = new Set(RELATION_TYPES);
  if (!knownTypes.has(relation.relationType)) {
    warnings.push(`Unknown relation type: ${relation.relationType}`);
  }
  
  return { valid: true, warnings };
}

/**
 * Validates graph data structure (top-level keys).
 */
function validateGraphSchema(data: any): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  if (!data || typeof data !== 'object') {
    return { valid: false, warnings: [MEM_SCHEMA_INVALID] };
  }
  
  // Check for expected top-level keys
  const expectedKeys = new Set(['entities', 'relations']);
  const actualKeys = new Set(Object.keys(data));
  
  // Detect schema drift (unexpected keys)
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) {
      warnings.push(`${MEM_SCHEMA_DRIFT}: unexpected key "${key}"`);
    }
  }
  
  // Check required arrays
  if (!Array.isArray(data.entities)) {
    return { valid: false, warnings: [`${MEM_SCHEMA_INVALID}: entities not array`] };
  }
  
  if (!Array.isArray(data.relations)) {
    return { valid: false, warnings: [`${MEM_SCHEMA_INVALID}: relations not array`] };
  }
  
  return { valid: true, warnings };
}

// ============================================================================
// EVIDENCE TRANSFORMATION
// ============================================================================

/**
 * Transforms validated graph data into evidence array.
 */
function graphToEvidence(data: GraphData): Evidence[] {
  const evidence: Evidence[] = [];
  
  // Transform entities
  for (const entity of data.entities) {
    const content = entity.observations.length > 0
      ? entity.observations.join('; ')
      : `[${entity.entityType}]`;
    
    evidence.push({
      source: `entity:${entity.name}`,
      content,
      entity_type: entity.entityType
    });
  }
  
  // Transform relations
  for (const relation of data.relations) {
    evidence.push({
      source: `relation:${relation.from}->${relation.to}`,
      content: `${relation.from} ${relation.relationType} ${relation.to}`,
      relation_type: relation.relationType
    });
  }
  
  return evidence;
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
 * Reads the entire knowledge graph.
 */
export async function readGraph(mcp: McpClient): Promise<AdapterResult> {
  const tool_trace: ToolTraceEntry[] = [];
  const timestamp = new Date().toISOString();
  
  try {
    assertAllowedTool(TOOL_READ_GRAPH);
    
    const result = await mcp.callTool(MEMORY_SERVER_ID, TOOL_READ_GRAPH, {});
    
    tool_trace.push({
      tool_name: TOOL_READ_GRAPH,
      timestamp
    });
    
    const data = parseJsonFromResult(result);
    
    if (!data) {
      return {
        evidence: [],
        error: MEM_SCHEMA_INVALID,
        detail: { reason: 'Failed to parse result as JSON' },
        tool_trace
      };
    }
    
    const schemaValidation = validateGraphSchema(data);
    if (!schemaValidation.valid) {
      return {
        evidence: [],
        error: MEM_SCHEMA_INVALID,
        detail: { warnings: schemaValidation.warnings },
        tool_trace
      };
    }
    
    // Validate individual entities and relations
    const allWarnings: string[] = [...schemaValidation.warnings];
    
    for (const entity of data.entities) {
      const { warnings } = validateEntity(entity);
      allWarnings.push(...warnings);
    }
    
    for (const relation of data.relations) {
      const { warnings } = validateRelation(relation);
      allWarnings.push(...warnings);
    }
    
    const evidence = graphToEvidence(data);
    
    return {
      evidence,
      tool_trace,
      schema_warnings: allWarnings.length > 0 ? allWarnings : undefined
    };
    
  } catch (err: any) {
    if (err.message === MEM_TOOL_FORBIDDEN) {
      tool_trace.push({
        tool_name: MEMORY_SERVER_ID,
        error: MEM_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_READ_GRAPH }
      });
      
      return {
        evidence: [],
        error: MEM_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_READ_GRAPH },
        tool_trace
      };
    }
    
    return {
      evidence: [],
      error: 'MEM_CALL_FAILED',
      detail: { message: err.message },
      tool_trace
    };
  }
}

/**
 * Searches for nodes matching a query.
 */
export async function searchNodes(
  mcp: McpClient,
  params: { query: string }
): Promise<AdapterResult> {
  const tool_trace: ToolTraceEntry[] = [];
  const timestamp = new Date().toISOString();
  
  try {
    assertAllowedTool(TOOL_SEARCH_NODES);
    
    const result = await mcp.callTool(MEMORY_SERVER_ID, TOOL_SEARCH_NODES, {
      query: params.query
    });
    
    tool_trace.push({
      tool_name: TOOL_SEARCH_NODES,
      timestamp,
      detail: { query: params.query }
    });
    
    const data = parseJsonFromResult(result);
    
    if (!data) {
      return {
        evidence: [],
        error: MEM_SCHEMA_INVALID,
        detail: { reason: 'Failed to parse result as JSON' },
        tool_trace
      };
    }
    
    const schemaValidation = validateGraphSchema(data);
    if (!schemaValidation.valid) {
      return {
        evidence: [],
        error: MEM_SCHEMA_INVALID,
        detail: { warnings: schemaValidation.warnings },
        tool_trace
      };
    }
    
    const allWarnings: string[] = [...schemaValidation.warnings];
    
    for (const entity of data.entities) {
      const { warnings } = validateEntity(entity);
      allWarnings.push(...warnings);
    }
    
    for (const relation of data.relations) {
      const { warnings } = validateRelation(relation);
      allWarnings.push(...warnings);
    }
    
    const evidence = graphToEvidence(data);
    
    return {
      evidence,
      tool_trace,
      schema_warnings: allWarnings.length > 0 ? allWarnings : undefined
    };
    
  } catch (err: any) {
    if (err.message === MEM_TOOL_FORBIDDEN) {
      tool_trace.push({
        tool_name: MEMORY_SERVER_ID,
        error: MEM_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_SEARCH_NODES }
      });
      
      return {
        evidence: [],
        error: MEM_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_SEARCH_NODES },
        tool_trace
      };
    }
    
    return {
      evidence: [],
      error: 'MEM_CALL_FAILED',
      detail: { message: err.message },
      tool_trace
    };
  }
}

/**
 * Opens specific nodes by their names.
 */
export async function openNodes(
  mcp: McpClient,
  params: { names: string[] }
): Promise<AdapterResult> {
  const tool_trace: ToolTraceEntry[] = [];
  const timestamp = new Date().toISOString();
  
  try {
    assertAllowedTool(TOOL_OPEN_NODES);
    
    const result = await mcp.callTool(MEMORY_SERVER_ID, TOOL_OPEN_NODES, {
      names: params.names
    });
    
    tool_trace.push({
      tool_name: TOOL_OPEN_NODES,
      timestamp,
      detail: { names: params.names }
    });
    
    const data = parseJsonFromResult(result);
    
    if (!data) {
      return {
        evidence: [],
        error: MEM_SCHEMA_INVALID,
        detail: { reason: 'Failed to parse result as JSON' },
        tool_trace
      };
    }
    
    const schemaValidation = validateGraphSchema(data);
    if (!schemaValidation.valid) {
      return {
        evidence: [],
        error: MEM_SCHEMA_INVALID,
        detail: { warnings: schemaValidation.warnings },
        tool_trace
      };
    }
    
    const allWarnings: string[] = [...schemaValidation.warnings];
    
    for (const entity of data.entities) {
      const { warnings } = validateEntity(entity);
      allWarnings.push(...warnings);
    }
    
    for (const relation of data.relations) {
      const { warnings } = validateRelation(relation);
      allWarnings.push(...warnings);
    }
    
    const evidence = graphToEvidence(data);
    
    return {
      evidence,
      tool_trace,
      schema_warnings: allWarnings.length > 0 ? allWarnings : undefined
    };
    
  } catch (err: any) {
    if (err.message === MEM_TOOL_FORBIDDEN) {
      tool_trace.push({
        tool_name: MEMORY_SERVER_ID,
        error: MEM_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_OPEN_NODES }
      });
      
      return {
        evidence: [],
        error: MEM_TOOL_FORBIDDEN,
        detail: { attempted_tool: TOOL_OPEN_NODES },
        tool_trace
      };
    }
    
    return {
      evidence: [],
      error: 'MEM_CALL_FAILED',
      detail: { message: err.message },
      tool_trace
    };
  }
}

// ============================================================================
// EXPORTS (for testing forbidden tool behavior)
// ============================================================================

export const _testing = {
  assertAllowedTool,
  MEM_TOOL_FORBIDDEN,
  MEM_SCHEMA_INVALID,
  MEM_SCHEMA_DRIFT,
  MEM_ENTITY_TYPE_UNKNOWN,
  ALLOWED_MEMORY_TOOLS
};
