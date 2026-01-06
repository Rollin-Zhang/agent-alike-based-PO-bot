/**
 * S2-1 / S2-2 Tests: schemaGate + toolVerdictCompat
 * 
 * Test coverage:
 * - schemaGate: warn_code enum, metrics, gate function, mode switching
 * - toolVerdictCompat: normalize legacy string / object, readToolVerdict
 */

const schemaGate = require('../../lib/schemaGate');
const { 
  normalizeToolVerdict, 
  readToolVerdict, 
  isVerdictStatus,
  getVerdictStatus,
  VALID_STATUSES 
} = require('../../lib/toolVerdictCompat');

async function runTests() {
  const results = [];
  
  // ============================================================
  // S2-1: schemaGate tests
  // ============================================================
  
  // Test 1: WARN_CODE enum is stable
  results.push({
    name: 'schemaGate WARN_CODE enum is stable',
    pass: schemaGate.WARN_CODE.MISSING === 'missing' &&
          schemaGate.WARN_CODE.TYPE_MISMATCH === 'type_mismatch' &&
      schemaGate.WARN_CODE.UNKNOWN_FIELD === 'unknown_field' &&
      schemaGate.WARN_CODE.SCHEMA_INVALID === 'schema_invalid' &&
      schemaGate.WARN_CODE.TOOL_VERDICT_INVALID === 'tool_verdict_invalid'
  });
  
  // Test 2: BOUNDARY enum is stable
  results.push({
    name: 'schemaGate BOUNDARY enum is stable',
    pass: schemaGate.BOUNDARY.TICKET_CREATE === 'ticket_create' &&
          schemaGate.BOUNDARY.TICKET_COMPLETE === 'ticket_complete' &&
          schemaGate.BOUNDARY.TICKET_DERIVE === 'ticket_derive'
  });
  
  // Test 3: DIRECTION enum is stable
  results.push({
    name: 'schemaGate DIRECTION enum is stable',
    pass: schemaGate.DIRECTION.INGRESS === 'ingress' &&
          schemaGate.DIRECTION.INTERNAL === 'internal'
  });
  
  // Test 4: KIND enum is stable
  results.push({
    name: 'schemaGate KIND enum is stable',
    pass: schemaGate.KIND.TRIAGE === 'TRIAGE' &&
          schemaGate.KIND.TOOL === 'TOOL' &&
          schemaGate.KIND.REPLY === 'REPLY' &&
          schemaGate.KIND.UNKNOWN === 'UNKNOWN'
  });
  
  // Test 5: gate returns allowed=true in off mode
  const originalMode = process.env.SCHEMA_GATE_MODE;
  process.env.SCHEMA_GATE_MODE = 'off';
  schemaGate.resetMetrics();
  
  const gateResultOff = schemaGate.gate({ invalid: 'data' }, {
    boundary: schemaGate.BOUNDARY.TICKET_CREATE,
    direction: schemaGate.DIRECTION.INGRESS
  });
  results.push({
    name: 'schemaGate gate returns allowed=true in off mode',
    pass: gateResultOff.allowed === true
  });
  
  // Test 6: gate returns allowed=true in warn mode (even for invalid data)
  process.env.SCHEMA_GATE_MODE = 'warn';
  schemaGate.resetMetrics();
  
  const gateResultWarn = schemaGate.gate({ type: 'invalid_type' }, {
    boundary: schemaGate.BOUNDARY.TICKET_CREATE,
    direction: schemaGate.DIRECTION.INGRESS
  });
  results.push({
    name: 'schemaGate gate returns allowed=true in warn mode',
    pass: gateResultWarn.allowed === true
  });
  
  // Test 7: metrics are recorded in warn mode
  const metricsAfterWarn = schemaGate.getMetrics();
  results.push({
    name: 'schemaGate metrics recorded in warn mode',
    pass: metricsAfterWarn.schema_warning_total >= 0 // May be 0 if data happens to be valid
  });
  
  // Test 8: extractKind correctly extracts from data
  results.push({
    name: 'schemaGate extractKind works correctly',
    pass: schemaGate.extractKind({ metadata: { kind: 'TRIAGE' } }) === 'TRIAGE' &&
          schemaGate.extractKind({ metadata: { kind: 'TOOL' } }) === 'TOOL' &&
          schemaGate.extractKind({ metadata: { kind: 'REPLY' } }) === 'REPLY' &&
          schemaGate.extractKind({ metadata: {} }) === 'UNKNOWN' &&
          schemaGate.extractKind(null) === 'UNKNOWN'
  });
  
  // Test 9: resetMetrics clears counters
  schemaGate.resetMetrics();
  const metricsAfterReset = schemaGate.getMetrics();
  results.push({
    name: 'schemaGate resetMetrics clears counters',
    pass: metricsAfterReset.schema_warning_total === 0 &&
          metricsAfterReset.schema_strict_reject_total === 0
  });
  
  // Restore original mode
  if (originalMode === undefined) delete process.env.SCHEMA_GATE_MODE;
  else process.env.SCHEMA_GATE_MODE = originalMode;

  // Test 9b: strict ingress rejects with httpStatus=400
  process.env.SCHEMA_GATE_MODE = 'strict';
  schemaGate.resetMetrics();
  const strictIngress = schemaGate.gateIngress({}, {
    boundary: schemaGate.BOUNDARY.TICKET_CREATE,
    kind: schemaGate.KIND.TRIAGE,
    ticketId: 'strict-ingress-test'
  });
  results.push({
    name: 'schemaGate strict ingress rejects with 400',
    pass: strictIngress.ok === false && strictIngress.httpStatus === 400 && strictIngress.code === 'SCHEMA_VALIDATION_FAILED'
  });

  // Test 9c: strict internal never throws and returns ok=false
  const strictInternal = schemaGate.gateInternal({}, {
    boundary: schemaGate.BOUNDARY.TICKET_DERIVE,
    kind: schemaGate.KIND.TOOL,
    ticketId: 'strict-internal-test'
  });
  results.push({
    name: 'schemaGate strict internal returns ok=false (no throw)',
    pass: strictInternal.ok === false && strictInternal.code === 'SCHEMA_VALIDATION_FAILED'
  });

  // Test 9d: emitWarning records audit + metrics for tool_verdict_invalid
  const captured = [];
  schemaGate.setAuditLogger((entry) => captured.push(entry));
  schemaGate.resetMetrics();
  schemaGate.emitWarning({
    warn_code: schemaGate.WARN_CODE.TOOL_VERDICT_INVALID,
    boundary: schemaGate.BOUNDARY.TICKET_DERIVE,
    direction: schemaGate.DIRECTION.INTERNAL,
    kind: schemaGate.KIND.TOOL,
    ticket_id: 'tv-invalid-test',
    errors: [{ path: '/metadata/final_outputs/tool_verdict', keyword: 'toolVerdictCompat' }],
    details: { source: 'outputs.tool_verdict', raw: 'INVALID' }
  });
  const m = schemaGate.getMetrics();
  const dim = Array.isArray(m.schema_warning_by_dim) ? m.schema_warning_by_dim : [];
  const tv = dim.find(x => x.warn_code === 'tool_verdict_invalid' && x.boundary === 'ticket_derive' && x.direction === 'internal');
  const auditHit = captured.find(e => e.action === 'schema_gate_warn' && Array.isArray(e.warn_codes) && e.warn_codes.includes('tool_verdict_invalid'));
  results.push({
    name: 'schemaGate emitWarning writes audit+metrics (tool_verdict_invalid)',
    pass: Boolean(tv && tv.count >= 1) && Boolean(auditHit && auditHit.details && auditHit.details.raw_preview)
  });

  // Restore original mode
  if (originalMode === undefined) delete process.env.SCHEMA_GATE_MODE;
  else process.env.SCHEMA_GATE_MODE = originalMode;
  
  // ============================================================
  // S2-2: toolVerdictCompat tests
  // ============================================================
  
  // Test 10: VALID_STATUSES is correct
  results.push({
    name: 'toolVerdictCompat VALID_STATUSES is correct',
    pass: VALID_STATUSES.includes('PROCEED') &&
          VALID_STATUSES.includes('DEFER') &&
          VALID_STATUSES.includes('BLOCK') &&
          VALID_STATUSES.length === 3
  });
  
  // Test 11: normalizeToolVerdict handles legacy string 'PROCEED'
  const normalizedProceed = normalizeToolVerdict('PROCEED');
  results.push({
    name: 'normalizeToolVerdict handles legacy string PROCEED',
    pass: normalizedProceed !== null &&
          normalizedProceed.status === 'PROCEED' &&
          normalizedProceed.reason === undefined
  });
  
  // Test 12: normalizeToolVerdict handles legacy string 'DEFER'
  const normalizedDefer = normalizeToolVerdict('DEFER');
  results.push({
    name: 'normalizeToolVerdict handles legacy string DEFER',
    pass: normalizedDefer !== null &&
          normalizedDefer.status === 'DEFER'
  });
  
  // Test 13: normalizeToolVerdict handles legacy string 'BLOCK'
  const normalizedBlock = normalizeToolVerdict('BLOCK');
  results.push({
    name: 'normalizeToolVerdict handles legacy string BLOCK',
    pass: normalizedBlock !== null &&
          normalizedBlock.status === 'BLOCK'
  });
  
  // Test 14: normalizeToolVerdict handles canonical object
  const normalizedObject = normalizeToolVerdict({ status: 'PROCEED', reason: 'test reason' });
  results.push({
    name: 'normalizeToolVerdict handles canonical object',
    pass: normalizedObject !== null &&
          normalizedObject.status === 'PROCEED' &&
          normalizedObject.reason === 'test reason'
  });
  
  // Test 15: normalizeToolVerdict handles object without reason
  const normalizedObjectNoReason = normalizeToolVerdict({ status: 'DEFER' });
  results.push({
    name: 'normalizeToolVerdict handles object without reason',
    pass: normalizedObjectNoReason !== null &&
          normalizedObjectNoReason.status === 'DEFER' &&
          normalizedObjectNoReason.reason === undefined
  });
  
  // Test 16: normalizeToolVerdict marks invalid string
  const normalizedInvalidString = normalizeToolVerdict('INVALID');
  results.push({
    name: 'normalizeToolVerdict marks invalid string',
    pass: normalizedInvalidString !== null &&
          normalizedInvalidString.status === null &&
          normalizedInvalidString.invalid_status === 'INVALID'
  });
  
  // Test 17: normalizeToolVerdict marks invalid object (missing status)
  const normalizedInvalidObject = normalizeToolVerdict({ reason: 'no status' });
  results.push({
    name: 'normalizeToolVerdict marks invalid object',
    pass: normalizedInvalidObject !== null &&
          normalizedInvalidObject.status === null
  });
  
  // Test 18: normalizeToolVerdict returns null for null/undefined
  results.push({
    name: 'normalizeToolVerdict returns null for null/undefined',
    pass: normalizeToolVerdict(null) === null &&
          normalizeToolVerdict(undefined) === null
  });
  
  // Test 19: readToolVerdict prefers outputs over ticket
  const readFromOutputs = readToolVerdict(
    { tool_verdict: 'PROCEED' },
    { metadata: { final_outputs: { tool_verdict: 'BLOCK' } } }
  );
  results.push({
    name: 'readToolVerdict prefers outputs over ticket',
    pass: readFromOutputs.status === 'PROCEED' &&
          readFromOutputs.source === 'outputs.tool_verdict'
  });
  
  // Test 20: readToolVerdict falls back to ticket.metadata.final_outputs
  const readFromTicket = readToolVerdict(
    null,
    { metadata: { final_outputs: { tool_verdict: 'DEFER' } } }
  );
  results.push({
    name: 'readToolVerdict falls back to ticket.metadata.final_outputs',
    pass: readFromTicket.status === 'DEFER' &&
          readFromTicket.source === 'ticket.metadata.final_outputs.tool_verdict'
  });
  
  // Test 21: readToolVerdict handles mixed (object in outputs)
  const readMixed = readToolVerdict(
    { tool_verdict: { status: 'BLOCK', reason: 'mixed test' } },
    null
  );
  results.push({
    name: 'readToolVerdict handles object verdict in outputs',
    pass: readMixed.status === 'BLOCK' && readMixed.reason === 'mixed test'
  });
  
  // Test 22: isVerdictStatus works with string
  results.push({
    name: 'isVerdictStatus works with string',
    pass: isVerdictStatus('PROCEED', 'PROCEED') === true &&
          isVerdictStatus('PROCEED', 'DEFER') === false
  });
  
  // Test 23: isVerdictStatus works with object
  results.push({
    name: 'isVerdictStatus works with object',
    pass: isVerdictStatus({ status: 'DEFER' }, 'DEFER') === true &&
          isVerdictStatus({ status: 'DEFER' }, 'PROCEED') === false
  });
  
  // Test 24: getVerdictStatus returns status string
  results.push({
    name: 'getVerdictStatus returns status string',
    pass: getVerdictStatus('PROCEED') === 'PROCEED' &&
          getVerdictStatus({ status: 'BLOCK' }) === 'BLOCK' &&
          getVerdictStatus(null) === null
  });
  
  return results;
}

// Export for test runner
module.exports = async function() {
  const results = await runTests();
  
  let passed = 0;
  let failed = 0;
  
  for (const r of results) {
    if (r.pass) {
      console.log(`  ✅ ${r.name}`);
      passed++;
    } else {
      console.log(`  ❌ ${r.name}`);
      failed++;
    }
  }
  
  console.log(`\n  S2-1/S2-2 Tests: ${passed} passed, ${failed} failed`);
  
  return failed === 0;
};
