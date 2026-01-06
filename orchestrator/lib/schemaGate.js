/**
 * schemaGate.js - Stage 2: Schema validation gate with warn/strict modes
 *
 * Hard rules (S2-1):
 * - warn mode: record to audit + metrics, never block
 * - strict mode:
 *   - ingress (HTTP boundaries): return structured error (caller decides 400)
 *   - internal (derive/daemon/executor): NEVER throw / NEVER return 500 semantics;
 *     always return { ok:false, code, errors } so caller can skip/block.
 * - HTTP body is NEVER modified by schemaGate (warnings go to audit/metrics/header only)
 *
 * Env vars:
 *   SCHEMA_GATE_MODE: 'off' | 'warn' | 'strict' (default: 'off')
 *   SCHEMA_GATE_EXPOSE_WARN_HEADER: 'true' | 'false' (default: 'false')
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const fs = require('fs');
const path = require('path');

// ============================================================
// WARN_CODE ENUM (stable, never match on strings in tests)
// ============================================================
const WARN_CODE = {
  MISSING: 'missing',           // required field missing
  TYPE_MISMATCH: 'type_mismatch', // type/enum mismatch
  UNKNOWN_FIELD: 'unknown_field',  // additionalProperties violation
  SCHEMA_INVALID: 'schema_invalid', // enum/oneOf/anyOf/format/... (non-type)
  TOOL_VERDICT_INVALID: 'tool_verdict_invalid' // non-standard tool_verdict value
};

// ============================================================
// BOUNDARY ENUM (for metrics label + audit)
// ============================================================
const BOUNDARY = {
  TICKET_CREATE: 'ticket_create',
  TICKET_COMPLETE: 'ticket_complete',
  TICKET_DERIVE: 'ticket_derive'
};

// ============================================================
// DIRECTION ENUM (ingress = HTTP, internal = derive/internal ops)
// ============================================================
const DIRECTION = {
  INGRESS: 'ingress',
  INTERNAL: 'internal'
};

// ============================================================
// KIND ENUM (ticket kind)
// ============================================================
const KIND = {
  TRIAGE: 'TRIAGE',
  TOOL: 'TOOL',
  REPLY: 'REPLY',
  UNKNOWN: 'UNKNOWN'
};

// ============================================================
// METRICS COUNTERS (in-memory, exposed via getMetrics())
// ============================================================
const metricsCounters = {
  // schema_warning_total{warn_code, kind, direction, boundary}
  warnings: new Map(),
  // schema_strict_reject_total{kind, direction, boundary}
  rejects: new Map()
};

function incrementCounter(counterMap, labels) {
  const key = JSON.stringify(labels);
  counterMap.set(key, (counterMap.get(key) || 0) + 1);
}

function getCounterValue(counterMap, labels) {
  const key = JSON.stringify(labels);
  return counterMap.get(key) || 0;
}

// ============================================================
// AJV SETUP
// ============================================================
let ajvInstance = null;
let ticketSchema = null;

function getAjv() {
  if (!ajvInstance) {
    ajvInstance = new Ajv({ allErrors: true, strict: false });
    addFormats(ajvInstance);
  }
  return ajvInstance;
}

function getTicketSchema() {
  if (!ticketSchema) {
    const schemaPath = path.resolve(__dirname, '../../schemas/ticket.json');
    if (fs.existsSync(schemaPath)) {
      ticketSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    } else {
      // Fallback: minimal schema that accepts anything (for tests without schema file)
      ticketSchema = { type: 'object' };
    }
  }
  return ticketSchema;
}

// ============================================================
// ERROR CLASSIFICATION
// ============================================================
function classifyAjvError(error) {
  const keyword = error.keyword;
  
  if (keyword === 'required') {
    return WARN_CODE.MISSING;
  }
  if (keyword === 'additionalProperties') {
    return WARN_CODE.UNKNOWN_FIELD;
  }

  // Keep type errors distinct; everything else is schema_invalid
  if (keyword === 'type') {
    return WARN_CODE.TYPE_MISMATCH;
  }
  return WARN_CODE.SCHEMA_INVALID;
}

function normalizeAjvPath(err) {
  const instancePath = err.instancePath || err.dataPath || '';

  if (err.keyword === 'required' && err.params && err.params.missingProperty) {
    const base = instancePath || '';
    return (base || '') + '/' + String(err.params.missingProperty);
  }

  if (err.keyword === 'additionalProperties' && err.params && err.params.additionalProperty) {
    const base = instancePath || '';
    return (base || '') + '/' + String(err.params.additionalProperty);
  }

  return instancePath || '/';
}

function extractWarnTypes(errors) {
  if (!errors || errors.length === 0) return [];
  const types = new Set();
  for (const err of errors) {
    types.add(classifyAjvError(err));
  }
  return Array.from(types);
}

// ============================================================
// AUDIT LOGGER INTEGRATION
// ============================================================
let auditLogFn = null;

/**
 * Set custom audit log function.
 * Signature: (entry: SchemaGateAuditEntry) => void
 */
function setAuditLogger(fn) {
  auditLogFn = fn;
}

function logAudit(entry) {
  if (auditLogFn) {
    auditLogFn(entry);
  }
}

// ============================================================
// MAIN VALIDATION FUNCTION
// ============================================================

/**
 * Validate data against ticket schema.
 * 
 * @param {Object} data - Data to validate
 * @param {Object} options - Validation options
 * @param {string} options.boundary - BOUNDARY enum value
 * @param {string} options.direction - DIRECTION enum value
 * @param {string} options.kind - KIND enum value (optional, will extract from data if not provided)
 * @param {string} options.ticketId - Ticket ID for audit (optional)
 * @param {string} options.requestId - Request ID for audit (optional)
 * @param {string} options.schemaRef - Schema reference (default: 'ticket.json')
 * @returns {Object} { valid, warnings, warnCount, warnTypes, errors }
 */
function validate(data, options = {}) {
  const mode = process.env.SCHEMA_GATE_MODE || 'off';
  
  // If off, skip validation entirely
  if (mode === 'off') {
    return { valid: true, warnings: [], warnCount: 0, warnTypes: [], errors: null, mode: 'off' };
  }
  
  const {
    boundary = BOUNDARY.TICKET_CREATE,
    direction = DIRECTION.INGRESS,
    kind = extractKind(data),
    ticketId = data?.id || null,
    requestId = null,
    schemaRef = 'ticket.json'
  } = options;
  
  const ajv = getAjv();
  const schema = getTicketSchema();
  
  // Compile validator (cached by AJV)
  let validateFn;
  try {
    validateFn = ajv.compile(schema);
  } catch (e) {
    // Schema compilation error - treat as internal error
    console.error('[schemaGate] Schema compilation error:', e.message);
    return { valid: true, warnings: [], warnCount: 0, warnTypes: [], errors: null, mode, compileError: e.message };
  }
  
  const isValid = validateFn(data);
  const ajvErrors = validateFn.errors || [];
  
  // Build warnings from errors
  const warnings = ajvErrors.map(err => ({
    warn_code: classifyAjvError(err),
    path: normalizeAjvPath(err),
    keyword: err.keyword
  }));

  const warnCodes = extractWarnTypes(ajvErrors);
  const warnCount = warnings.length;
  
  // Record metrics for each warning
  for (const w of warnings) {
    incrementCounter(metricsCounters.warnings, {
      warn_code: w.warn_code,
      kind,
      direction,
      boundary
    });
  }
  
  // Log to audit
  if (warnCount > 0) {
    logAudit({
      ts: new Date().toISOString(),
      action: 'schema_gate_warn',
      boundary,
      direction,
      ticket_id: ticketId,
      request_id: requestId,
      kind,
      warn_count: warnCount,
      warn_codes: warnCodes,
      errors: warnings.map(w => ({
        path: w.path,
        keyword: w.keyword
      })),
      schema_ref: schemaRef,
      mode
    });
  }
  
  return {
    valid: isValid,
    warnings,
    warnCount,
    warnTypes: warnCodes,
    warnCodes,
    errors: isValid ? null : ajvErrors,
    mode
  };
}

/**
 * Extract kind from ticket data
 */
function extractKind(data) {
  if (!data) return KIND.UNKNOWN;
  const kind = data.metadata?.kind;
  if (kind === 'TRIAGE' || kind === 'TOOL' || kind === 'REPLY') {
    return kind;
  }
  return KIND.UNKNOWN;
}

// ============================================================
// GATE FUNCTION (for use at write boundaries)
// ============================================================

/**
 * Gate function that validates and optionally blocks based on mode.
 * 
 * @param {Object} data - Data to validate
 * @param {Object} options - Same as validate() options
 * @returns {Object} { allowed, result, httpStatus, errorCode }
 */
function gateIngress(data, options = {}) {
  const mode = process.env.SCHEMA_GATE_MODE || 'off';
  const result = validate(data, { ...options, direction: DIRECTION.INGRESS });

  if (mode === 'off' || mode === 'warn' || result.valid) {
    return {
      ok: true,
      code: null,
      httpStatus: null,
      result
    };
  }

  // strict + invalid
  incrementCounter(metricsCounters.rejects, {
    kind: options.kind || extractKind(data),
    direction: DIRECTION.INGRESS,
    boundary: options.boundary || BOUNDARY.TICKET_CREATE
  });

  logAudit({
    ts: new Date().toISOString(),
    action: 'schema_gate_reject',
    boundary: options.boundary || BOUNDARY.TICKET_CREATE,
    direction: DIRECTION.INGRESS,
    ticket_id: options.ticketId || null,
    request_id: options.requestId || null,
    kind: options.kind || extractKind(data),
    warn_count: result.warnCount || 0,
    warn_codes: result.warnCodes || result.warnTypes || [],
    errors: Array.isArray(result.warnings)
      ? result.warnings.map(w => ({ path: w.path || '/', keyword: w.keyword || 'ajv' }))
      : [],
    schema_ref: options.schemaRef || 'ticket.json',
    mode,
    code: 'SCHEMA_VALIDATION_FAILED'
  });

  return {
    ok: false,
    code: 'SCHEMA_VALIDATION_FAILED',
    httpStatus: 400,
    result
  };
}

function gateInternal(data, options = {}) {
  const mode = process.env.SCHEMA_GATE_MODE || 'off';
  const result = validate(data, { ...options, direction: DIRECTION.INTERNAL });

  if (mode === 'off' || mode === 'warn' || result.valid) {
    return {
      ok: true,
      code: null,
      result
    };
  }

  // strict + invalid
  incrementCounter(metricsCounters.rejects, {
    kind: options.kind || extractKind(data),
    direction: DIRECTION.INTERNAL,
    boundary: options.boundary || BOUNDARY.TICKET_CREATE
  });

  logAudit({
    ts: new Date().toISOString(),
    action: 'schema_gate_reject',
    boundary: options.boundary || BOUNDARY.TICKET_CREATE,
    direction: DIRECTION.INTERNAL,
    ticket_id: options.ticketId || null,
    request_id: options.requestId || null,
    kind: options.kind || extractKind(data),
    warn_count: result.warnCount || 0,
    warn_codes: result.warnCodes || result.warnTypes || [],
    errors: Array.isArray(result.warnings)
      ? result.warnings.map(w => ({ path: w.path || '/', keyword: w.keyword || 'ajv' }))
      : [],
    schema_ref: options.schemaRef || 'ticket.json',
    mode,
    code: 'SCHEMA_VALIDATION_FAILED'
  });

  // Never throw, never return 500 semantics for internal.
  return {
    ok: false,
    code: 'SCHEMA_VALIDATION_FAILED',
    result
  };
}

/**
 * Backward-compatible wrapper.
 * @deprecated Use gateIngress() / gateInternal() instead.
 */
function gate(data, options = {}) {
  const direction = options.direction || DIRECTION.INGRESS;
  const gated = direction === DIRECTION.INTERNAL
    ? gateInternal(data, options)
    : gateIngress(data, options);

  return {
    allowed: Boolean(gated.ok),
    result: gated.result,
    httpStatus: gated.httpStatus || null,
    errorCode: gated.code || null
  };
}

/**
 * Emit a stable warning that is not sourced from AJV (e.g. toolVerdictCompat).
 * Does NOT validate schema; only records audit+metrics.
 */
function safePreview(value, maxLen = 240) {
  if (value === null || value === undefined) return null;
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '…';
  } catch (_) {
    return String(value).slice(0, maxLen);
  }
}

function emitWarning(entry) {
  const {
    warn_code,
    boundary = BOUNDARY.TICKET_DERIVE,
    direction = DIRECTION.INTERNAL,
    kind = KIND.UNKNOWN,
    ticket_id = null,
    request_id = null,
    errors = [],
    schema_ref = 'ticket.json',
    note = undefined,
    details = undefined
  } = entry || {};

  if (!warn_code) return;

  incrementCounter(metricsCounters.warnings, {
    warn_code,
    kind,
    direction,
    boundary
  });

  logAudit({
    ts: new Date().toISOString(),
    action: 'schema_gate_warn',
    boundary,
    direction,
    ticket_id,
    request_id,
    kind,
    warn_count: 1,
    warn_codes: [warn_code],
    errors: (Array.isArray(errors) ? errors : []).map(e => ({
      path: e.path || '/',
      keyword: e.keyword || 'external'
    })),
    schema_ref,
    mode: process.env.SCHEMA_GATE_MODE || 'off',
    message: note,
    details: details
      ? {
          ...details,
          raw_type: Object.prototype.toString.call(details.raw).slice(8, -1),
          raw_preview: safePreview(details.raw)
        }
      : undefined
  });
}

// ============================================================
// METRICS EXPORT (for /metrics endpoint)
// ============================================================

/**
 * Get current schema gate metrics
 * @returns {Object} { schema_warning_total: {...}, schema_strict_reject_total: {...} }
 */
function getMetrics() {
  const warningsByLabel = {};
  const warningsByDim = [];
  for (const [key, count] of metricsCounters.warnings.entries()) {
    warningsByLabel[key] = count;
    try {
      const labels = JSON.parse(key);
      warningsByDim.push({ ...labels, count });
    } catch (_) {
      // ignore
    }
  }

  const rejectsByLabel = {};
  const rejectsByDim = [];
  for (const [key, count] of metricsCounters.rejects.entries()) {
    rejectsByLabel[key] = count;
    try {
      const labels = JSON.parse(key);
      rejectsByDim.push({ ...labels, count });
    } catch (_) {
      // ignore
    }
  }
  
  // Also compute totals
  let warningTotal = 0;
  for (const count of metricsCounters.warnings.values()) {
    warningTotal += count;
  }
  
  let rejectTotal = 0;
  for (const count of metricsCounters.rejects.values()) {
    rejectTotal += count;
  }
  
  return {
    schema_warning_total: warningTotal,
    schema_warning_by_label: warningsByLabel,
    schema_warning_by_dim: warningsByDim,
    schema_strict_reject_total: rejectTotal,
    schema_strict_reject_by_label: rejectsByLabel,
    schema_strict_reject_by_dim: rejectsByDim
  };
}

/**
 * Reset metrics (for testing)
 */
function resetMetrics() {
  metricsCounters.warnings.clear();
  metricsCounters.rejects.clear();
}

// ============================================================
// HEADER HELPER
// ============================================================

/**
 * Set schema warning header if enabled and warnings exist
 * @param {Object} res - Express response object
 * @param {number} warnCount - Warning count
 */
function setWarnHeader(res, warnCount) {
  if (process.env.SCHEMA_GATE_EXPOSE_WARN_HEADER === 'true' && warnCount > 0) {
    res.setHeader('X-Schema-Warn-Count', String(warnCount));
  }
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  // Enums
  WARN_CODE,
  BOUNDARY,
  DIRECTION,
  KIND,
  
  // Core functions
  validate,
  gate,
  gateIngress,
  gateInternal,
  emitWarning,
  
  // Metrics
  getMetrics,
  resetMetrics,
  
  // Audit
  setAuditLogger,
  
  // Header helper
  setWarnHeader,
  
  // For testing
  extractKind,
  classifyAjvError,
  getAjv,
  getTicketSchema
};
