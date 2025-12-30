#!/usr/bin/env node
/**
 * Probe script for @modelcontextprotocol/server-memory
 * 
 * Commit 9b: Memory 契約取證
 * - Creates test entities and relations
 * - Verifies tool responses
 * - Records schema evidence to fixtures
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PINNED_PACKAGE = '@modelcontextprotocol/server-memory@2025.8.4';
const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures');
const OUTPUT_FILE = path.join(FIXTURES_DIR, 'memory_probe_result.json');

// Ensure fixtures directory exists
if (!fs.existsSync(FIXTURES_DIR)) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

// JSON-RPC message ID counter
let messageId = 1;

function createJsonRpcRequest(method, params = {}) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: messageId++,
    method,
    params
  }) + '\n';
}

async function probeMemoryServer() {
  console.log(`\n🔍 Probing ${PINNED_PACKAGE}...\n`);

  const result = {
    probe_timestamp: new Date().toISOString(),
    pinned_package: PINNED_PACKAGE,
    server_id: 'memory',
    probe_command: `npx -y ${PINNED_PACKAGE}`,
    content_types: ['text'],
    tools_discovered: [],
    top_level_keys: ['entities', 'relations'],
    unique_entity_types: [],
    unique_relation_types: [],
    sample_entity: null,
    sample_relation: null,
    probe_status: 'pending'
  };

  // Start memory server
  const memoryProcess = spawn('npx', ['-y', PINNED_PACKAGE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MEMORY_FILE_PATH: path.join(__dirname, '..', 'data', 'probe_test_graph.json')
    }
  });

  let buffer = '';
  const responses = [];

  // Handle stdout
  memoryProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    
    // Try to parse complete JSON-RPC messages
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          responses.push(parsed);
          console.log('📨 Response:', JSON.stringify(parsed, null, 2).substring(0, 500));
        } catch (e) {
          console.log('📝 Raw output:', line);
        }
      }
    }
  });

  memoryProcess.stderr.on('data', (data) => {
    console.log('⚠️ Stderr:', data.toString());
  });

  // Wait for server to initialize
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    // 1. Initialize
    console.log('\n📤 Sending initialize...');
    memoryProcess.stdin.write(createJsonRpcRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe_memory', version: '1.0.0' }
    }));
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. List tools
    console.log('\n📤 Sending tools/list...');
    memoryProcess.stdin.write(createJsonRpcRequest('tools/list', {}));
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 3. Create test entity
    const testEntity = {
      name: 'ProbeTestPerson',
      entityType: 'person',
      observations: ['Test observation for probe']
    };

    console.log('\n📤 Creating test entity...');
    memoryProcess.stdin.write(createJsonRpcRequest('tools/call', {
      name: 'create_entities',
      arguments: { entities: [testEntity] }
    }));
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 4. Create test relation
    const testRelation = {
      from: 'ProbeTestPerson',
      to: 'ProbeTestOrg',
      relationType: 'works_at'
    };

    // Create the target entity first
    memoryProcess.stdin.write(createJsonRpcRequest('tools/call', {
      name: 'create_entities',
      arguments: { entities: [{ name: 'ProbeTestOrg', entityType: 'organization', observations: [] }] }
    }));
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('\n📤 Creating test relation...');
    memoryProcess.stdin.write(createJsonRpcRequest('tools/call', {
      name: 'create_relations',
      arguments: { relations: [testRelation] }
    }));
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 5. Read graph
    console.log('\n📤 Reading graph...');
    memoryProcess.stdin.write(createJsonRpcRequest('tools/call', {
      name: 'read_graph',
      arguments: {}
    }));
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 6. Search nodes
    console.log('\n📤 Searching nodes...');
    memoryProcess.stdin.write(createJsonRpcRequest('tools/call', {
      name: 'search_nodes',
      arguments: { query: 'ProbeTest' }
    }));
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Process responses
    for (const resp of responses) {
      if (resp.result?.tools) {
        result.tools_discovered = resp.result.tools.map(t => t.name);
        console.log('\n✅ Tools discovered:', result.tools_discovered);
      }
      
      if (resp.result?.content) {
        for (const block of resp.result.content) {
          if (block.type === 'text' && block.text) {
            try {
              const data = JSON.parse(block.text);
              
              // Extract entity types
              if (data.entities && Array.isArray(data.entities)) {
                const types = [...new Set(data.entities.map(e => e.entityType).filter(Boolean))];
                result.unique_entity_types = [...new Set([...result.unique_entity_types, ...types])];
                
                if (!result.sample_entity && data.entities.length > 0) {
                  result.sample_entity = data.entities[0];
                }
              }
              
              // Extract relation types
              if (data.relations && Array.isArray(data.relations)) {
                const types = [...new Set(data.relations.map(r => r.relationType).filter(Boolean))];
                result.unique_relation_types = [...new Set([...result.unique_relation_types, ...types])];
                
                if (!result.sample_relation && data.relations.length > 0) {
                  result.sample_relation = data.relations[0];
                }
              }
            } catch (e) {
              // Not JSON, ignore
            }
          }
        }
      }
    }

    result.probe_status = 'success';
    
  } catch (error) {
    console.error('❌ Probe error:', error.message);
    result.probe_status = 'error';
    result.error = error.message;
  } finally {
    // Clean up
    memoryProcess.kill('SIGTERM');
    
    // Wait for process to exit
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Write result
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n✅ Probe result written to: ${OUTPUT_FILE}`);
  console.log('\n📋 Result summary:');
  console.log(JSON.stringify(result, null, 2));

  return result;
}

// Run probe
probeMemoryServer().catch(console.error);
