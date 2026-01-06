/**
 * M2-A.1 requireDeps Parameterization Unit Test
 *
 * 目的（加分修正 #3）：驗證 requireDeps(depKeys[]) 不是寫死 /v1/tools/execute 的 deps。
 */

const assert = require('assert');
const { requireDeps } = require('../../lib/readiness/requireDeps');
const { DEP_CODES, HTTP_CODES } = require('../../lib/readiness/ssot');

function createMockRes() {
  return {
    statusCode: null,
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    }
  };
}

function runMiddleware(mw, req) {
  return new Promise((resolve, reject) => {
    const res = createMockRes();
    mw(req, res, (err) => {
      if (err) return reject(err);
      resolve(res);
    });
    // If middleware ends response, resolve immediately
    if (res.statusCode) resolve(res);
  });
}

async function testRequireDepsIsParameterized() {
  // Case A: require only memory; memory down => 503 missing only memory
  {
    const depStates = {
      memory: { ready: false, code: DEP_CODES.UNAVAILABLE },
      web_search: { ready: true, code: null },
      notebooklm: { ready: true, code: null }
    };

    const mw = requireDeps(['memory'], () => depStates);
    const res = await runMiddleware(mw, { body: { tool: 'any' } });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.jsonBody.error_code, HTTP_CODES.REQUIRED_UNAVAILABLE);
    assert.deepStrictEqual(res.jsonBody.missing_required, ['memory']);
  }

  // Case B: require only web_search; web_search down => 503 missing only web_search
  {
    const depStates = {
      memory: { ready: true, code: null },
      web_search: { ready: false, code: DEP_CODES.INIT_FAILED },
      notebooklm: { ready: true, code: null }
    };

    const mw = requireDeps(['web_search'], () => depStates);
    const res = await runMiddleware(mw, { body: { tool: 'any' } });

    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.jsonBody.error_code, HTTP_CODES.REQUIRED_UNAVAILABLE);
    assert.deepStrictEqual(res.jsonBody.missing_required, ['web_search']);
  }

  // Case C: require memory + web_search; both up => next() called (no statusCode)
  {
    const depStates = {
      memory: { ready: true, code: null },
      web_search: { ready: true, code: null },
      notebooklm: { ready: true, code: null }
    };

    const mw = requireDeps(['memory', 'web_search'], () => depStates);
    const res = await runMiddleware(mw, { body: { tool: 'any' } });

    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(res.jsonBody, null);
  }
}

function runAll() {
  console.log('=== M2-A.1 requireDeps Unit Tests ===');
  let passed = 0;
  let failed = 0;

  try {
    return Promise.resolve(testRequireDepsIsParameterized())
      .then(() => {
        console.log('✓ requireDeps(depKeys[]) is parameterized');
        passed++;
      })
      .catch((e) => {
        console.error(`✗ requireDeps(depKeys[]) is parameterized: ${e.message}`);
        failed++;
      })
      .finally(() => {
        console.log(`\nPassed: ${passed}, Failed: ${failed}, Total: ${passed + failed}`);
        if (failed > 0) throw new Error('requireDeps unit tests failed');
      });
  } catch (e) {
    console.error(`✗ requireDeps unit tests threw: ${e.message}`);
    throw e;
  }
}

if (require.main === module) {
  runAll().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { runAll };
