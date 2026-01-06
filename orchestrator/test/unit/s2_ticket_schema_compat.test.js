const assert = require('assert');
const schemaGate = require('../../lib/schemaGate');

async function testTicketSchemaStatusCompatStage2AndLegacy() {
  const prev = process.env.SCHEMA_GATE_MODE;
  process.env.SCHEMA_GATE_MODE = 'warn';

  try {
    const baseTicket = {
      id: 't1',
      type: 'DraftTicket',
      flow_id: 'triage_zh_hant_v1',
      event: {
        type: 'triage_candidate',
        thread_id: 'th1',
        content: 'hello world',
        actor: 'tester',
        timestamp: new Date().toISOString()
      },
      metadata: {
        created_at: new Date().toISOString(),
        kind: 'TRIAGE'
      }
    };

    // Stage 2 status should validate
    const s2 = { ...baseTicket, status: 'running' };
    const r1 = schemaGate.gateInternal(s2, {
      boundary: schemaGate.BOUNDARY.TICKET_CREATE,
      kind: schemaGate.KIND.TRIAGE,
      ticketId: s2.id
    });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.result.warnCount, 0);

    // Legacy-only status should validate
    const legacy = { ...baseTicket, status: 'completed' };
    const r2 = schemaGate.gateInternal(legacy, {
      boundary: schemaGate.BOUNDARY.TICKET_CREATE,
      kind: schemaGate.KIND.TRIAGE,
      ticketId: legacy.id
    });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.result.warnCount, 0);

    console.log('✅ testTicketSchemaStatusCompatStage2AndLegacy');
    return true;
  } finally {
    if (prev === undefined) delete process.env.SCHEMA_GATE_MODE;
    else process.env.SCHEMA_GATE_MODE = prev;
  }
}

async function testTicketSchemaLeaseExpiresCompat() {
  const prev = process.env.SCHEMA_GATE_MODE;
  process.env.SCHEMA_GATE_MODE = 'warn';

  try {
    const baseTicket = {
      id: 't2',
      type: 'DraftTicket',
      status: 'running',
      flow_id: 'triage_zh_hant_v1',
      event: {
        type: 'triage_candidate',
        thread_id: 'th2',
        content: 'hello world',
        actor: 'tester',
        timestamp: new Date().toISOString()
      },
      metadata: {
        created_at: new Date().toISOString(),
        kind: 'TRIAGE'
      }
    };

    // Stage 2 epoch-ms
    const s2 = { ...baseTicket, metadata: { ...baseTicket.metadata, lease_expires: Date.now() + 10000 } };
    const r1 = schemaGate.gateInternal(s2, {
      boundary: schemaGate.BOUNDARY.TICKET_CREATE,
      kind: schemaGate.KIND.TRIAGE,
      ticketId: s2.id
    });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.result.warnCount, 0);

    // Legacy ISO date-time
    const legacy = { ...baseTicket, metadata: { ...baseTicket.metadata, lease_expires: new Date(Date.now() + 10000).toISOString() } };
    const r2 = schemaGate.gateInternal(legacy, {
      boundary: schemaGate.BOUNDARY.TICKET_CREATE,
      kind: schemaGate.KIND.TRIAGE,
      ticketId: legacy.id
    });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.result.warnCount, 0);

    console.log('✅ testTicketSchemaLeaseExpiresCompat');
    return true;
  } finally {
    if (prev === undefined) delete process.env.SCHEMA_GATE_MODE;
    else process.env.SCHEMA_GATE_MODE = prev;
  }
}

async function testTicketSchemaToolStepsStrict() {
  const prev = process.env.SCHEMA_GATE_MODE;
  process.env.SCHEMA_GATE_MODE = 'strict';

  try {
    const baseTicket = {
      id: 't-tool-steps-1',
      type: 'DraftTicket',
      status: 'pending',
      flow_id: 'triage_zh_hant_v1',
      event: {
        type: 'triage_candidate',
        thread_id: 'th-tool',
        content: 'hello world',
        actor: 'tester',
        timestamp: new Date().toISOString()
      },
      metadata: {
        created_at: new Date().toISOString(),
        kind: 'TOOL'
      }
    };

    // Valid tool_steps should pass.
    const okTicket = {
      ...baseTicket,
      id: 't-tool-steps-ok',
      metadata: {
        ...baseTicket.metadata,
        tool_input: {
          tool_steps: [
            {
              tool_name: 'web_search',
              args: { query: 'hello' },
              budget: { max_steps: 1 }
            }
          ]
        }
      }
    };
    const rOk = schemaGate.gateInternal(okTicket, {
      boundary: schemaGate.BOUNDARY.TICKET_CREATE,
      kind: schemaGate.KIND.TOOL,
      ticketId: okTicket.id
    });
    assert.strictEqual(rOk.ok, true);

    // Extra field on ToolStep should be rejected (additionalProperties:false).
    const badStepTicket = {
      ...baseTicket,
      id: 't-tool-steps-bad-step',
      metadata: {
        ...baseTicket.metadata,
        tool_input: {
          tool_steps: [
            {
              tool_name: 'web_search',
              args: { query: 'hello' },
              extra_field: 123
            }
          ]
        }
      }
    };
    const rBadStep = schemaGate.gateInternal(badStepTicket, {
      boundary: schemaGate.BOUNDARY.TICKET_CREATE,
      kind: schemaGate.KIND.TOOL,
      ticketId: badStepTicket.id
    });
    assert.strictEqual(rBadStep.ok, false);

    // Unknown budget key should be rejected (budget.additionalProperties:false).
    const badBudgetTicket = {
      ...baseTicket,
      id: 't-tool-steps-bad-budget',
      metadata: {
        ...baseTicket.metadata,
        tool_input: {
          tool_steps: [
            {
              tool_name: 'web_search',
              args: { query: 'hello' },
              budget: { max_steps: 1, max_bytes: 1024 }
            }
          ]
        }
      }
    };
    const rBadBudget = schemaGate.gateInternal(badBudgetTicket, {
      boundary: schemaGate.BOUNDARY.TICKET_CREATE,
      kind: schemaGate.KIND.TOOL,
      ticketId: badBudgetTicket.id
    });
    assert.strictEqual(rBadBudget.ok, false);

    console.log('✅ testTicketSchemaToolStepsStrict');
    return true;
  } finally {
    if (prev === undefined) delete process.env.SCHEMA_GATE_MODE;
    else process.env.SCHEMA_GATE_MODE = prev;
  }
}

module.exports = {
  testTicketSchemaStatusCompatStage2AndLegacy,
  testTicketSchemaLeaseExpiresCompat,
  testTicketSchemaToolStepsStrict
};
