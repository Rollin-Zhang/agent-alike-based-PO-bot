class TicketStore {
  constructor() {
    this.tickets = new Map();
    this.queue = [];
  }
  
  async create(ticket) {
    this.tickets.set(ticket.id, ticket);
    this.queue.push(ticket.id);
    return ticket;
  }
  
  async get(ticketId) {
    return this.tickets.get(ticketId) || null;
  }
  
  async list(options = {}) {
    const { status, limit = 10, offset = 0 } = options;
    
    let tickets = Array.from(this.tickets.values());
    
    if (status) {
      tickets = tickets.filter(ticket => ticket.status === status);
    }
    
    return tickets
      .sort((a, b) => new Date(b.metadata.created_at) - new Date(a.metadata.created_at))
      .slice(offset, offset + limit);
  }
  
  async count(options = {}) {
    const { status } = options;
    
    if (!status) {
      return this.tickets.size;
    }
    
    return Array.from(this.tickets.values())
      .filter(ticket => ticket.status === status)
      .length;
  }
  
  async updateStatus(ticketId, status) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    
    ticket.status = status;
    ticket.metadata.updated_at = new Date().toISOString();
    
    return ticket;
  }
  
  async fill(ticketId, draft, confidence, modelInfo) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    
    ticket.draft = {
      content: draft,
      confidence: confidence || 0.5,
      model_info: modelInfo || null
    };
    ticket.status = 'drafted'; // 狀態變更為已草稿
    ticket.metadata.updated_at = new Date().toISOString();
    
    return ticket;
  }
  
  async approve(ticketId) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    
    if (ticket.status !== 'completed') {
      throw new Error(`Ticket is not ready for approval. Status: ${ticket.status}`);
    }
    
    ticket.status = 'approved';
    ticket.metadata.updated_at = new Date().toISOString();
    
    return ticket;
  }
  
  async lease(count = 1, workerId, leaseTimeout = 300) {
    const pendingTickets = await this.list({ status: 'pending', limit: count });
    const leasedTickets = [];
    
    for (const ticket of pendingTickets) {
      ticket.status = 'leased';
      ticket.metadata.assigned_to = workerId;
      ticket.metadata.lease_expires = new Date(Date.now() + leaseTimeout * 1000).toISOString();
      ticket.metadata.updated_at = new Date().toISOString();
      
      leasedTickets.push(ticket);
    }
    
    return leasedTickets;
  }
  
  async releaseExpiredLeases() {
    const now = new Date();
    const expiredTickets = Array.from(this.tickets.values())
      .filter(ticket => 
        ticket.status === 'leased' && 
        ticket.metadata.lease_expires &&
        new Date(ticket.metadata.lease_expires) < now
      );
    
    for (const ticket of expiredTickets) {
      ticket.status = 'pending';
      delete ticket.metadata.assigned_to;
      delete ticket.metadata.lease_expires;
      ticket.metadata.updated_at = new Date().toISOString();
    }
    
    return expiredTickets.length;
  }
}

module.exports = TicketStore;