class TicketStore {
  constructor() {
    this.tickets = new Map();
    // 移除 queue，改用 Map 遍歷篩選，以支援 kind 過濾
  }
  
  async create(ticket) {
    if (!ticket.metadata) ticket.metadata = {};
    if (!ticket.metadata.created_at) ticket.metadata.created_at = new Date().toISOString();

    this.tickets.set(ticket.id, ticket);
    console.log(`📥 [Store] New Ticket: ${ticket.id} | Kind: ${ticket.metadata.kind} | Status: ${ticket.status}`);
    return ticket;
  }
  
  async get(ticketId) {
    return this.tickets.get(ticketId) || null;
  }
  
  async list(options = {}) {
    const { status, limit = 100, offset = 0 } = options;
    
    let tickets = Array.from(this.tickets.values());
    
    if (status) {
      tickets = tickets.filter(ticket => ticket.status === status);
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
  
  // [核心修改] 參數改為 (kind, limit, leaseSec) 以匹配 index.js
  async lease(kind, limit = 1, leaseSec = 300) {
    const now = Date.now();
    const expiresAt = new Date(now + leaseSec * 1000).toISOString();

    console.log(`🔍 [Store] Leasing Request: Kind=${kind}, Limit=${limit}`);

    // 1. 先釋放過期租約
    await this.releaseExpiredLeases();

    // 2. 篩選符合條件的票據
    const candidates = [];
    for (const ticket of this.tickets.values()) {
        if (candidates.length >= limit) break;

        const isPending = ticket.status === 'pending';
        // 關鍵：檢查 kind 是否匹配
        const isKindMatch = (!kind) || (ticket.metadata?.kind === kind);

        if (isPending && isKindMatch) {
            candidates.push(ticket);
        }
    }

    console.log(`   👉 Candidates found: ${candidates.length}`);

    // 3. 執行租賃 (更新狀態)
    for (const ticket of candidates) {
      ticket.status = 'leased';
      ticket.metadata.leased_at = new Date().toISOString();
      ticket.metadata.lease_expires = expiresAt;
      ticket.metadata.updated_at = new Date().toISOString();
    }
    
    if (candidates.length > 0) {
        console.log(`✅ [Store] Leased ${candidates.length} tickets.`);
    }

    return candidates;
  }

  // [新增] complete 方法以匹配 index.js
  async complete(id, outputs, by) {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    
    ticket.status = 'completed';
    ticket.metadata.completed_at = new Date().toISOString();
    ticket.metadata.completed_by = by;
    ticket.metadata.final_outputs = outputs;
    ticket.metadata.updated_at = new Date().toISOString();
    
    console.log(`🏁 [Store] Ticket ${id} COMPLETED.`);
    return ticket;
  }
  
  // 保留舊介面相容性
  async updateStatus(ticketId, status) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    ticket.status = status;
    return ticket;
  }

  async releaseExpiredLeases() {
    const now = new Date();
    let count = 0;
    
    for (const ticket of this.tickets.values()) {
        if (ticket.status === 'leased' && ticket.metadata.lease_expires) {
            if (new Date(ticket.metadata.lease_expires) < now) {
                ticket.status = 'pending';
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
}

module.exports = TicketStore;