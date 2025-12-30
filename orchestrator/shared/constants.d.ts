/**
 * TypeScript type definitions for shared/constants.js
 * 
 * Provides type safety for TypeScript consumers (e.g., VS Code extension)
 * while keeping the runtime source as pure CommonJS.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Environment Variable Keys
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical environment variable key names.
 */
export const ENV_KEYS: Readonly<{
  ENABLE_TOOL_DERIVATION: 'ENABLE_TOOL_DERIVATION';
  TOOL_ONLY_MODE: 'TOOL_ONLY_MODE';
  ORCH_ROOT: 'ORCH_ROOT';
  MEMORY_FILE_PATH: 'MEMORY_FILE_PATH';
  ENABLE_TICKET_SCHEMA_VALIDATION: 'ENABLE_TICKET_SCHEMA_VALIDATION';
}>;

// ═══════════════════════════════════════════════════════════════════════════
// Runtime Environment Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolved runtime environment configuration.
 */
export interface RuntimeEnv {
  enableToolDerivation: boolean;
  toolOnlyMode: boolean;
  orchRoot: string;
  memoryFilePath: string;
  enableTicketSchemaValidation: boolean;
}

/**
 * Resolve runtime environment configuration with defaults.
 */
export function resolveRuntimeEnv(): Readonly<RuntimeEnv>;

// ═══════════════════════════════════════════════════════════════════════════
// Hard-Limit Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Maximum number of search hits to retrieve per tool invocation.
 */
export const MAX_HITS_PER_TOOL: 50;

/**
 * Maximum characters to extract from each search hit.
 */
export const MAX_CHARS_PER_HIT: 200;

/**
 * Multiplier for read operations (read_file returns full content vs. search hit excerpts).
 * NOTE: This is a temporary scalar. Commit 11 will replace with empirical tuning.
 */
export const READ_MULTIPLIER: 10;

/**
 * Maximum characters to read from a single file via fsRead.
 * Derived from MAX_CHARS_PER_HIT to maintain proportional limits.
 */
export const MAX_READ_CHARS: number;

/**
 * Maximum total characters for all evidence combined.
 */
export const MAX_TOTAL_EVIDENCE_CHARS: 30000;

/**
 * Timeout in milliseconds for quick search operations.
 */
export const QUICK_SEARCH_TIMEOUT_MS: 10000;

// ═══════════════════════════════════════════════════════════════════════════
// Filesystem Path Allowlist
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Allowed filesystem paths for read/write operations.
 */
export const ALLOWED_FS_PATHS: readonly ['./logs', './docs'];

// ═══════════════════════════════════════════════════════════════════════════
// Entity and Relation Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recommended entity types for knowledge graph operations.
 * Lowercase to match common conventions (probed from official server).
 */
export const ENTITY_TYPES: readonly [
  'person',
  'organization',
  'event',
  'policy',
  'claim',
  'source',
  'location'
];

/**
 * Recommended relation types for knowledge graph edges.
 * Based on common knowledge graph patterns.
 */
export const RELATION_TYPES: readonly [
  'works_at',
  'located_in',
  'related_to',
  'claims',
  'supports',
  'opposes',
  'occurred_at',
  'mentions',
  'member_of',
  'part_of'
];
