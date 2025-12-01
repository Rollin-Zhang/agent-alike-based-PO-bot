const axios = require('axios');
const fs = require('fs');

class ToolGateway {
  constructor() {
    this.mcpConfig = this.loadMCPConfig();
    this.toolMap = this.buildToolMap();
  }
  
  loadMCPConfig() {
    try {
      const configPath = process.env.MCP_CONFIG_PATH || './mcp_config.json';
      const path = require('path');
      const absolutePath = path.resolve(configPath);
      const configData = fs.readFileSync(absolutePath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      throw new Error(`Failed to load MCP config: ${error.message}`);
    }
  }
  
  buildToolMap() {
    const toolMap = new Map();
    
    for (const [serverName, serverConfig] of Object.entries(this.mcpConfig.mcp_servers)) {
      for (const tool of serverConfig.tools) {
        toolMap.set(tool, {
          server: serverName,
          endpoint: serverConfig.endpoint,
          timeout: serverConfig.timeout || 30
        });
      }
    }
    
    return toolMap;
  }
  
  async invoke(toolName, inputs) {
    const toolConfig = this.toolMap.get(toolName);
    
    if (!toolConfig) {
      throw new Error(`Tool not found: ${toolName}`);
    }
    
    // 檢查工具是否在白名單中
    if (!this.mcpConfig.tool_whitelist.includes(toolName)) {
      throw new Error(`Tool not whitelisted: ${toolName}`);
    }
    
    try {
      const response = await axios.post(
        `${toolConfig.endpoint}/invoke`,
        {
          tool: toolName,
          inputs: inputs
        },
        {
          timeout: toolConfig.timeout * 1000,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
      
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`MCP server unavailable: ${toolConfig.server}`);
      }
      
      if (error.response && error.response.status === 429) {
        throw new Error(`Rate limit exceeded for tool: ${toolName}`);
      }
      
      throw new Error(`Tool invocation failed: ${error.message}`);
    }
  }
  
  async healthCheck() {
    const results = {};
    
    for (const [serverName, serverConfig] of Object.entries(this.mcpConfig.mcp_servers)) {
      try {
        const response = await axios.get(
          `${serverConfig.endpoint}/health`,
          { timeout: 5000 }
        );
        
        results[serverName] = {
          status: 'healthy',
          response_time: response.headers['x-response-time'] || 'unknown'
        };
        
      } catch (error) {
        results[serverName] = {
          status: 'unhealthy',
          error: error.message
        };
      }
    }
    
    return results;
  }
  
  getAvailableTools() {
    return Array.from(this.toolMap.keys());
  }
  
  getToolInfo(toolName) {
    const toolConfig = this.toolMap.get(toolName);
    
    if (!toolConfig) {
      return null;
    }
    
    const serverConfig = this.mcpConfig.mcp_servers[toolConfig.server];
    
    return {
      tool: toolName,
      server: toolConfig.server,
      endpoint: toolConfig.endpoint,
      description: serverConfig.description,
      rate_limits: serverConfig.rate_limits,
      timeout: serverConfig.timeout,
      whitelisted: this.mcpConfig.tool_whitelist.includes(toolName)
    };
  }
}

module.exports = ToolGateway;