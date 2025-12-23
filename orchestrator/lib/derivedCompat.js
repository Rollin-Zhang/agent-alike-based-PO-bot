/**
 * Derived Field Compatibility Layer
 * 
 * Canonical location: ticket.derived (root-level)
 * Backward-compat: ticket.metadata.derived (mirror for transition period)
 * 
 * This module provides unified read/write access to ensure:
 * 1. New code writes to both locations
 * 2. Old data (metadata.derived only) is still readable
 * 3. Future migration is easy: just modify writeDerived
 */

/**
 * Read derived object from ticket with fallback support.
 * Prefers ticket.derived, falls back to ticket.metadata.derived.
 * 
 * @param {Object} ticket - Ticket object
 * @returns {Object|null} - Derived data or null if not present
 */
function readDerived(ticket) {
  if (!ticket) return null;
  
  // Prefer canonical location (root-level)
  if (ticket.derived) {
    return ticket.derived;
  }
  
  // Fallback to legacy location (metadata.derived)
  if (ticket.metadata?.derived) {
    return ticket.metadata.derived;
  }
  
  return null;
}

/**
 * Write derived object to ticket at both canonical and legacy locations.
 * Ensures mirror consistency during transition period.
 * 
 * @param {Object} ticket - Ticket object to modify
 * @param {Object} derivedObj - Derived data to write
 */
function writeDerived(ticket, derivedObj) {
  if (!ticket) {
    throw new Error('writeDerived: ticket is required');
  }
  
  if (!derivedObj || typeof derivedObj !== 'object') {
    throw new Error('writeDerived: derivedObj must be an object');
  }
  
  // Write to canonical location (root-level)
  ticket.derived = derivedObj;
  
  // Write to legacy location (mirror for backward-compat)
  if (!ticket.metadata) {
    ticket.metadata = {};
  }
  ticket.metadata.derived = derivedObj;
}

module.exports = {
  readDerived,
  writeDerived
};
