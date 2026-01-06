/**
 * M2-A.1 requireDeps Middleware Gating Test
 * 
 * 驗證 /v1/tools/execute 在 NO_MCP 時回 503 並打點 counter
 */

const assert = require('assert');
const axios = require('axios');
const { startServerWithEnv } = require('./helpers/server');
const { validate503Body, HTTP_CODES } = require('../../lib/readiness/ssot');

async function testToolsExecuteMissingToolReturns400() {
  const { baseUrl, stop } = await startServerWithEnv({ NO_MCP: 'true' });

  try {
    let response;
    try {
      await axios.post(`${baseUrl}/v1/tools/execute`, {
        server: 'memory',
        arguments: {}
      });
      assert.fail('Should have thrown 400 error');
    } catch (error) {
      response = error.response;
    }

    assert.ok(response, 'Expected HTTP response for 400 error');
    assert.strictEqual(response.status, 400, 'Should return 400 when tool is missing/invalid');
    assert.ok(response.data && response.data.error === 'missing_tool', 'Should return { error: "missing_tool" }');

    // Missing tool should not trip requireDeps gating; counters should not be incremented.
    const metricsResponse = await axios.get(`${baseUrl}/metrics`);
    const metrics = metricsResponse.data;

    assert.ok(metrics.readiness, 'Metrics should have readiness block');

    const counters = metrics.readiness.required_unavailable_total;
    if (counters) {
      assert.ok(!counters['memory|MCP_REQUIRED_UNAVAILABLE'], 'memory counter should not be incremented for 400 missing_tool');
      assert.ok(!counters['web_search|MCP_REQUIRED_UNAVAILABLE'], 'web_search counter should not be incremented for 400 missing_tool');
    }
  } finally {
    await stop();
  }
}

async function testToolsExecuteGatingWithNOMCP() {
  const { baseUrl, stop } = await startServerWithEnv({ NO_MCP: 'true' });

  try {
    // First request: should get 503
    let response;
    try {
      response = await axios.post(`${baseUrl}/v1/tools/execute`, {
        server: 'memory',
        tool: 'read_graph',
        arguments: {}
      });
      assert.fail('Should have thrown 503 error');
    } catch (error) {
      response = error.response;
    }

    // Assert: status 503
    assert.strictEqual(response.status, 503, 'Should return 503 when required deps unavailable');

    // Assert: body is valid 503 body
    const body = response.data;
    const isValid = validate503Body(body);
    assert.strictEqual(isValid, true, 'Should return valid 503 body');

    // Assert: error_code is MCP_REQUIRED_UNAVAILABLE
    assert.strictEqual(body.error_code, HTTP_CODES.REQUIRED_UNAVAILABLE);

    // Assert: missing_required contains expected DepKeys
    assert.ok(Array.isArray(body.missing_required), 'missing_required should be array');
    assert.ok(body.missing_required.includes('memory'), 'Should include memory in missing_required');
    assert.ok(body.missing_required.includes('web_search'), 'Should include web_search in missing_required');

    // Second request: verify counter increment
    try {
      await axios.post(`${baseUrl}/v1/tools/execute`, {
        server: 'memory',
        tool: 'read_graph',
        arguments: {}
      });
    } catch (error) {
      // Expected 503
    }

    // Check /metrics for counter increment
    const metricsResponse = await axios.get(`${baseUrl}/metrics`);
    const metrics = metricsResponse.data;

    // Assert: readiness.required_unavailable_total has counters
    assert.ok(metrics.readiness, 'Metrics should have readiness block');
    assert.ok(metrics.readiness.required_unavailable_total, 'Should have required_unavailable_total');

    const memoryCounter = metrics.readiness.required_unavailable_total['memory|MCP_REQUIRED_UNAVAILABLE'];
    const webSearchCounter = metrics.readiness.required_unavailable_total['web_search|MCP_REQUIRED_UNAVAILABLE'];

    // At least 2 requests blocked (both deps missing in each request)
    assert.ok(memoryCounter >= 2, `memory counter should be >= 2, got ${memoryCounter}`);
    assert.ok(webSearchCounter >= 2, `web_search counter should be >= 2, got ${webSearchCounter}`);

  } finally {
    await stop();
  }
}

// --- Run Tests ---

async function runRequiredGatingTests() {
  console.log('=== M2-A.1 requireDeps Middleware Gating Tests ===');
  
  try {
    await testToolsExecuteMissingToolReturns400();
    console.log('✓ POST /v1/tools/execute missing tool returns 400 (missing_tool)');

    await testToolsExecuteGatingWithNOMCP();
    console.log('✓ POST /v1/tools/execute with NO_MCP=true returns 503 and increments counters');
    console.log('\nPassed: 2, Failed: 0, Total: 2');
    return true;
  } catch (e) {
    console.error(`✗ Test failed: ${e.message}`);
    console.log('\nPassed: 0, Failed: 1, Total: 2');
    return false;
  }
}

if (require.main === module) {
  runRequiredGatingTests().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = { runAll: runRequiredGatingTests };
