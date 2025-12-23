const assert = require('assert');
const { readDerived, writeDerived } = require('../../lib/derivedCompat');

/**
 * Test: readDerived with canonical location (ticket.derived)
 */
function testReadDerivedCanonical() {
  console.log('[Test] testReadDerivedCanonical: START');
  
  const ticket = {
    id: 'test-1',
    derived: { tool_ticket_id: 'tool-123' }
  };
  
  const result = readDerived(ticket);
  assert.ok(result, 'Should return derived object');
  assert.strictEqual(result.tool_ticket_id, 'tool-123', 'Should read from canonical location');
  
  console.log('[Test] testReadDerivedCanonical: PASS ✓');
  return true;
}

/**
 * Test: readDerived with legacy location (ticket.metadata.derived)
 */
function testReadDerivedLegacy() {
  console.log('[Test] testReadDerivedLegacy: START');
  
  // Old data structure (no root-level derived)
  const ticket = {
    id: 'test-2',
    metadata: {
      kind: 'TRIAGE',
      derived: { tool_ticket_id: 'tool-456' }
    }
  };
  
  const result = readDerived(ticket);
  assert.ok(result, 'Should return derived object from legacy location');
  assert.strictEqual(result.tool_ticket_id, 'tool-456', 'Should fallback to metadata.derived');
  
  console.log('[Test] testReadDerivedLegacy: PASS ✓');
  return true;
}

/**
 * Test: readDerived prefers canonical over legacy
 */
function testReadDerivedPrecedence() {
  console.log('[Test] testReadDerivedPrecedence: START');
  
  const ticket = {
    id: 'test-3',
    derived: { tool_ticket_id: 'canonical-789' },
    metadata: {
      derived: { tool_ticket_id: 'legacy-000' }
    }
  };
  
  const result = readDerived(ticket);
  assert.strictEqual(result.tool_ticket_id, 'canonical-789', 'Should prefer canonical location');
  
  console.log('[Test] testReadDerivedPrecedence: PASS ✓');
  return true;
}

/**
 * Test: readDerived returns null for missing derived
 */
function testReadDerivedMissing() {
  console.log('[Test] testReadDerivedMissing: START');
  
  const ticket = {
    id: 'test-4',
    metadata: { kind: 'TRIAGE' }
  };
  
  const result = readDerived(ticket);
  assert.strictEqual(result, null, 'Should return null when derived is missing');
  
  console.log('[Test] testReadDerivedMissing: PASS ✓');
  return true;
}

/**
 * Test: writeDerived writes to both locations
 */
function testWriteDerivedMirror() {
  console.log('[Test] testWriteDerivedMirror: START');
  
  const ticket = {
    id: 'test-5',
    metadata: { kind: 'TRIAGE' }
  };
  
  writeDerived(ticket, { tool_ticket_id: 'tool-mirror' });
  
  // Verify canonical location
  assert.ok(ticket.derived, 'Should write to canonical location');
  assert.strictEqual(ticket.derived.tool_ticket_id, 'tool-mirror', 'Canonical should have correct value');
  
  // Verify legacy location (mirror)
  assert.ok(ticket.metadata.derived, 'Should write to legacy location');
  assert.strictEqual(ticket.metadata.derived.tool_ticket_id, 'tool-mirror', 'Legacy should have same value');
  
  console.log('[Test] testWriteDerivedMirror: PASS ✓');
  return true;
}

/**
 * Test: writeDerived creates metadata if missing
 */
function testWriteDerivedCreateMetadata() {
  console.log('[Test] testWriteDerivedCreateMetadata: START');
  
  const ticket = {
    id: 'test-6'
    // No metadata object
  };
  
  writeDerived(ticket, { tool_ticket_id: 'tool-create' });
  
  assert.ok(ticket.metadata, 'Should create metadata object');
  assert.ok(ticket.metadata.derived, 'Should create metadata.derived');
  assert.strictEqual(ticket.metadata.derived.tool_ticket_id, 'tool-create', 'Should write to created metadata');
  
  console.log('[Test] testWriteDerivedCreateMetadata: PASS ✓');
  return true;
}

/**
 * Test: writeDerived throws on invalid inputs
 */
function testWriteDerivedValidation() {
  console.log('[Test] testWriteDerivedValidation: START');
  
  // Test null ticket
  try {
    writeDerived(null, { test: 'data' });
    assert.fail('Should throw on null ticket');
  } catch (err) {
    assert.ok(err.message.includes('ticket is required'), 'Should have correct error message');
  }
  
  // Test invalid derivedObj
  try {
    writeDerived({ id: 'test' }, null);
    assert.fail('Should throw on null derivedObj');
  } catch (err) {
    assert.ok(err.message.includes('must be an object'), 'Should have correct error message');
  }
  
  console.log('[Test] testWriteDerivedValidation: PASS ✓');
  return true;
}

module.exports = {
  testReadDerivedCanonical,
  testReadDerivedLegacy,
  testReadDerivedPrecedence,
  testReadDerivedMissing,
  testWriteDerivedMirror,
  testWriteDerivedCreateMetadata,
  testWriteDerivedValidation
};
