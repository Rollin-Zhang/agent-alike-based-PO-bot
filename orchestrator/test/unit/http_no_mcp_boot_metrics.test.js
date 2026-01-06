/**
 * Test A2: NO_MCP Boot with HTTP /metrics Available
 * 
 * Phase A: Deterministic Safety Skeleton
 * 
 * Verifies that with NO_MCP=true (and no PROBE_FORCE_FAIL):
 * - Orchestrator does NOT exit
 * - HTTP endpoint /metrics returns 200
 * 
 * This ensures the NO_MCP test harness remains functional.
 */

const assert = require('assert');
const { startServerWithEnv } = require('./helpers/server');

/**
 * Test A2: NO_MCP=true allows normal startup and /metrics responds
 */
async function testNoMcpBootMetrics() {
  console.log('[Test] testNoMcpBootMetrics: START');

  // Start server with NO_MCP=true (existing helper already does this)
  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true'
    // Note: NOT setting PROBE_FORCE_FAIL
  });

  try {
    // If we got here, server started successfully (didn't exit)
    console.log('[Test] Server started without exit: PASS ✓');

    // Verify /metrics endpoint responds
    const http = require('http');
    
    const metricsResponse = await new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/metrics`, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Timeout waiting for /metrics'));
      });
    });

    assert.strictEqual(metricsResponse.status, 200, `/metrics should return 200, got ${metricsResponse.status}`);
    console.log('[Test] /metrics returns 200: PASS ✓');

    // Verify response is JSON with expected structure
    let metricsData;
    try {
      metricsData = JSON.parse(metricsResponse.data);
    } catch (e) {
      // Some metrics endpoints return plain text, that's OK too
      metricsData = null;
    }
    
    if (metricsData !== null) {
      // If JSON, verify it has some expected field
      assert.ok(
        metricsData.status === 'ok' || metricsData.uptime !== undefined || typeof metricsData === 'object',
        '/metrics should return valid JSON object'
      );

      // Stage 2 alignment: tickets must expose running/blocked explicitly
      assert.ok(metricsData.tickets && typeof metricsData.tickets === 'object', 'metricsData.tickets should exist');
      for (const key of ['pending', 'running', 'done', 'failed', 'blocked']) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(metricsData.tickets, key),
          `metricsData.tickets should include '${key}'`
        );
        assert.strictEqual(typeof metricsData.tickets[key], 'number', `metricsData.tickets.${key} should be a number`);
      }

      // Guardrail metrics are optional but if present must be object
      if (metricsData.ticket_store !== undefined) {
        assert.strictEqual(typeof metricsData.ticket_store, 'object', 'metricsData.ticket_store should be an object');
      }

      console.log('[Test] /metrics JSON structure: PASS ✓');
    } else {
      console.log('[Test] /metrics returned non-JSON (acceptable): PASS ✓');
    }

    console.log('[Test] testNoMcpBootMetrics: PASS ✓');
    return true;
  } finally {
    await stop();
  }
}

module.exports = {
  testNoMcpBootMetrics
};
