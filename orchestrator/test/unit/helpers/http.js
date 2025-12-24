/**
 * HTTP helpers for integration tests
 * Only for test usage - do not import in production code
 */

const http = require('http');

/**
 * Generic HTTP request helper
 */
function httpRequest(baseUrl, path, method, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const postData = data ? JSON.stringify(data) : null;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData && { 'Content-Length': Buffer.byteLength(postData) })
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, data: json });
        } catch (err) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    
    if (postData) {
      req.write(postData);
    }
    
    req.end();
  });
}

/**
 * POST /v1/tickets/:id/fill
 * @param {string} baseUrl - Server base URL
 * @param {string} ticketId - Ticket ID
 * @param {Object} outputs - Fill outputs
 * @param {string} by - Optional by field
 * @returns {Promise<Object>} Response {status, data}
 */
async function httpPostFill(baseUrl, ticketId, outputs, by = 'test-agent') {
  return httpRequest(baseUrl, `/v1/tickets/${ticketId}/fill`, 'POST', { outputs, by });
}

/**
 * POST /events (no /v1 prefix)
 * @param {string} baseUrl - Server base URL
 * @param {Object} event - Event payload
 * @returns {Promise<Object>} Response {status, data}
 */
async function httpPostEvent(baseUrl, event) {
  return httpRequest(baseUrl, '/events', 'POST', event);
}

/**
 * GET /v1/tickets/:id
 * @param {string} baseUrl - Server base URL
 * @param {string} ticketId - Ticket ID
 * @returns {Promise<Object>} Response {status, data}
 */
async function httpGetTicket(baseUrl, ticketId) {
  return httpRequest(baseUrl, `/v1/tickets/${ticketId}`, 'GET');
}

/**
 * GET /v1/tickets (list)
 * @param {string} baseUrl - Server base URL
 * @param {Object} params - Query params {status, limit}
 * @returns {Promise<Object>} Response {status, data}
 */
async function httpListTickets(baseUrl, params = {}) {
  const query = new URLSearchParams(params).toString();
  const path = query ? `/v1/tickets?${query}` : '/v1/tickets';
  return httpRequest(baseUrl, path, 'GET');
}

module.exports = {
  httpPostFill,
  httpPostEvent,
  httpGetTicket,
  httpListTickets
};
