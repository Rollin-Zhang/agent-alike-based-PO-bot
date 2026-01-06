const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

class ToolGateway {
  constructor(logger, config) {
    const baseLogger = logger || console;
    // Defensive: some tests pass a "quiet logger" without .info
    this.logger = {
      info: (baseLogger.info || baseLogger.log || (() => {})).bind(baseLogger),
      warn: (baseLogger.warn || baseLogger.log || (() => {})).bind(baseLogger),
      error: (baseLogger.error || baseLogger.log || (() => {})).bind(baseLogger),
      log: (baseLogger.log || (() => {})).bind(baseLogger)
    };
    // 支援從參數傳入 config，或自動讀取
    this.config = config || this.loadMCPConfig();
    this.clients = new Map(); // 用於儲存 Stdio 連線 (serverName -> Client)
    this.toolMap = this.buildToolMap();
  }

  /**
   * Graceful shutdown: close all MCP client transports.
   *
   * NOTE: Without this, processes that used stdio MCP servers may keep the event loop alive
   * and make gated "real MCP" tests hang.
   */
  async shutdown() {
    const entries = Array.from(this.clients.entries());
    this.clients.clear();

    for (const [serverName, client] of entries) {
      try {
        if (client && typeof client.close === 'function') {
          await client.close();
        }
      } catch (e) {
        this.logger?.warn?.(`[ToolGateway] Failed to close client for ${serverName}`, { error: e?.message });
      }
    }
  }

  loadMCPConfig() {
    try {
      const configPath = process.env.MCP_CONFIG_PATH || path.join(__dirname, '../mcp_config.json');
      if (!fs.existsSync(configPath)) {
        this.logger.warn(`[ToolGateway] Config not found at ${configPath}, using empty config.`);
        return { mcp_servers: {}, tool_whitelist: [] };
      }
      const configData = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      throw new Error(`Failed to load MCP config: ${error.message}`);
    }
  }

  buildToolMap() {
    const toolMap = new Map();
    const servers = this.config.mcp_servers || {};

    for (const [serverName, serverConfig] of Object.entries(servers)) {
      const tools = serverConfig.tools || [];
      for (const tool of tools) {
        toolMap.set(tool, {
          server: serverName,
          // 判斷這是 HTTP 還是 Stdio 類型的 Server
          type: serverConfig.command ? 'stdio' : 'http',
          endpoint: serverConfig.endpoint,
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
          timeout: serverConfig.timeout || 30
        });
      }
    }
    return toolMap;
  }

  /**
   * 初始化：啟動所有 Stdio 類型的 MCP Server
   */
  async initialize() {
    this.logger.info('[ToolGateway] Initializing...');
    const servers = this.config.mcp_servers || {};

    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg.command) {
        await this.connectStdioServer(name, cfg);
      }
    }
  }

  async connectStdioServer(name, cfg) {
    try {
      this.logger.info(`[ToolGateway] Connecting to Stdio server: ${name}...`);

      // 路徑處理：如果是相對路徑的 js 檔，轉為絕對路徑
      let args = [...(cfg.args || [])];
      if (args.length > 0 && args[0].endsWith('.js') && !path.isAbsolute(args[0])) {
        // 假設相對路徑是相對於 orchestrator 根目錄
        args[0] = path.resolve(process.cwd(), args[0]);
      }

      const transport = new StdioClientTransport({
        command: cfg.command,
        args: args,
        env: { ...process.env, ...(cfg.env || {}) }
      });

      const client = new Client(
        { name: "orchestrator", version: "1.0.0" },
        { capabilities: {} }
      );

      await client.connect(transport);
      this.clients.set(name, client);

      // 列出工具以確認連線
      const tools = await client.listTools();
      const toolNames = tools.tools.map(t => t.name).join(', ');
      this.logger.info(`[ToolGateway] Connected to [${name}]. Available tools: ${toolNames}`);

    } catch (e) {
      this.logger.error(`[ToolGateway] Failed to connect to ${name}`, { error: e.message });
    }
  }

  /**
   * 統一執行入口
   */
  async executeTool(serverName, toolName, args) {
    // 1. 查找工具配置
    // 有時候呼叫者可能只給了 toolName，我們嘗試反查 serverName
    if (!serverName) {
      const info = this.toolMap.get(toolName);
      if (info) serverName = info.server;
    }

    // 2. 獲取 Server 設定
    const servers = this.config.mcp_servers || {};
    const serverConfig = servers[serverName];

    if (!serverConfig) {
      throw new Error(`Server '${serverName}' not defined in config.`);
    }

    // 3. 檢查白名單 (Optional)
    const whitelist = this.config.tool_whitelist || [];
    if (whitelist.length > 0 && !whitelist.includes(toolName)) {
       // 寬容模式：如果 whitelist 沒設定或為空，則允許所有
       // 嚴格模式：throw new Error(`Tool not whitelisted: ${toolName}`);
    }

    this.logger.info(`[ToolGateway] Executing ${serverName}.${toolName}`, { args });
    const startTime = Date.now();
    let result = null;
    let status = 'SUCCESS';
    let errorMsg = null;

    try {
      // 分流處理：Stdio vs HTTP
      if (serverConfig.command) {
        // --- Stdio 模式 (本地 MCP) ---
        const client = this.clients.get(serverName);
        if (!client) throw new Error(`MCP Client for ${serverName} is not connected.`);
        
        result = await client.callTool({
          name: toolName,
          arguments: args
        });

      } else {
        // --- HTTP 模式 (舊有設計) ---
        if (!serverConfig.endpoint) throw new Error(`Endpoint missing for HTTP server ${serverName}`);
        
        const response = await axios.post(
          `${serverConfig.endpoint}/invoke`, // 假設這是對方的 API 格式
          { tool: toolName, inputs: args }, // 注意：舊版用 inputs，新版用 arguments，這裡需適配
          { timeout: (serverConfig.timeout || 30) * 1000 }
        );
        result = response.data;
      }

      return result;

    } catch (e) {
      status = 'ERROR';
      errorMsg = e.message;
      this.logger.error(`[ToolGateway] Execution failed`, { error: e.message });
      throw e;
    } finally {
      // 寫入 Audit Log
      this.writeAuditLog({
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        server: serverName,
        tool: toolName,
        args: args,
        status: status,
        error: errorMsg,
        result_preview: result ? JSON.stringify(result).substring(0, 100) + '...' : null
      });
    }
  }

  writeAuditLog(entry) {
    const configuredPath = process.env.TOOL_AUDIT_PATH || process.env.TOOL_AUDIT_LOG_PATH;
    const logPath = configuredPath
      ? path.resolve(configuredPath)
      : path.join(process.cwd(), 'logs', 'tool_audit.jsonl');
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    
    fs.appendFile(logPath, JSON.stringify(entry) + '\n', (err) => {
      if (err) console.error('Failed to write audit log', err);
    });
  }

  /**
   * M2-A.1: Get dependency states (ProviderId 視角)
   * 
   * @returns {Object} { [providerId]: { ready:boolean, code:DEP_*, detail?:object } }
   * 
   * 不可變規則：
   * - 只回報 SSOT 中定義的 providers (memory, web_search, notebooklm)
   * - NO_MCP=true 時所有 providers ready=false, code=DEP_UNAVAILABLE
   * - Stdio servers: 以 this.clients 是否有連線決定
   * - HTTP servers: 不在此版本處理（未來可擴充 health check）
   */
  getDepStates() {
    const { DEP_CODES } = require('../lib/readiness/ssot');
    const states = {};

    // Keep this list aligned with SSOT's ProviderIds
    const knownProviders = ['memory', 'web_search', 'notebooklm'];

    // Check NO_MCP mode
    const NO_MCP = process.env.NO_MCP === 'true';
    if (NO_MCP) {
      // NO_MCP: all known providers unavailable
      for (const providerId of knownProviders) {
        states[providerId] = {
          ready: false,
          code: DEP_CODES.UNAVAILABLE,
          // Low-cardinality detail only
          detail: { provider: providerId, phase: 'boot', hint: 'no_mcp_mode' }
        };
      }
      return states;
    }

    // Normal mode: check stdio servers connectivity
    const servers = this.config.mcp_servers || {};

    for (const providerId of knownProviders) {
      const serverConfig = servers[providerId];

      if (!serverConfig) {
        states[providerId] = {
          ready: false,
          // Guardrail (小洞 B): config 缺失時使用穩定且一致的 dep-level code
          code: DEP_CODES.UNAVAILABLE,
          // Low-cardinality detail only
          detail: { provider: providerId, phase: 'config', hint: 'missing_config' }
        };
        continue;
      }

      if (serverConfig.command) {
        // Stdio server: check if client is connected
        const client = this.clients.get(providerId);
        if (client) {
          states[providerId] = { ready: true, code: null };
        } else {
          states[providerId] = {
            ready: false,
            code: DEP_CODES.INIT_FAILED,
            // Low-cardinality detail only (raw error strings should go to audit logs, not snapshot)
            detail: { provider: providerId, phase: 'init', hint: 'client_not_connected' }
          };
        }
      } else {
        // HTTP server: 暫不支援 health check（未來可擴充）
        // 當前假設 HTTP servers 總是 ready（舊行為相容）
        states[providerId] = { ready: true, code: null };
      }
    }

    return states;
  }
}

module.exports = ToolGateway;