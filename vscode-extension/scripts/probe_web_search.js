#!/usr/bin/env node
/**
 * Probe script for web-search-mcp
 * 
 * Commit 10b: Web Search 契約取證
 * - Verifies tool responses for get-web-search-summaries and get-single-web-page-content
 * - Records schema evidence to fixtures
 * 
 * SSOT paths:
 * - PROBE_SCRIPTS_DIR: vscode-extension/scripts/
 * - FIXTURES_DIR: vscode-extension/tests/fixtures/
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PINNED_PACKAGE = 'local:./tools/web-search-mcp-main';
const REPO_ROOT = path.join(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, '..', 'tests', 'fixtures');
const SERVER_PATH = path.join(REPO_ROOT, 'tools', 'web-search-mcp-main', 'dist', 'index.js');

// Output files
const META_FILE = path.join(FIXTURES_DIR, 'web_search_probe_meta.json');
const SUMMARIES_FILE = path.join(FIXTURES_DIR, 'web_search_summaries.txt');
const PAGE_CONTENT_FILE = path.join(FIXTURES_DIR, 'web_search_page_content.txt');

// Ensure fixtures directory exists
if (!fs.existsSync(FIXTURES_DIR)) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

// JSON-RPC message ID counter
let messageId = 1;

function makeJsonRpcRequest(method, params = {}) {
  const id = messageId++;
  return {
    id,
    line:
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      }) + '\n'
  };
}

async function probeWebSearchServer() {
  console.log(`\n🔍 Probing ${PINNED_PACKAGE}...\n`);
  console.log(`Server path: ${SERVER_PATH}\n`);

  const meta = {
    probe_timestamp: new Date().toISOString(),
    pinned_package: PINNED_PACKAGE,
    server_id: 'web_search',
    probe_command: `node ${SERVER_PATH}`,
    tools_discovered: [],
    summaries_content_types: [],
    summaries_content_count: 0,
    page_content_types: [],
    page_content_count: 0,
    probe_status: 'pending'
  };

  let summariesContent = '';
  let pageContent = '';

  // Start web search server
  const webProcess = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MAX_CONTENT_LENGTH: '2000',
      DEFAULT_TIMEOUT: '6000'
    }
  });

  let buffer = '';
  const responses = [];

  // Handle stdout
  webProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    
    // Try to parse complete JSON-RPC messages
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          responses.push(parsed);
          console.log('📨 Response:', JSON.stringify(parsed, null, 2).substring(0, 800));
        } catch (e) {
          console.log('📝 Raw output:', line.substring(0, 200));
        }
      }
    }
  });

  webProcess.stderr.on('data', (data) => {
    console.log('⚠️ Stderr:', data.toString().substring(0, 200));
  });

  // Wait for server to initialize
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    // 1. Initialize
    console.log('\n📤 Sending initialize...');
    const initReq = makeJsonRpcRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe_web_search', version: '1.0.0' }
    });
    webProcess.stdin.write(initReq.line);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. List tools
    console.log('\n📤 Sending tools/list...');
    const listReq = makeJsonRpcRequest('tools/list', {});
    webProcess.stdin.write(listReq.line);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 3. Test get-web-search-summaries
    console.log('\n📤 Testing get-web-search-summaries...');
    const summariesReq = makeJsonRpcRequest('tools/call', {
      name: 'get-web-search-summaries',
      arguments: { query: 'MCP Model Context Protocol', limit: 3 }
    });
    webProcess.stdin.write(summariesReq.line);
    await new Promise(resolve => setTimeout(resolve, 8000)); // Search may take time

    // 4. Test get-single-web-page-content
    console.log('\n📤 Testing get-single-web-page-content...');
    const pageReq = makeJsonRpcRequest('tools/call', {
      name: 'get-single-web-page-content',
      arguments: { url: 'https://example.com', maxContentLength: 1000 }
    });
    webProcess.stdin.write(pageReq.line);
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Process responses (id-based; no heuristics)
    for (const resp of responses) {
      // Extract tools list
      if (resp.result?.tools) {
        meta.tools_discovered = resp.result.tools.map(t => t.name);
        console.log('\n✅ Tools discovered:', meta.tools_discovered);
      }
    }

    const summariesResp = responses.find(r => r && r.id === summariesReq.id);
    const pageResp = responses.find(r => r && r.id === pageReq.id);

    if (summariesResp?.result?.content && Array.isArray(summariesResp.result.content)) {
      const firstText = summariesResp.result.content.find(
        b => b && b.type === 'text' && typeof b.text === 'string'
      );
      if (firstText?.text) {
        summariesContent = firstText.text;
        meta.summaries_content_types = ['text'];
        meta.summaries_content_count = 1;
      }
    }

    if (pageResp?.result?.content && Array.isArray(pageResp.result.content)) {
      const firstText = pageResp.result.content.find(
        b => b && b.type === 'text' && typeof b.text === 'string'
      );
      if (firstText?.text) {
        pageContent = firstText.text;
        meta.page_content_types = ['text'];
        meta.page_content_count = 1;
      }
    }

    meta.probe_status = 'success';
    
  } catch (error) {
    console.error('❌ Probe error:', error.message);
    meta.probe_status = 'error';
    meta.error = error.message;
  } finally {
    // Clean up
    webProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Write outputs
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  console.log(`\n✅ Meta written to: ${META_FILE}`);

  if (summariesContent) {
    fs.writeFileSync(SUMMARIES_FILE, summariesContent);
    console.log(`✅ Summaries written to: ${SUMMARIES_FILE}`);
  } else {
    fs.writeFileSync(SUMMARIES_FILE, '[No summaries captured during probe]');
    console.log(`⚠️ No summaries captured, wrote placeholder`);
  }

  if (pageContent) {
    fs.writeFileSync(PAGE_CONTENT_FILE, pageContent);
    console.log(`✅ Page content written to: ${PAGE_CONTENT_FILE}`);
  } else {
    fs.writeFileSync(PAGE_CONTENT_FILE, '[No page content captured during probe]');
    console.log(`⚠️ No page content captured, wrote placeholder`);
  }

  console.log('\n📋 Meta summary:');
  console.log(JSON.stringify(meta, null, 2));

  return meta;
}

// Run probe
probeWebSearchServer().catch(console.error);
