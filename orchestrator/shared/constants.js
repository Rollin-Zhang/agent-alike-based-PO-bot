/**
 * Shared Constants for Agent-alike PO Bot
 * 
 * This module serves as the single source of truth (SSOT) for:
 * - Environment variable keys
 * - Hard-limit constants (search budgets, timeouts, etc.)
 * - Entity and relation type definitions
 * 
 * Usage:
 * - Orchestrator: require('./shared/constants')
 * - Extension: import from './shared/constants' (with .d.ts for typing)
 */

// ═══════════════════════════════════════════════════════════════════════════
// Environment Variable Keys (SSOT)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Canonical environment variable key names.
 * Use these constants instead of hardcoding string literals.
 */
const ENV_KEYS = Object.freeze({
  ENABLE_TOOL_DERIVATION: 'ENABLE_TOOL_DERIVATION',
  TOOL_ONLY_MODE: 'TOOL_ONLY_MODE',
  ORCH_ROOT: 'ORCH_ROOT',
  MEMORY_FILE_PATH: 'MEMORY_FILE_PATH',
  ENABLE_TICKET_SCHEMA_VALIDATION: 'ENABLE_TICKET_SCHEMA_VALIDATION'
});

// ═══════════════════════════════════════════════════════════════════════════
// Runtime Environment Resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve runtime environment configuration.
 * Reads the five planned environment variables with explicit fallbacks.
 * 
 * Returns a fully defined object (no undefined values).
 * Does NOT add validation, guards, or logging (except where explicitly stated).
 * Applies the SAME fallbacks as would be used in future code.
 * 
 * @returns {Object} Resolved environment configuration
 */
function resolveRuntimeEnv() {
  return Object.freeze({
    enableToolDerivation: process.env[ENV_KEYS.ENABLE_TOOL_DERIVATION] === 'true',
    toolOnlyMode: process.env[ENV_KEYS.TOOL_ONLY_MODE] === 'true',
    orchRoot: process.env[ENV_KEYS.ORCH_ROOT] || process.cwd(),
    memoryFilePath: process.env[ENV_KEYS.MEMORY_FILE_PATH] || './data/memory.json',
    enableTicketSchemaValidation: process.env[ENV_KEYS.ENABLE_TICKET_SCHEMA_VALIDATION] === 'true'
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Hard-Limit Constants (Search & Evidence Budgets)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Maximum number of search hits to retrieve per tool invocation.
 */
const MAX_HITS_PER_TOOL = 50;

/**
 * Maximum characters to extract from each search hit.
 */
const MAX_CHARS_PER_HIT = 200;

/**
 * Maximum total characters for all evidence combined.
 */
const MAX_TOTAL_EVIDENCE_CHARS = 30000;

/**
 * Timeout in milliseconds for quick search operations.
 */
const QUICK_SEARCH_TIMEOUT_MS = 10000;

// ═══════════════════════════════════════════════════════════════════════════
// Filesystem Path Allowlist
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Allowed filesystem paths for read/write operations.
 * Used for future filesystem access control.
 */
const ALLOWED_FS_PATHS = Object.freeze(['./logs', './docs']);

// ═══════════════════════════════════════════════════════════════════════════
// Entity and Relation Type Definitions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Valid entity types for knowledge graph operations.
 */
const ENTITY_TYPES = Object.freeze([
  'Person',
  'Org',
  'Event',
  'Policy',
  'Claim',
  'Source'
]);

/**
 * Valid relation types for knowledge graph edges.
 */
const RELATION_TYPES = Object.freeze([
  'related_to',
  'claims',
  'supports',
  'opposes',
  'occurred_at',
  'mentions'
]);

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  ENV_KEYS,
  resolveRuntimeEnv,
  MAX_HITS_PER_TOOL,
  MAX_CHARS_PER_HIT,
  MAX_TOTAL_EVIDENCE_CHARS,
  QUICK_SEARCH_TIMEOUT_MS,
  ALLOWED_FS_PATHS,
  ENTITY_TYPES,
  RELATION_TYPES
};
