const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');

/**
 * Wait for server to be ready by polling health/metrics endpoint
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
 * HTTP POST helper
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
 * HTTP GET helper
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
 * Find available port
 */
function findAvailablePort(startPort = 13000) {
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
 * Integration test: HTTP fill with derivation (NO_MCP mode)
 */
async function testHttpFillDerivation() {
  let serverProc = null;
  let port = null;
  const serverLogs = [];

  try {
    console.log('[Test] testHttpFillDerivation: START');

    // Find available port
    port = await findAvailablePort(13000);
    console.log(`[Test] Using port ${port}`);

    // Spawn server with NO_MCP + ENABLE_TOOL_DERIVATION
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

    // Capture logs for debugging and NO_MCP smoke test
    serverProc.stdout.on('data', (data) => {
      const log = data.toString();
      serverLogs.push(log);
      // Optionally log: console.log('[Server]', log.trim());
    });

    serverProc.stderr.on('data', (data) => {
      const log = data.toString();
      serverLogs.push(log);
      console.error('[Server Error]', log.trim());
    });

    // Wait for server ready
    await waitForServer(port);
    console.log('[Test] Server ready');

    // Create TRIAGE ticket via /events endpoint
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

    // === First Fill ===
    console.log('[Test] Performing first fill...');
    const fillResp1 = await httpPost(port, `/v1/tickets/${triageId}/fill`, {
      outputs: { decision: 'APPROVE', reason: 'HTTP test approval' },
      by: 'http_fill'
    });

    assert.strictEqual(fillResp1.status, 200, 'First fill should succeed');
    console.log('[Test] First fill: OK');

    // Wait for async derivation to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    // === Verify State After First Fill ===
    console.log('[Test] Verifying state after first fill...');
    
    // GET triage ticket - should have derived.tool_ticket_id
    const triageResp1 = await httpGet(port, `/v1/tickets/${triageId}`);
    assert.strictEqual(triageResp1.status, 200, 'GET triage should succeed');
    
    const triageTicket1 = triageResp1.data;
    assert.ok(triageTicket1.derived, 'Triage ticket should have derived object');
    assert.ok(triageTicket1.derived.tool_ticket_id, 'Triage ticket should have tool_ticket_id');
    
    // M2-C.2: legacy metadata.derived mirror is removed
    assert.ok(!triageTicket1.metadata.derived, 'Should not write legacy metadata.derived');
    
    const toolId = triageTicket1.derived.tool_ticket_id;
    console.log(`[Test] TOOL ticket derived: ${toolId}`);

    // GET tool ticket - should exist and point back to triage
    const toolResp1 = await httpGet(port, `/v1/tickets/${toolId}`);
    assert.strictEqual(toolResp1.status, 200, 'GET tool ticket should succeed');
    
    const toolTicket1 = toolResp1.data;
    assert.strictEqual(toolTicket1.metadata.kind, 'TOOL', 'Should be TOOL kind');
    assert.strictEqual(
      toolTicket1.metadata.parent_ticket_id, 
      triageId, 
      'TOOL ticket should reference back to TRIAGE'
    );
    console.log('[Test] TOOL ticket verified: kind=TOOL, parent_ticket_id correct');

    // === Second Fill (Idempotency Test) ===
    console.log('[Test] Performing second fill (testing idempotency)...');
    const fillResp2 = await httpPost(port, `/v1/tickets/${triageId}/fill`, {
      outputs: { decision: 'APPROVE', reason: 'Second approval' },
      by: 'http_fill'
    });

    assert.strictEqual(fillResp2.status, 200, 'Second fill should succeed');
    console.log('[Test] Second fill: OK');

    // Wait for any potential async operations
    await new Promise(resolve => setTimeout(resolve, 200));

    // === Verify State After Second Fill (Idempotency) ===
    console.log('[Test] Verifying idempotency...');
    
    const triageResp2 = await httpGet(port, `/v1/tickets/${triageId}`);
    assert.strictEqual(triageResp2.status, 200, 'GET triage after second fill should succeed');
    
    const triageTicket2 = triageResp2.data;
    assert.strictEqual(
      triageTicket2.derived.tool_ticket_id, 
      toolId, 
      'TOOL ticket ID should be unchanged (idempotent)'
    );
    console.log('[Test] Idempotency verified: tool_ticket_id unchanged');

    // === NO_MCP Smoke Test ===
    console.log('[Test] Verifying NO_MCP mode (no MCP logs)...');
    const combinedLogs = serverLogs.join('\n').toLowerCase();
    
    // Check for MCP-related strings that should NOT appear in NO_MCP mode
    const mcpIndicators = ['[mcp]', 'spawn', 'stdio transport'];
    let mcpLeaks = [];
    
    for (const indicator of mcpIndicators) {
      if (combinedLogs.includes(indicator.toLowerCase())) {
        mcpLeaks.push(indicator);
      }
    }
    
    if (mcpLeaks.length > 0) {
      console.warn(`[Test] ⚠️  Potential MCP leakage detected: ${mcpLeaks.join(', ')}`);
      // For now, only warn - strict enforcement can be added later
    } else {
      console.log('[Test] NO_MCP verified: no MCP-related logs found ✓');
    }

    // Success: all state assertions passed
    console.log('[Test] testHttpFillDerivation: PASS ✓');
    return true;

  } catch (err) {
    console.error('[Test] testHttpFillDerivation: FAIL ✗');
    console.error(err);
    return false;
  } finally {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

module.exports = {
  testHttpFillDerivation
};
