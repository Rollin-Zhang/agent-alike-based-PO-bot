/**
 * TicketStore - Stage 2 vNext
 * 
 * State Machine (定案):
 *   pending → running → done | failed | blocked
 * 
 * States:
 *   - pending: 等待處理
 *   - running: 正在執行（已被 lease/lock）
 *   - done: 成功完成
 *   - failed: 執行失敗（可重試或人工介入）
 *   - blocked: 被 schemaGate/policy 擋下（需修正後重試）
 * 
 * Legacy compat:
 *   - 'leased' maps to 'running'
 *   - 'completed' maps to 'done'
 */

// ============================================================
// TICKET_STATUS ENUM (stable, never match on strings in tests)
// ============================================================
const TICKET_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  // Legacy aliases (for backward compat)
  LEASED: 'running',      // legacy 'leased' → 'running'
  COMPLETED: 'completed'  // legacy 'completed' kept for read compat
};

const crypto = require('crypto');

const { normalizeToolVerdict } = require('../lib/toolVerdict');
const { cutoverMetrics } = require('../lib/compat/cutoverMetrics');

const DIRECT_FILL_ALLOWLIST = new Set(['http_fill', 'system', 'manual']);

// ============================================================
// Guardrail observability (low-cardinality)
// ============================================================
let ticketStoreAuditLogFn = null;

function setAuditLogger(fn) {
  ticketStoreAuditLogFn = fn;
}

function logAudit(entry) {
  if (ticketStoreAuditLogFn) ticketStoreAuditLogFn(entry);
}

const guardMetricsCounters = {
  // ticket_store_guard_reject_total{code, action}
  rejects: new Map()
};

function incrementGuardCounter(counterMap, labels) {
  const key = JSON.stringify(labels);
  counterMap.set(key, (counterMap.get(key) || 0) + 1);
}

function snapshotGuardCounters(counterMap) {
  const out = [];
  for (const [key, value] of counterMap.entries()) {
    out.push({ labels: JSON.parse(key), value });
  }
  return out;
}

function emitGuardReject({
  ticket,
  action,
  code,
  reason,
  details
}) {
  incrementGuardCounter(guardMetricsCounters.rejects, { action, code });
  logAudit({
    ts: new Date().toISOString(),
    action: 'ticket_store_guard_reject',
    ticket_id: ticket?.id,
    kind: ticket?.metadata?.kind,
    status: ticket?.status,
    code,
    guard_action: action,
    reason,
    details
  });
}

function newLeaseToken() {
  // Prefer built-in UUID when available (Node 16+)
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback: 16 bytes hex
  return crypto.randomBytes(16).toString('hex');
}

function normalizeLeaseProof(leaseProof) {
  if (!leaseProof) return { owner: undefined, token: undefined };
  if (typeof leaseProof === 'string') return { owner: undefined, token: leaseProof };
  if (typeof leaseProof === 'object') {
    const owner = leaseProof.owner ?? leaseProof.lease_owner;
    const token = leaseProof.token ?? leaseProof.lease_token;
    return { owner, token };
  }
  return { owner: undefined, token: undefined };
}

// Valid state transitions
const VALID_TRANSITIONS = {
  pending: ['running', 'blocked'],
  running: ['done', 'failed', 'blocked', 'pending'], // pending = release lease
  done: [],      // terminal
  failed: ['pending', 'running'], // allow retry
  blocked: ['pending'] // allow unblock after fix
};

class TicketStore {
  constructor(dataPath = null) {
    this.tickets = new Map();
    // Support custom data path for testing (TICKETSTORE_PATH env or parameter)
    this.dataPath = dataPath || process.env.TICKETSTORE_PATH || null;
    // 移除 queue，改用 Map 遍歷篩選，以支援 kind 過濾
  }
  
  async create(ticket) {
    if (!ticket.metadata) ticket.metadata = {};
    if (!ticket.metadata.created_at) ticket.metadata.created_at = new Date().toISOString();
    // Set default status if not provided
    if (!ticket.status) ticket.status = TICKET_STATUS.PENDING;

    this.tickets.set(ticket.id, ticket);
    console.log(`📥 [Store] New Ticket: ${ticket.id} | Kind: ${ticket.metadata.kind} | Status: ${ticket.status}`);
    return ticket;
  }
  
  async get(ticketId) {
    return this.tickets.get(ticketId) || null;
  }
  
  async list(options = {}) {
    const { status, offset = 0 } = options;

    const controlKeys = new Set(['status', 'limit', 'offset']);
    const filterKeys = Object.keys(options).filter((k) => !controlKeys.has(k));

    const hasExplicitLimit = Object.prototype.hasOwnProperty.call(options, 'limit');
    const limit = hasExplicitLimit
      ? Number(options.limit)
      : (filterKeys.length > 0 ? 10000 : 100);

    let tickets = Array.from(this.tickets.values());

    if (status) {
      tickets = tickets.filter((ticket) => ticket.status === status);
    }

    if (filterKeys.length > 0) {
      tickets = tickets.filter((ticket) => {
        return filterKeys.every((key) => {
          const expected = options[key];
          if (expected === undefined) return true;

          const actual = getByPath(ticket, key);
          return actual === expected;
        });
      });
    }

    // 按時間排序 (FIFO)
    return tickets
      .sort((a, b) => new Date(a.metadata.created_at) - new Date(b.metadata.created_at))
      .slice(offset, offset + limit);
  }

  
  
  async count(options = {}) {
    const { status } = options;
    if (!status) return this.tickets.size;
    return Array.from(this.tickets.values()).filter(t => t.status === status).length;
  }
  
  // ============================================================
  // State Transition Validation
  // ============================================================
  _validateTransition(currentStatus, newStatus) {
    // Normalize legacy status for transition check
    const normalized = currentStatus === 'leased' ? TICKET_STATUS.RUNNING 
                     : currentStatus === 'completed' ? TICKET_STATUS.DONE
                     : currentStatus;
    
    const allowed = VALID_TRANSITIONS[normalized] || [];
    if (!allowed.includes(newStatus)) {
      return {
        valid: false,
        error: `Invalid state transition: ${currentStatus} → ${newStatus} (allowed: ${allowed.join(', ') || 'none'})`
      };
    }
    return { valid: true };
  }

  // ============================================================
  // lease: pending → running (with lock)
  // ============================================================
  async lease(kind, limit = 1, leaseSec = 300, owner = null) {
    const now = Date.now();
    const expiresAt = now + leaseSec * 1000; // epoch ms (Stage 2 TTL format)

    const leaseOwner = owner || `lease:${newLeaseToken()}`;

    console.log(`🔍 [Store] Leasing Request: Kind=${kind}, Limit=${limit}`);

    // 1. 先釋放過期租約
    await this.releaseExpiredLeases();

    // 2. 篩選符合條件的票據 (pending only)
    const candidates = [];
    for (const ticket of this.tickets.values()) {
        if (candidates.length >= limit) break;

        const isPending = ticket.status === TICKET_STATUS.PENDING;
        const isKindMatch = (!kind) || (ticket.metadata?.kind === kind);

        if (isPending && isKindMatch) {
            candidates.push(ticket);
        }
    }

    console.log(`   👉 Candidates found: ${candidates.length}`);

    // 3. 執行租賃: pending → running (atomic lock)
    const nowTs = new Date().toISOString();
    for (const ticket of candidates) {
      ticket.status = TICKET_STATUS.RUNNING;  // 'running' not 'leased'
      ticket.metadata.leased_at = nowTs;
      ticket.metadata.lease_expires = expiresAt;  // epoch ms
      ticket.metadata.lease_owner = leaseOwner;
      ticket.metadata.lease_token = newLeaseToken();
      ticket.metadata.updated_at = nowTs;
    }
    
    if (candidates.length > 0) {
        console.log(`✅ [Store] Leased ${candidates.length} tickets (status=running).`);
    }

    return candidates;
  }

  // ============================================================
  // complete: running/pending → done (with outputs)
  // Note: Allow from pending for direct fill (bypass lease) scenarios
  // Note: Idempotent - if already done, just return ticket
  // ============================================================
  async complete(id, outputs, by, leaseProof = null) {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    
    // Idempotent: already done → just return
    if (ticket.status === TICKET_STATUS.DONE || ticket.status === 'completed') {
      console.log(`ℹ️ [Store] Ticket ${id} already done (idempotent).`);
      return ticket;
    }
    
    // Allow from running, pending, or legacy leased
    // pending → done is valid for direct fill without lease
    const canComplete = ticket.status === TICKET_STATUS.RUNNING 
                     || ticket.status === TICKET_STATUS.PENDING
                     || ticket.status === 'leased';
    if (!canComplete) {
      throw new Error(`Cannot complete ticket ${id}: current status '${ticket.status}' is not running or pending`);
    }

    // Guardrails:
    // - pending → done is only allowed for explicit "direct fill" by values
    // - running tickets leased by worker must present matching lease_owner/lease_token
    if (ticket.status === TICKET_STATUS.PENDING) {
      // Guardrail: must be explicit (no undefined -> default)
      if (by === undefined || by === null || by === '') {
        emitGuardReject({
          ticket,
          action: 'complete_direct_fill_missing_by',
          code: 'direct_fill_missing_by',
          reason: 'pending→done requires explicit by (http_fill/system/manual)',
          details: { allowed_by: Array.from(DIRECT_FILL_ALLOWLIST) }
        });
        return { ok: false, code: 'direct_fill_missing_by' };
      }

      if (!DIRECT_FILL_ALLOWLIST.has(String(by))) {
        emitGuardReject({
          ticket,
          action: 'complete_direct_fill_not_allowed',
          code: 'direct_fill_not_allowed',
          reason: `direct fill not allowed for by='${by}'`,
          details: { by, allowed_by: Array.from(DIRECT_FILL_ALLOWLIST) }
        });
        return { ok: false, code: 'direct_fill_not_allowed' };
      }
    } else if (ticket.status === TICKET_STATUS.RUNNING || ticket.status === 'leased') {
      const expectedOwner = ticket.metadata?.lease_owner;
      const expectedToken = ticket.metadata?.lease_token;

      // If we have a lease_token (Stage 2), enforce proof.
      if (expectedToken) {
        const provided = normalizeLeaseProof(leaseProof);
        const okToken = provided.token && provided.token === expectedToken;
        const okOwner = expectedOwner ? (provided.owner && provided.owner === expectedOwner) : true;

        if (!okToken || !okOwner) {
          emitGuardReject({
            ticket,
            action: 'complete_lease_owner_mismatch',
            code: 'lease_owner_mismatch',
            reason: 'lease proof mismatch on complete()',
            details: {
              by,
              expected_owner: expectedOwner,
              expected_token_present: true,
              provided_owner: provided.owner,
              provided_token_present: Boolean(provided.token)
            }
          });
          return { ok: false, code: 'lease_owner_mismatch' };
        }
      }
    }
    
    const nowTs = new Date().toISOString();
    ticket.status = TICKET_STATUS.DONE;
    ticket.metadata.completed_at = nowTs;
    ticket.metadata.completed_by = by;
    ticket.metadata.final_outputs = outputs;

    // M2-C.1: canonical tool_verdict must live at ticket.tool_verdict (root).
    // - If outputs provides a valid verdict, write canonical object.
    // - If missing, DO NOT backfill with null (keeps strict gating meaningful).
    const normalizedVerdict = normalizeToolVerdict(outputs && outputs.tool_verdict);
    if (normalizedVerdict && normalizedVerdict.status) {
      ticket.tool_verdict = normalizedVerdict;
    } else {
      const hasExistingCanonical = ticket.tool_verdict !== undefined && ticket.tool_verdict !== null;
      if (!hasExistingCanonical) {
        cutoverMetrics.inc('canonical_missing', 'tool_verdict', { source: 'store' });
        logAudit({
          ts: new Date().toISOString(),
          action: 'cutover_canonical_missing',
          ticket_id: ticket.id,
          kind: ticket?.metadata?.kind,
          field: 'tool_verdict',
          where: 'TicketStore.complete'
        });
      }
    }

    ticket.metadata.updated_at = nowTs;
    // Clean up lease metadata
    delete ticket.metadata.lease_expires;
    delete ticket.metadata.leased_at;
    delete ticket.metadata.lease_owner;
    delete ticket.metadata.lease_token;
    
    console.log(`🏁 [Store] Ticket ${id} DONE.`);
    return ticket;
  }

  // ============================================================
  // fail: running → failed (with error info)
  // ============================================================
  async fail(id, error, by, leaseProof = null) {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    
    const canFail = ticket.status === TICKET_STATUS.RUNNING || ticket.status === 'leased';
    if (!canFail) {
      throw new Error(`Cannot fail ticket ${id}: current status '${ticket.status}' is not running`);
    }

    // Enforce lease proof when Stage 2 lease token exists
    const expectedOwner = ticket.metadata?.lease_owner;
    const expectedToken = ticket.metadata?.lease_token;
    if (expectedToken) {
      const provided = normalizeLeaseProof(leaseProof);
      const okToken = provided.token && provided.token === expectedToken;
      const okOwner = expectedOwner ? (provided.owner && provided.owner === expectedOwner) : true;
      if (!okToken || !okOwner) {
        emitGuardReject({
          ticket,
          action: 'fail_lease_owner_mismatch',
          code: 'lease_owner_mismatch',
          reason: 'lease proof mismatch on fail()',
          details: {
            by,
            expected_owner: expectedOwner,
            expected_token_present: true,
            provided_owner: provided.owner,
            provided_token_present: Boolean(provided.token)
          }
        });
        return { ok: false, code: 'lease_owner_mismatch' };
      }
    }
    
    const nowTs = new Date().toISOString();
    ticket.status = TICKET_STATUS.FAILED;
    ticket.metadata.failed_at = nowTs;
    ticket.metadata.failed_by = by;
    ticket.metadata.error = error;
    ticket.metadata.updated_at = nowTs;
    // Clean up lease metadata
    delete ticket.metadata.lease_expires;
    delete ticket.metadata.leased_at;
    delete ticket.metadata.lease_owner;
    delete ticket.metadata.lease_token;
    
    console.log(`❌ [Store] Ticket ${id} FAILED: ${error}`);
    return ticket;
  }

  // ============================================================
  // block: running → blocked (schemaGate strict / policy rejection)
  // ============================================================
  async block(id, spec) {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);

    const code = spec?.code;
    const reason = spec?.reason;
    const source = spec?.source;
    if (!code || typeof code !== 'string') throw new Error('block() requires spec.code (string)');
    if (!reason || typeof reason !== 'string') throw new Error('block() requires spec.reason (string)');
    
    // Can block from pending or running
    const canBlock = ticket.status === TICKET_STATUS.PENDING 
                  || ticket.status === TICKET_STATUS.RUNNING 
                  || ticket.status === 'leased';
    if (!canBlock) {
      throw new Error(`Cannot block ticket ${id}: current status '${ticket.status}'`);
    }
    
    const nowTs = new Date().toISOString();
    ticket.status = TICKET_STATUS.BLOCKED;
    ticket.metadata.blocked_at = nowTs;
    ticket.metadata.block = {
      code,
      reason,
      source
    };
    ticket.metadata.updated_at = nowTs;
    // Clean up lease metadata if was running
    delete ticket.metadata.lease_expires;
    delete ticket.metadata.leased_at;
    delete ticket.metadata.lease_owner;
    delete ticket.metadata.lease_token;
    
    console.log(`🚫 [Store] Ticket ${id} BLOCKED: ${code}`);
    return ticket;
  }

  // ============================================================
  // unblock: blocked → pending (after fix)
  // ============================================================
  async unblock(id, by) {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    
    if (ticket.status !== TICKET_STATUS.BLOCKED) {
      throw new Error(`Cannot unblock ticket ${id}: current status '${ticket.status}' is not blocked`);
    }
    
    const nowTs = new Date().toISOString();
    ticket.status = TICKET_STATUS.PENDING;
    ticket.metadata.unblocked_at = nowTs;
    ticket.metadata.unblocked_by = by;
    ticket.metadata.updated_at = nowTs;
    // Keep block history for audit
    
    console.log(`✅ [Store] Ticket ${id} UNBLOCKED → pending.`);
    return ticket;
  }

  // ============================================================
  // retry: failed → pending (for retry queue)
  // ============================================================
  async retry(id, by) {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    
    if (ticket.status !== TICKET_STATUS.FAILED) {
      throw new Error(`Cannot retry ticket ${id}: current status '${ticket.status}' is not failed`);
    }
    
    const nowTs = new Date().toISOString();
    ticket.status = TICKET_STATUS.PENDING;
    ticket.metadata.retry_at = nowTs;
    ticket.metadata.retry_by = by;
    ticket.metadata.retry_count = (ticket.metadata.retry_count || 0) + 1;
    ticket.metadata.updated_at = nowTs;
    // Clear error but keep history
    delete ticket.metadata.error;
    
    console.log(`🔄 [Store] Ticket ${id} RETRY (#${ticket.metadata.retry_count}) → pending.`);
    return ticket;
  }

  // ============================================================
  // release: running → pending (release lock without result)
  // ============================================================
  async release(id, leaseProof = null) {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    
    const canRelease = ticket.status === TICKET_STATUS.RUNNING || ticket.status === 'leased';
    if (!canRelease) {
      throw new Error(`Cannot release ticket ${id}: current status '${ticket.status}' is not running`);
    }

    // Enforce lease proof when Stage 2 lease token exists
    const expectedOwner = ticket.metadata?.lease_owner;
    const expectedToken = ticket.metadata?.lease_token;
    if (expectedToken) {
      const provided = normalizeLeaseProof(leaseProof);
      const okToken = provided.token && provided.token === expectedToken;
      const okOwner = expectedOwner ? (provided.owner && provided.owner === expectedOwner) : true;
      if (!okToken || !okOwner) {
        emitGuardReject({
          ticket,
          action: 'release_lease_owner_mismatch',
          code: 'lease_owner_mismatch',
          reason: 'lease proof mismatch on release()',
          details: {
            expected_owner: expectedOwner,
            expected_token_present: true,
            provided_owner: provided.owner,
            provided_token_present: Boolean(provided.token)
          }
        });
        return { ok: false, code: 'lease_owner_mismatch' };
      }
    }
    
    const nowTs = new Date().toISOString();
    ticket.status = TICKET_STATUS.PENDING;
    ticket.metadata.updated_at = nowTs;
    delete ticket.metadata.lease_expires;
    delete ticket.metadata.leased_at;
    delete ticket.metadata.lease_owner;
    delete ticket.metadata.lease_token;
    
    console.log(`↩️ [Store] Ticket ${id} RELEASED → pending.`);
    return ticket;
  }
  
  // 保留舊介面相容性
  async updateStatus(ticketId, status) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    ticket.status = status;
    return ticket;
  }

  // ============================================================
  // releaseExpiredLeases: Auto-release expired running tickets
  // ============================================================
  async releaseExpiredLeases() {
    const now = Date.now();
    let count = 0;
    
    for (const ticket of this.tickets.values()) {
        // Handle both new 'running' and legacy 'leased'
        const isRunning = ticket.status === TICKET_STATUS.RUNNING || ticket.status === 'leased';
        if (isRunning && ticket.metadata.lease_expires) {
            // Support both epoch ms (new) and ISO string (legacy)
            const expires = typeof ticket.metadata.lease_expires === 'number'
              ? ticket.metadata.lease_expires
              : new Date(ticket.metadata.lease_expires).getTime();
            
            if (expires < now) {
                ticket.status = TICKET_STATUS.PENDING;
                delete ticket.metadata.lease_expires;
                delete ticket.metadata.leased_at;
                ticket.metadata.updated_at = new Date().toISOString();
                count++;
            }
        }
    }
    
    if (count > 0) console.log(`♻️ [Store] Released ${count} expired tickets.`);
    return count;
  }

  // ============================================================
  // Status Query Helpers
  // ============================================================
  async countByStatus() {
    const counts = {
      [TICKET_STATUS.PENDING]: 0,
      [TICKET_STATUS.RUNNING]: 0,
      [TICKET_STATUS.DONE]: 0,
      [TICKET_STATUS.FAILED]: 0,
      [TICKET_STATUS.BLOCKED]: 0,
      // Legacy counts
      leased: 0,
      completed: 0
    };
    
    for (const ticket of this.tickets.values()) {
      const status = ticket.status;
      if (counts[status] !== undefined) {
        counts[status]++;
      }
    }
    
    return counts;
  }

  // ============================================================
  // Guardrail Metrics Snapshot
  // ============================================================
  getGuardMetrics() {
    return {
      ticket_store_guard_reject_total: snapshotGuardCounters(guardMetricsCounters.rejects)
    };
  }
}

function getByPath(obj, path) {
  if (!obj) return undefined;
  if (!path || typeof path !== 'string') return undefined;

  // Friendly aliases for common caller expectations
  if (path === 'kind') {
    return obj.kind !== undefined ? obj.kind : obj.metadata?.kind;
  }
  if (path === 'parent_ticket_id') {
    return obj.parent_ticket_id !== undefined ? obj.parent_ticket_id : obj.metadata?.parent_ticket_id;
  }

  const parts = path.split('.');
  let cur = obj;

  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }

  return cur;
}

module.exports = TicketStore;
module.exports.TicketStore = TicketStore;
module.exports.TICKET_STATUS = TICKET_STATUS;
module.exports.VALID_TRANSITIONS = VALID_TRANSITIONS;
// Static hook for orchestrator/tests
module.exports.setAuditLogger = setAuditLogger;
TicketStore.setAuditLogger = setAuditLogger;