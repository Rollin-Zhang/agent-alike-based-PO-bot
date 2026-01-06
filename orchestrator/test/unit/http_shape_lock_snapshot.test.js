const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { startServerWithEnv } = require('./helpers/server');
const { httpPostEvent, httpPostFill, httpListTickets } = require('./helpers/http');
const { waitForTicket, findReplyByParent } = require('./helpers/waitFor');

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../fixtures/snapshots/flow_triage_tool_reply.json'
);

function pickFinalOutputsShape(finalOutputs) {
  const obj = finalOutputs && typeof finalOutputs === 'object' ? finalOutputs : null;
  return {
    present: Boolean(obj),
    keys: obj ? Object.keys(obj).sort() : []
  };
}

function buildShapeLockView({ triageTicket, toolTicket, replyTicket }) {
  const TRIAGE_ID = 'TRIAGE_ID';
  const TOOL_ID = 'TOOL_ID';
  const REPLY_ID = 'REPLY_ID';

  return {
    triage: {
      id: TRIAGE_ID,
      type: triageTicket.type,
      flow_id: triageTicket.flow_id,
      status: triageTicket.status,
      metadata: {
        kind: triageTicket.metadata?.kind || null,
        parent_ticket_id: triageTicket.metadata?.parent_ticket_id || null,
        triage_reference_id: triageTicket.metadata?.triage_reference_id || null
      },
      derived: {
        tool_ticket_id: TOOL_ID
      },
      final_outputs: {
        decision: triageTicket.metadata?.final_outputs?.decision,
        ...pickFinalOutputsShape(triageTicket.metadata?.final_outputs)
      },
      has_outputs_field: Object.prototype.hasOwnProperty.call(triageTicket, 'outputs')
    },
    tool: {
      id: TOOL_ID,
      type: toolTicket.type,
      flow_id: toolTicket.flow_id,
      status: toolTicket.status,
      metadata: {
        kind: toolTicket.metadata?.kind || null,
        parent_ticket_id: TRIAGE_ID,
        triage_reference_id: toolTicket.metadata?.triage_reference_id ? TRIAGE_ID : null
      },
      derived: {
        reply_ticket_id: REPLY_ID
      },
      tool_verdict: toolTicket.tool_verdict?.status || toolTicket.tool_verdict || null,
      final_outputs: {
        ...pickFinalOutputsShape(toolTicket.metadata?.final_outputs)
      },
      has_outputs_field: Object.prototype.hasOwnProperty.call(toolTicket, 'outputs')
    },
    reply: {
      id: REPLY_ID,
      type: replyTicket.type,
      flow_id: replyTicket.flow_id,
      status: replyTicket.status,
      metadata: {
        kind: replyTicket.metadata?.kind || null,
        parent_ticket_id: TOOL_ID,
        triage_reference_id: TRIAGE_ID,
        prompt_id: replyTicket.metadata?.prompt_id || null,
        reply_input_present: Boolean(replyTicket.metadata?.reply_input)
      },
      derived: null,
      final_outputs: pickFinalOutputsShape(replyTicket.metadata?.final_outputs),
      has_outputs_field: Object.prototype.hasOwnProperty.call(replyTicket, 'outputs')
    }
  };
}

async function buildActualSnapshot() {
  const { baseUrl, stop } = await startServerWithEnv({
    NO_MCP: 'true',
    ENABLE_TOOL_DERIVATION: 'true',
    ENABLE_REPLY_DERIVATION: 'true'
  });

  try {
    const triageEvent = {
      type: 'thread_post',
      source: 'shape-lock',
      event_id: 'shape-lock-flow-triage-tool-reply-001',
      content: 'Shape-lock flow (TRIAGE→TOOL→REPLY) minimal content',
      features: {
        engagement: { likes: 100, comments: 50 }
      }
    };

    const eventResponse = await httpPostEvent(baseUrl, triageEvent);
    if (eventResponse.status !== 200) {
      throw new Error(`POST /events failed status=${eventResponse.status}`);
    }

    const triageTicketId = eventResponse.data.ticket_id;
    if (!triageTicketId) {
      throw new Error('Missing triage ticket_id from /events response');
    }

    const fillResponse = await httpPostFill(baseUrl, triageTicketId, {
      decision: 'APPROVE',
      short_reason: 'Shape-lock approval',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });
    if (fillResponse.status !== 200) {
      throw new Error(`POST /v1/tickets/:id/fill (triage) failed status=${fillResponse.status}`);
    }

    const toolTicket = await waitForTicket(baseUrl, (t) =>
      t.metadata?.kind === 'TOOL' && t.metadata?.parent_ticket_id === triageTicketId
    );

    const toolFillResponse = await httpPostFill(baseUrl, toolTicket.id, {
      tool_verdict: 'PROCEED',
      reply_strategy: 'standard',
      target_prompt_id: 'reply.standard'
    });
    if (toolFillResponse.status !== 200) {
      throw new Error(`POST /v1/tickets/:id/fill (tool) failed status=${toolFillResponse.status}`);
    }

    const replyTicket = await findReplyByParent(baseUrl, toolTicket.id);

    const listResponse = await httpListTickets(baseUrl, { limit: 10000 });
    if (listResponse.status !== 200) {
      throw new Error(`GET /v1/tickets failed status=${listResponse.status}`);
    }

    const allTickets = listResponse.data || [];
    const triageTicket = allTickets.find((t) => t.id === triageTicketId);
    const toolTicketHydrated = allTickets.find((t) => t.id === toolTicket.id);
    const replyTicketHydrated = allTickets.find((t) => t.id === replyTicket.id);

    if (!triageTicket || !toolTicketHydrated || !replyTicketHydrated) {
      throw new Error('Failed to find expected tickets in /v1/tickets list response');
    }

    return buildShapeLockView({
      triageTicket,
      toolTicket: toolTicketHydrated,
      replyTicket: replyTicketHydrated
    });
  } finally {
    await stop();
  }
}

async function testHttpShapeLockSnapshot() {
  console.log('[Test] testHttpShapeLockSnapshot: START');

  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(
      `Missing fixture at ${FIXTURE_PATH}. Run: node orchestrator/scripts/snapshot_tickets.js`
    );
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  const actual = await buildActualSnapshot();

  // Deterministic JSON comparison for drift detection (stable fields only)
  assert.deepStrictEqual(actual, expected);

  console.log('[Test] testHttpShapeLockSnapshot: PASS ✓');
  return true;
}

module.exports = {
  testHttpShapeLockSnapshot
};
