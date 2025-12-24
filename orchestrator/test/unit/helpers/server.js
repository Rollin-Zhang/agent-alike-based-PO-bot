/**
 * Server startup helper for integration tests
 * Only for test usage - do not import in production code
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');

/**
 * Find available port
 * @param {number} startPort - Start port to check
 * @returns {Promise<number>} Available port
 */
function findAvailablePort(startPort = 13000) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startPort, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
}

/**
 * Start server with custom environment variables using spawn
 * @param {Object} envOverrides - Environment variables to override
 * @returns {Promise<Object>} { baseUrl, port, stop, logsBuffer, serverProc }
 */
async function startServerWithEnv(envOverrides = {}) {
  const logsBuffer = [];
  
  // Find available port
  const port = await findAvailablePort();
  
  // Prepare environment
  const env = {
    ...process.env,
    ...envOverrides,
    ORCHESTRATOR_PORT: port.toString()
  };
  
  // Spawn server process
  const serverProc = spawn('node', ['index.js'], {
    cwd: __dirname + '/../../..',
    env: env,
    stdio: 'pipe'
  });
  
  // Capture logs
  serverProc.stdout.on('data', (data) => {
    const log = data.toString();
    logsBuffer.push(log);
  });
  
  serverProc.stderr.on('data', (data) => {
    const log = data.toString();
    logsBuffer.push(log);
    console.error('[Server Error]', log.trim());
  });
  
  // Wait for server to be ready
  await waitForServerReady(port);
  
  const baseUrl = `http://localhost:${port}`;
  
  // Function to stop server
  const stop = async () => {
    return new Promise((resolve) => {
      if (serverProc && !serverProc.killed) {
        serverProc.on('exit', () => resolve());
        serverProc.kill('SIGTERM');
        
        // Force kill after 2 seconds
        setTimeout(() => {
          if (!serverProc.killed) {
            serverProc.kill('SIGKILL');
          }
        }, 2000);
      } else {
        resolve();
      }
    });
  };
  
  return {
    baseUrl,
    port,
    stop,
    logsBuffer,
    serverProc
  };
}

/**
 * Wait for server to be ready by polling /metrics endpoint
 * @param {number} port - Server port
 * @param {number} maxWaitMs - Max wait time in ms
 * @returns {Promise<void>}
 */
async function waitForServerReady(port, maxWaitMs = 5000) {
  const start = Date.now();
  const interval = 100;

  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > maxWaitMs) {
        return reject(new Error(`Server did not start within ${maxWaitMs}ms`));
      }

      const req = http.get(`http://localhost:${port}/metrics`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(check, interval);
        }
      });

      req.on('error', () => {
        setTimeout(check, interval);
      });
    };

    check();
  });
}

module.exports = {
  startServerWithEnv
};
