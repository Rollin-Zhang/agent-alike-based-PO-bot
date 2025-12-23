const fs = require('fs');
const path = require('path');
const TicketStore = require('../../../store/TicketStore');

/**
 * Create an isolated TicketStore fixture for testing
 * @returns {Object} { store, cleanup, path }
 */
function makeTicketStoreFixture() {
  // Generate unique temp path
  const tmpDir = '/tmp';
  const filename = `orch-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  const tempPath = path.join(tmpDir, filename);
  
  // Create store with temp path
  const store = new TicketStore(tempPath);
  
  // Cleanup function
  const cleanup = () => {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (err) {
      console.warn(`[Fixture] Failed to cleanup ${tempPath}:`, err.message);
    }
  };
  
  return {
    store,
    cleanup,
    path: tempPath
  };
}

module.exports = { makeTicketStoreFixture };
