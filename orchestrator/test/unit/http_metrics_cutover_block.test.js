/**
 * M2-C.1: /metrics includes cutover block (shape-only)
 */

const assert = require('assert');
const { startServerWithEnv } = require('./helpers/server');

async function testMetricsIncludesCutoverBlock() {
  console.log('[Test] testMetricsIncludesCutoverBlock: START');

  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true',
    CUTOVER_UNTIL_MS: String(Date.now() + 60_000)
  });

  try {
    const http = require('http');

    const resp = await new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/metrics`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Timeout waiting for /metrics'));
      });
    });

    assert.strictEqual(resp.status, 200);
    const json = JSON.parse(resp.data);

    assert.ok(json.cutover && typeof json.cutover === 'object', 'metrics.cutover should exist');
    assert.ok('cutover_until_ms' in json.cutover, 'cutover.cutover_until_ms should exist');
    assert.strictEqual(json.cutover.env_source, 'CUTOVER_UNTIL_MS', 'cutover.env_source should reflect env precedence');
    assert.ok(typeof json.cutover.mode === 'string', 'cutover.mode should be string');
    assert.ok(json.cutover.metrics && typeof json.cutover.metrics === 'object', 'cutover.metrics should exist');
    assert.ok(Array.isArray(json.cutover.metrics.counters), 'cutover.metrics.counters should be array');

    console.log('[Test] testMetricsIncludesCutoverBlock: PASS ✓');
  } finally {
    await stop();
  }
}

async function runAll() {
  await testMetricsIncludesCutoverBlock();
}

module.exports = {
  runAll
};
