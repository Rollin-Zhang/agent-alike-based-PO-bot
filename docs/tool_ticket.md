# TOOL Ticket Contract Definition

> **Version**: v2.3.1 Blueprint  
> **Status**: Contract Defined (Runtime Implementation Pending)  
> **Last Updated**: 2025-12-19

---

## 1. Purpose & Context

### What is a TOOL Ticket?

A **TOOL ticket** is an intermediate ticket type in the three-phase workflow:

```
TRIAGE → TOOL → REPLY
```

- **TRIAGE** ticket: Determines whether content should receive a response
- **TOOL** ticket: Performs evidence gathering and safety checks before replying
- **REPLY** ticket: Generates the final response content

The TOOL phase acts as a bridge between decision-making (TRIAGE) and content generation (REPLY), encapsulating:
- **Tool invocation** (web search, knowledge graph queries, log searches)
- **Evidence aggregation** (collecting relevant context for reply generation)
- **Safety verdict** (PROCEED/DEFER/BLOCK decision before proceeding to REPLY)

### Blueprint Context

This contract is defined in the **v2.3.1 Blueprint** for the Agent-alike PO Bot system. It establishes the data structure for TOOL tickets but does **not** represent active runtime behavior in the current codebase.

---

## 2. Ticket Lifecycle

### When is a TOOL Ticket Created?

A TOOL ticket is derived when:
1. `ENABLE_TOOL_DERIVATION=true` (environment variable from Commit 1)
2. A TRIAGE ticket completes with `decision: "APPROVE"`
3. The orchestrator determines that evidence gathering is needed

**Current Status**: The derivation logic is **not yet implemented** in `index.js`. This document defines the contract for future implementation.

### When is a TOOL Ticket Completed?

A TOOL ticket is marked as completed when:
1. The TOOL worker executes all required tool calls
2. The worker populates `metadata.final_outputs.tool_verdict` with a decision
3. The orchestrator receives the verdict and:
   - If `status: "PROCEED"` → derives a REPLY ticket
   - If `status: "DEFER"` → pauses for human review
   - If `status: "BLOCK"` → terminates the workflow (no REPLY created)

---

## 3. Contract Definition

### Identification

A TOOL ticket is identified by:

```json
{
  "metadata": {
    "kind": "TOOL"
  }
}
```

**Note**: The `kind` field is **optional** and not enforced by schema validation unless `ENABLE_TICKET_SCHEMA_VALIDATION=true`.

---

### Input Structure: `metadata.tool_input`

The `tool_input` object contains all information needed for the TOOL worker to execute:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event` | `object` | No | Original event object from the source TRIAGE ticket (includes `type`, `thread_id`, `content`, `actor`, `timestamp`) |
| `triage` | `object` | No | Complete TRIAGE decision object, including:<br>- `decision`: "APPROVE" \| "REJECT" \| "DEFER"<br>- `information_needs`: Array of questions/topics to research<br>- `reply_strategy`: Suggested approach for reply generation<br>- `short_reason`: Brief justification for decision |
| `tool_policy` | `object` | No | Policy constraints for tool invocation:<br>- `max_turns`: Maximum tool interaction rounds<br>- `web_search_strategy`: "focused" \| "broad" \| "exhaustive"<br>- `web_search_budget`: Max number of web queries<br>- `tool_whitelist`: Array of allowed tool names |

**Example**:

```json
{
  "metadata": {
    "kind": "TOOL",
    "tool_input": {
      "event": {
        "type": "thread_reply",
        "thread_id": "abc123",
        "content": "What is the policy on X?",
        "actor": "user@example.com",
        "timestamp": "2025-12-19T10:00:00Z"
      },
      "triage": {
        "decision": "APPROVE",
        "information_needs": [
          {
            "question": "What is the official policy on X?",
            "purpose": "Verify factual accuracy"
          }
        ],
        "reply_strategy": "Provide policy reference with citation"
      },
      "tool_policy": {
        "max_turns": 3,
        "web_search_strategy": "focused",
        "web_search_budget": 5,
        "tool_whitelist": ["notebooklm.ask_question", "mem.search"]
      }
    }
  }
}
```

---

### Output Structure: `metadata.final_outputs`

The `final_outputs` object contains two key components:

#### 3.1. `tool_context`: Evidence Package

Aggregates all evidence collected during tool execution:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `evidence` | `array` | No | Array of evidence snippets with `source`, `snippet`, `relevance_score` |
| `logs_hits` | `array` | No | Results from log search tools |
| `graph_nodes` | `array` | No | Knowledge graph query results |
| `web_summaries` | `array` | No | Web search summaries |
| `tool_trace` | `array` | No | Audit trail of all tool invocations (includes `tool_name`, `args`, `result`, `timestamp`) |
| `truncated` | `boolean` | No | Whether evidence was truncated due to budget limits |
| `turn_control` | `object` | No | Turn tracking: `turns_used`, `max_turns` |

#### 3.2. `tool_verdict`: Three-State Decision

The final verdict determines workflow progression:

| Field | Type | Required | Values | Description |
|-------|------|----------|--------|-------------|
| `status` | `string` | No | `"PROCEED"` \| `"DEFER"` \| `"BLOCK"` | Decision status:<br>- **PROCEED**: Continue to REPLY phase<br>- **DEFER**: Needs human review before proceeding<br>- **BLOCK**: Reject and terminate workflow |
| `reason` | `string` | No | - | Explanation for the verdict (e.g., "Sufficient evidence gathered", "Content violates policy") |

**Example**:

```json
{
  "metadata": {
    "final_outputs": {
      "tool_context": {
        "evidence": [
          {
            "source": "notebooklm",
            "snippet": "Policy X states...",
            "relevance_score": 0.92
          }
        ],
        "tool_trace": [
          {
            "tool_name": "notebooklm.ask_question",
            "args": { "question": "What is policy X?" },
            "result": { "answer": "Policy X states..." },
            "timestamp": "2025-12-19T10:01:00Z"
          }
        ],
        "truncated": false,
        "turn_control": {
          "turns_used": 1,
          "max_turns": 3
        }
      },
      "tool_verdict": {
        "status": "PROCEED",
        "reason": "Sufficient evidence gathered; no policy violations detected"
      }
    }
  }
}
```

---

## 4. Schema Validation Behavior

### Default Mode: Validation Disabled

By default, `ENABLE_TICKET_SCHEMA_VALIDATION=false` (see `orchestrator/shared/constants.js`).

**In this mode**:
- The orchestrator does **not** validate ticket payloads against `schemas/ticket.json`
- Missing fields (e.g., `metadata.tool_input`, `tool_verdict`) do **not** cause request rejection
- Runtime behavior is unaffected by schema updates

### Strict Mode: Validation Enabled

If `ENABLE_TICKET_SCHEMA_VALIDATION=true`:
- Tickets are validated against the schema on ingestion and fill operations
- **However**, all TOOL-related fields are **optional** in the schema
- This means:
  - Old TRIAGE/REPLY tickets (without `metadata.kind`) will still pass validation
  - TOOL tickets missing `tool_input` or `final_outputs` will still pass validation
  - Validation may log warnings but will **not block** requests

**Design Rationale**: Strict validation is intended for debugging and monitoring, not for enforcing workflow logic.

---

## 5. Backward Compatibility

### Existing TRIAGE and REPLY Tickets

The schema changes in Commit 2 are **fully backward compatible**:

1. **`metadata.kind` is optional**: Old tickets without this field remain valid
2. **New fields are additive**: TRIAGE/REPLY tickets do not need `tool_input` or `final_outputs`
3. **No required field changes**: The `required` array in the schema remains unchanged

### Migration Path

No migration is needed for existing data. The system will continue to process:
- TRIAGE tickets without `metadata.kind` (inferred from `flow_id` containing "triage")
- REPLY tickets without `metadata.kind` (inferred from `flow_id` containing "reply")

Future TOOL tickets will explicitly set `metadata.kind="TOOL"` to avoid ambiguity.

---

## 6. Implementation Status (V1)

### ⚠️ Current Limitations

As of this commit:

1. **No TOOL ticket derivation**: The orchestrator does **not** create TOOL tickets automatically
2. **No TOOL worker**: The VS Code extension does not process TOOL tickets
3. **No tool invocation logic**: The contract exists, but runtime behavior is unchanged
4. **No validation enforcement**: Even with `ENABLE_TICKET_SCHEMA_VALIDATION=true`, validation is informational only

### What This Commit Provides

- ✅ **Schema definition**: `schemas/ticket.json` now includes TOOL ticket structure
- ✅ **Documentation**: This file defines the contract for future implementation
- ✅ **Backward compatibility**: Existing workflows are unaffected

### Next Steps (Future Commits)

To fully implement the TOOL phase:

1. **Commit 3+**: Add TOOL ticket derivation logic in `orchestrator/index.js`
2. **Commit 4+**: Implement TOOL worker in `vscode-extension/src/ticketWorker.ts`
3. **Commit 5+**: Wire up tool invocation via `ToolGateway.js`
4. **Commit 6+**: Add REPLY ticket derivation based on `tool_verdict.status`

---

## 7. Reference: Complete TOOL Ticket Example

```json
{
  "id": "tool-abc123",
  "type": "DraftTicket",
  "status": "pending",
  "flow_id": "tool_execution_v1",
  "event": {
    "type": "thread_reply",
    "thread_id": "thread-xyz789",
    "content": "What is the company policy on remote work?",
    "actor": "user@example.com",
    "timestamp": "2025-12-19T10:00:00Z"
  },
  "metadata": {
    "kind": "TOOL",
    "created_at": "2025-12-19T10:00:01Z",
    "triage_reference_id": "triage-def456",
    "tool_input": {
      "event": {
        "type": "thread_reply",
        "thread_id": "thread-xyz789",
        "content": "What is the company policy on remote work?",
        "actor": "user@example.com",
        "timestamp": "2025-12-19T10:00:00Z"
      },
      "triage": {
        "decision": "APPROVE",
        "information_needs": [
          {
            "question": "What is the official remote work policy?",
            "purpose": "Provide accurate policy reference"
          }
        ],
        "reply_strategy": "Cite official policy document",
        "short_reason": "User asking for factual policy information"
      },
      "tool_policy": {
        "max_turns": 3,
        "web_search_strategy": "focused",
        "web_search_budget": 5,
        "tool_whitelist": ["notebooklm.ask_question", "mem.search"]
      }
    },
    "final_outputs": {
      "tool_context": {
        "evidence": [
          {
            "source": "notebooklm",
            "snippet": "Remote work policy: Employees may work remotely up to 3 days per week with manager approval.",
            "relevance_score": 0.95
          }
        ],
        "tool_trace": [
          {
            "tool_name": "notebooklm.ask_question",
            "args": {
              "question": "What is the official remote work policy?"
            },
            "result": {
              "answer": "Remote work policy: Employees may work remotely up to 3 days per week with manager approval.",
              "confidence": 0.95
            },
            "timestamp": "2025-12-19T10:00:05Z"
          }
        ],
        "truncated": false,
        "turn_control": {
          "turns_used": 1,
          "max_turns": 3
        }
      },
      "tool_verdict": {
        "status": "PROCEED",
        "reason": "Policy information retrieved successfully; no safety concerns"
      }
    }
  }
}
```

---

## 8. FAQ

### Q: Why is `metadata.kind` optional?

**A**: To maintain backward compatibility with existing TRIAGE and REPLY tickets that do not have this field. The system can infer ticket type from `flow_id` when `kind` is absent.

### Q: What happens if a TOOL ticket has no `tool_verdict`?

**A**: If `ENABLE_TICKET_SCHEMA_VALIDATION=false` (default), the system will accept the ticket. The orchestrator may treat this as an incomplete TOOL ticket and either retry or mark it as failed, depending on future retry logic implementation.

### Q: Can I manually create a TOOL ticket for testing?

**A**: Yes. POST a ticket to `/v1/triage/batch` or `/events` with `metadata.kind="TOOL"`. However, since the TOOL worker is not yet implemented, the ticket will remain in `pending` status unless manually completed.

### Q: Will enabling `ENABLE_TICKET_SCHEMA_VALIDATION=true` break existing workflows?

**A**: No. All new fields are optional, so old tickets without `metadata.kind` or `tool_input` will still pass validation.

---

**Document Status**: This contract is part of Commit 2 (Schema & Documentation Sync). Runtime implementation will follow in subsequent commits.
