const { v4: uuidv4 } = require('uuid');
const ToolGateway = require('../tool_gateway/ToolGateway');

class DAGExecutor {
  constructor(auditLogger) {
    this.auditLogger = auditLogger;
    this.toolGateway = new ToolGateway();
  }
  
  async execute(flowSpec, ticket) {
    const executionId = uuidv4();
    const context = {
      execution_id: executionId,
      ticket_id: ticket.id,
      flow_id: flowSpec.id,
      event: ticket.event,
      variables: {}
    };
    
    this.auditLogger.logExecution(executionId, 'start', {
      flow_id: flowSpec.id,
      ticket_id: ticket.id
    });
    
    try {
      const result = await this.executeDAG(flowSpec.dag, context);
      
      this.auditLogger.logExecution(executionId, 'success', {
        result_summary: this.summarizeResult(result)
      });
      
      return result;
    } catch (error) {
      this.auditLogger.logExecution(executionId, 'error', {
        error: error.message
      });
      throw error;
    }
  }
  
  async executeDAG(dag, context) {
    const nodeStates = new Map();
    const completed = new Set();
    const results = {};
    
    // 建立節點映射
    const nodeMap = new Map();
    dag.nodes.forEach(node => nodeMap.set(node.id, node));
    
    // 建立邊映射
    const incomingEdges = new Map();
    const outgoingEdges = new Map();
    
    dag.nodes.forEach(node => {
      incomingEdges.set(node.id, []);
      outgoingEdges.set(node.id, []);
    });
    
    dag.edges.forEach(edge => {
      if (edge.from !== 'start') {
        outgoingEdges.get(edge.from).push(edge);
      }
      if (edge.to !== 'end') {
        incomingEdges.get(edge.to).push(edge);
      }
    });
    
    // 找到起始節點（沒有前驅的節點）
    const startNodes = dag.edges
      .filter(edge => edge.from === 'start')
      .map(edge => edge.to);
    
    // 執行拓撲排序和節點執行
    const queue = [...startNodes];
    
    while (queue.length > 0) {
      const nodeId = queue.shift();
      
      if (completed.has(nodeId)) {
        continue;
      }
      
      // 檢查前驅節點是否都已完成
      const incoming = incomingEdges.get(nodeId) || [];
      const prereqsMet = incoming
        .filter(edge => edge.from !== 'start')
        .every(edge => completed.has(edge.from));
      
      if (!prereqsMet) {
        queue.push(nodeId); // 重新排隊
        continue;
      }
      
      // 執行節點
      const node = nodeMap.get(nodeId);
      try {
        const nodeResult = await this.executeNode(node, context, results);
        results[nodeId] = nodeResult;
        completed.add(nodeId);
        
        // 將後繼節點加入佇列
        const outgoing = outgoingEdges.get(nodeId) || [];
        outgoing.forEach(edge => {
          if (edge.to !== 'end' && this.evaluateCondition(edge, context, results)) {
            queue.push(edge.to);
          }
        });
        
      } catch (error) {
        throw new Error(`Node ${nodeId} failed: ${error.message}`);
      }
    }
    
    return results;
  }
  
  async executeNode(node, context, previousResults) {
    const taskId = uuidv4();
    const startTime = Date.now();
    
    // 處理輸入參數
    const inputs = this.resolveInputs(node.inputs || {}, context, previousResults);
    
    this.auditLogger.logTask(taskId, context.flow_id, node.tool, {
      input_summary: this.summarizeInputs(inputs),
      node_id: node.id
    });
    
    try {
      let result;
      
      // 檢查是否為 stub 工具
      if (this.isStubTool(node.tool)) {
        result = await this.executeStubTool(node.tool, inputs);
      } else {
        result = await this.toolGateway.invoke(node.tool, inputs);
      }
      
      const duration = Date.now() - startTime;
      
      this.auditLogger.logTask(taskId, context.flow_id, node.tool, {
        status: 'success',
        duration_ms: duration,
        output_summary: this.summarizeOutput(result)
      });
      
      return result;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      this.auditLogger.logTask(taskId, context.flow_id, node.tool, {
        status: 'error',
        duration_ms: duration,
        error: error.message
      });
      
      throw error;
    }
  }
  
  resolveInputs(inputs, context, previousResults) {
    const resolved = {};
    
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        // 變數替換
        const varPath = value.slice(2, -1);
        resolved[key] = this.resolveVariable(varPath, context, previousResults);
      } else {
        resolved[key] = value;
      }
    }
    
    return resolved;
  }
  
  resolveVariable(varPath, context, previousResults) {
    const parts = varPath.split('.');
    
    if (parts[0] === 'event') {
      let result = context.event;
      for (let i = 1; i < parts.length; i++) {
        result = result?.[parts[i]];
      }
      return result;
    }
    
    if (previousResults[parts[0]]) {
      let result = previousResults[parts[0]];
      for (let i = 1; i < parts.length; i++) {
        result = result?.[parts[i]];
      }
      return result;
    }
    
    return undefined;
  }
  
  evaluateCondition(edge, context, results) {
    if (!edge.condition) {
      return true;
    }
    
    // 簡單的條件評估（可以擴展）
    return true;
  }
  
  isStubTool(toolName) {
    return toolName === 'llm.generate' || 
           toolName === 'reply.send' || 
           toolName === 'guard.check_content' ||
           toolName === 'threads.get' ||
           toolName === 'threads.fetch_thread' ||
           toolName === 'mem.search';
  }
  
  async executeStubTool(toolName, inputs) {
    switch (toolName) {
      case 'threads.get':
      case 'threads.fetch_thread':
        return {
          thread_id: inputs.thread_id,
          title: '測試討論串',
          content: inputs.content || '擷取的討論串內容',
          messages: [
            { role: 'user', content: inputs.content || '測試訊息' }
          ]
        };
        
      case 'mem.search':
        return {
          memories: [
            { content: '相關記憶片段', relevance: 0.8 }
          ],
          total: 1
        };
        
      case 'llm.generate':
        return {
          draft: '這是一個模擬的回覆草稿，基於提供的上下文生成。',
          confidence: 0.75,
          reasoning: '模擬推理過程'
        };
        
      case 'guard.check_content':
        return {
          approved: true,
          confidence: 0.9,
          flags: [],
          reasoning: '內容通過安全檢查'
        };
      
      case 'reply.send':
        return {
          status: 'sent',
          message_id: 'mock_' + Date.now(),
          dry_run: inputs.dry_run || true
        };
      
      default:
        throw new Error(`Unknown stub tool: ${toolName}`);
    }
  }
  
  summarizeInputs(inputs) {
    return Object.keys(inputs).join(', ');
  }
  
  summarizeOutput(output) {
    if (typeof output === 'object') {
      return Object.keys(output).join(', ');
    }
    return String(output).slice(0, 100);
  }
  
  summarizeResult(results) {
    return `Executed ${Object.keys(results).length} nodes`;
  }
}

module.exports = DAGExecutor;