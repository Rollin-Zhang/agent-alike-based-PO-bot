class FlowRegistry {
  constructor() {
    this.flows = new Map();
    this.initializeFlows();
  }
  
  initializeFlows() {
    // 基本回覆流程
    const replyBasicTw = {
      id: 'reply_basic_tw',
      name: '基本回覆流程 (繁體中文)',
      version: '1.0.0',
      description: '處理一般社群媒體回覆的基本流程',
      trigger_conditions: {
        event_types: ['thread_reply', 'mention'],
        filters: {
          language: 'zh-tw'
        }
      },
      dag: {
        nodes: [
          {
            id: 'fetch_thread',
            tool: 'threads.fetch_thread',
            inputs: {
              thread_id: '${event.thread_id}'
            }
          },
          {
            id: 'mem_search',
            tool: 'mem.search',
            inputs: {
              query: '${fetch_thread.content}',
              limit: 5
            }
          },
          {
            id: 'llm_generate',
            tool: 'llm.generate',
            inputs: {
              context: '${fetch_thread}',
              memories: '${mem_search}',
              persona: 'helpful_assistant'
            }
          },
          {
            id: 'guard_check',
            tool: 'guard.check_content',
            inputs: {
              content: '${llm_generate.draft}',
              policies: ['safety', 'brand_guidelines']
            }
          },
          {
            id: 'reply_send',
            tool: 'reply.send',
            inputs: {
              thread_id: '${event.thread_id}',
              content: '${llm_generate.draft}',
              dry_run: true
            },
            conditions: {
              guard_approved: '${guard_check.approved}',
              confidence_threshold: 0.7
            }
          }
        ],
        edges: [
          { from: 'start', to: 'fetch_thread' },
          { from: 'fetch_thread', to: 'mem_search' },
          { from: 'mem_search', to: 'llm_generate' },
          { from: 'llm_generate', to: 'guard_check' },
          { from: 'guard_check', to: 'reply_send' },
          { from: 'reply_send', to: 'end' }
        ]
      },
      guardrails: {
        auto_send_threshold: 0.8,
        sensitive_topics: ['政治', '醫療建議', '法律諮詢'],
        rate_limits: {
          per_thread: 3,
          per_actor: 10,
          global_daily: 1000
        }
      }
    };
    
    this.flows.set(replyBasicTw.id, replyBasicTw);
    
    // Q&A 診斷流程
    const diagnosticQaTw = {
      id: 'diagnostic_qa_tw',
      name: 'Q&A 診斷流程 (繁體中文)',
      version: '1.0.0',
      description: '專門用於測試 LLM 運作狀態的簡單計算診斷流程',
      trigger_conditions: {
        event_types: ['diagnostic_qa'],
        filters: {
          language: 'zh-tw'
        }
      },
      dag: {
        nodes: [],
        edges: []
      },
      constraints: {
        max_chars: 16,
        format: 'numeric_only',
        expected_answer: '579'
      },
      guardrails: {
        auto_send_threshold: 1.0, // 診斷測試自動通過
        rate_limits: {
          per_thread: 100,
          per_actor: 100,
          global_daily: 10000
        }
      }
    };
    
    this.flows.set(diagnosticQaTw.id, diagnosticQaTw);
  }
  
  getFlow(flowId) {
    return this.flows.get(flowId);
  }
  
  listFlows() {
    return Array.from(this.flows.values());
  }
  
  registerFlow(flowSpec) {
    this.validateFlowSpec(flowSpec);
    this.flows.set(flowSpec.id, flowSpec);
  }
  
  validateFlowSpec(flowSpec) {
    if (!flowSpec.id || !flowSpec.dag || !flowSpec.dag.nodes) {
      throw new Error('Invalid flow specification');
    }
    
    // 驗證 DAG 結構
    const nodeIds = new Set(flowSpec.dag.nodes.map(node => node.id));
    
    for (const edge of flowSpec.dag.edges || []) {
      if (edge.from !== 'start' && !nodeIds.has(edge.from)) {
        throw new Error(`Invalid edge: unknown source node ${edge.from}`);
      }
      if (edge.to !== 'end' && !nodeIds.has(edge.to)) {
        throw new Error(`Invalid edge: unknown target node ${edge.to}`);
      }
    }
  }
}

module.exports = FlowRegistry;