/**
 * Commit 13: HTTP-Only E2E Test (TRIAGE→TOOL)
 * 
 * Purpose: Verify TRIAGE→TOOL derivation idempotency via HTTP endpoints only.
 * - All env/payload/helpers copy from http_fill_derivation.test.js (SSOT)
 * - Main assertions: parent_ticket_id correct, child count = 1, idempotent tool_ticket_id
 * - Secondary: marker observability (best-effort, warn not fail)
 */
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');

/**
 * Wait for server to be ready by polling health/metrics endpoint
 * (Copied from http_fill_derivation.test.js - SSOT)
 */
async function waitForServer(port, maxWaitMs = 5000) {
  const start = Date.now();
  const interval = 100;

  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > maxWaitMs) {
        return reject(new Error(`Server did not start within ${maxWaitMs}ms`));
      }

      const req = http.get(`http://localhost:${port}/metrics`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(check, interval);
        }
      });

      req.on('error', () => {
        setTimeout(check, interval);
      });
    };

    check();
  });
}

/**
 * HTTP POST helper (Copied from http_fill_derivation.test.js - SSOT)
 */
function httpPost(port, path, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);

    const options = {
      hostname: 'localhost',
      port: port,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, data: json });
        } catch (err) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * HTTP GET helper (Copied from http_fill_derivation.test.js - SSOT)
 */
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: port,
      path: path,
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, data: json });
        } catch (err) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Find available port (Copied from http_fill_derivation.test.js - SSOT)
 */
function findAvailablePort(startPort = 14000) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    
    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * HTTP-Only E2E: TRIAGE→TOOL derivation with idempotency proof
 */
async function testHttpTriageToolE2E() {
  let serverProc = null;
  let port = null;
  const serverLogs = [];

  try {
    console.log('[Test] testHttpTriageToolE2E: START');

    // Find available port (use different range to avoid collision)
    port = await findAvailablePort(14000);
    console.log(`[Test] Using port ${port}`);

    // === Spawn env: exactly from http_fill_derivation.test.js (SSOT) ===
    const env = {
      ...process.env,
      NO_MCP: 'true',
      ENABLE_TOOL_DERIVATION: 'true',
      ORCHESTRATOR_PORT: port.toString()
    };

    serverProc = spawn('node', ['index.js'], {
      cwd: __dirname + '/../..',
      env: env,
      stdio: 'pipe'
    });

    // Capture logs for marker observability check
    serverProc.stdout.on('data', (data) => {
      const log = data.toString();
      serverLogs.push(log);
    });

    serverProc.stderr.on('data', (data) => {
      const log = data.toString();
      serverLogs.push(log);
      console.error('[Server Error]', log.trim());
    });

    // Wait for server ready
    await waitForServer(port);
    console.log('[Test] Server ready');

    // === Step 4: List endpoint sanity check (防呆) ===
    console.log('[Test] Sanity check: GET /v1/tickets?limit=1');
    const listSanity = await httpGet(port, '/v1/tickets?limit=1');
    assert.strictEqual(listSanity.status, 200, 'List endpoint should return 200');
    assert.ok(Array.isArray(listSanity.data), 'List endpoint should return array');
    // Note: may be empty at startup, that's OK
    if (listSanity.data.length > 0) {
      assert.ok(listSanity.data[0].metadata, 'Ticket should have metadata field');
    }
    console.log('[Test] List endpoint sanity check: OK');

    // === Event payload: exactly from http_fill_derivation.test.js (SSOT) ===
    const eventPayload = {
      type: 'thread_post',
      source: 'test',
      content: 'Test event for HTTP derivation',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResp = await httpPost(port, '/events', eventPayload);
    console.log('[Test] Event response:', eventResp);
    
    if (eventResp.status !== 200 || !eventResp.data.ticket_id) {
      throw new Error('Failed to create event ticket');
    }

    const triageId = eventResp.data.ticket_id;
    console.log(`[Test] Created TRIAGE ticket: ${triageId}`);
    
    // Wait for triage processing
    await new Promise(resolve => setTimeout(resolve, 300));

    // === First Fill: payload exactly from http_fill_derivation.test.js (SSOT) ===
    console.log('[Test] Performing first fill...');
    const fillResp1 = await httpPost(port, `/v1/tickets/${triageId}/fill`, {
      outputs: { decision: 'APPROVE', reason: 'HTTP test approval' },
      by: 'test-runner'
    });

    assert.strictEqual(fillResp1.status, 200, 'First fill should succeed');
    console.log('[Test] First fill: OK');

    // Wait for async derivation
    await new Promise(resolve => setTimeout(resolve, 200));

    // === Main Assertion 1: Verify TOOL ticket exists and parent_ticket_id correct ===
    console.log('[Test] Verifying TOOL ticket derived...');
    
    const triageResp1 = await httpGet(port, `/v1/tickets/${triageId}`);
    assert.strictEqual(triageResp1.status, 200, 'GET triage should succeed');
    
    const triageTicket1 = triageResp1.data;
    assert.ok(triageTicket1.derived, 'Triage ticket should have derived object');
    assert.ok(triageTicket1.derived.tool_ticket_id, 'Triage ticket should have tool_ticket_id');
    
    const toolId = triageTicket1.derived.tool_ticket_id;
    console.log(`[Test] TOOL ticket derived: ${toolId}`);

    // Verify TOOL ticket points back to TRIAGE
    const toolResp1 = await httpGet(port, `/v1/tickets/${toolId}`);
    assert.strictEqual(toolResp1.status, 200, 'GET tool ticket should succeed');
    
    const toolTicket1 = toolResp1.data;
    assert.strictEqual(toolTicket1.metadata.kind, 'TOOL', 'Should be TOOL kind');
    assert.strictEqual(
      toolTicket1.metadata.parent_ticket_id, 
      triageId, 
      'TOOL ticket should reference back to TRIAGE (parent_ticket_id)'
    );
    console.log('[Test] parent_ticket_id assertion: PASS ✓');

    // === Main Assertion 2: Child count = 1 (via list/filter) ===
    console.log('[Test] Verifying child count = 1...');
    
    const listResp1 = await httpGet(port, '/v1/tickets?limit=10000');
    assert.strictEqual(listResp1.status, 200, 'List should succeed');
    
    const toolChildren1 = listResp1.data.filter(t => 
      t.metadata.kind === 'TOOL' && 
      t.metadata.parent_ticket_id === triageId
    );
    
    assert.strictEqual(toolChildren1.length, 1, 'Should have exactly 1 TOOL child after first fill');
    console.log('[Test] Child count = 1 after first fill: PASS ✓');

    // === Second Fill (Idempotency Test) ===
    console.log('[Test] Performing second fill (idempotency test)...');
    const fillResp2 = await httpPost(port, `/v1/tickets/${triageId}/fill`, {
      outputs: { decision: 'APPROVE', reason: 'Second approval' },
      by: 'test-runner'
    });

    assert.strictEqual(fillResp2.status, 200, 'Second fill should succeed');
    console.log('[Test] Second fill: OK');

    // Wait for any potential async operations
    await new Promise(resolve => setTimeout(resolve, 200));

    // === Main Assertion 3: Idempotency - tool_ticket_id unchanged ===
    console.log('[Test] Verifying idempotency...');
    
    const triageResp2 = await httpGet(port, `/v1/tickets/${triageId}`);
    assert.strictEqual(triageResp2.status, 200, 'GET triage after second fill should succeed');
    
    const triageTicket2 = triageResp2.data;
    assert.strictEqual(
      triageTicket2.derived.tool_ticket_id, 
      toolId, 
      'tool_ticket_id should be unchanged after second fill (idempotent)'
    );
    console.log('[Test] Idempotency (tool_ticket_id stable): PASS ✓');

    // === Main Assertion 4: Child count still = 1 after second fill ===
    console.log('[Test] Verifying child count still = 1 after second fill...');
    
    const listResp2 = await httpGet(port, '/v1/tickets?limit=10000');
    assert.strictEqual(listResp2.status, 200, 'List should succeed');
    
    const toolChildren2 = listResp2.data.filter(t => 
      t.metadata.kind === 'TOOL' && 
      t.metadata.parent_ticket_id === triageId
    );
    
    assert.strictEqual(
      toolChildren2.length, 
      1, 
      'Should still have exactly 1 TOOL child after second fill (idempotent)'
    );
    console.log('[Test] Child count = 1 after second fill (idempotent): PASS ✓');

    // === Secondary Assertion: Marker observability (best-effort) ===
    // SSOT: deriveToolTicketFromTriage.js line 51: console.log(`[derive] TRIAGE -> TOOL ticket=${newId}`)
    console.log('[Test] Checking marker observability (best-effort)...');
    
    const combinedLogs = serverLogs.join('\n');
    const markerPattern = '[derive] TRIAGE -> TOOL';
    const markerMatches = combinedLogs.split(markerPattern).length - 1;
    
    if (markerMatches > 0) {
      // Found marker - verify count is exactly 1 (idempotency proof via logs)
      if (markerMatches === 1) {
        console.log('[Test] Marker observability: found exactly 1 marker ✓');
      } else {
        console.warn(`[Test] ⚠️  Marker observability: found ${markerMatches} markers (expected 1)`);
        // This is observability, not correctness - HTTP state already proved idempotency
      }
    } else {
      // Could not capture marker - warn only (stdout capture is best-effort)
      console.warn('[Test] ⚠️  Marker observability: marker not captured (best-effort, not failure)');
    }

    // === NO_MCP mode verification ===
    // Proof: test passes under NO_MCP=true env
    console.log('[Test] NO_MCP mode: test executed successfully under NO_MCP=true ✓');

    // Success
    console.log('[Test] testHttpTriageToolE2E: PASS ✓');
    return true;

  } catch (err) {
    console.error('[Test] testHttpTriageToolE2E: FAIL ✗');
    console.error(err);
    return false;
  } finally {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      // Wait for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

module.exports = {
  testHttpTriageToolE2E
};
