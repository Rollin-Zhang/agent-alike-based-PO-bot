const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

class AuditLogger {
  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ 
          filename: 'logs/audit.log',
          maxsize: 100 * 1024 * 1024, // 100MB
          maxFiles: 10
        }),
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });
    
    this.executionLogs = new Map();
    this.taskLogs = new Map();
  }
  
  logExecution(executionId, status, details = {}) {
    const logEntry = {
      type: 'execution',
      execution_id: executionId,
      status: status,
      timestamp: new Date().toISOString(),
      ...details
    };
    
    this.executionLogs.set(executionId, logEntry);
    this.logger.info('Execution log', logEntry);
    
    return logEntry;
  }
  
  logTask(taskId, flowId, tool, details = {}) {
    const logEntry = {
      type: 'task',
      task_id: taskId,
      flow_id: flowId,
      tool: tool,
      timestamp: new Date().toISOString(),
      ...details
    };
    
    this.taskLogs.set(taskId, logEntry);
    this.logger.info('Task log', logEntry);
    
    return logEntry;
  }
  
  logEvent(eventType, data = {}) {
    const logEntry = {
      type: 'event',
      event_type: eventType,
      event_id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...data
    };
    
    this.logger.info('Event log', logEntry);
    return logEntry;
  }
  
  logSecurity(action, details = {}) {
    const logEntry = {
      type: 'security',
      action: action,
      security_id: uuidv4(),
      timestamp: new Date().toISOString(),
      severity: details.severity || 'info',
      ...details
    };
    
    this.logger.warn('Security log', logEntry);
    return logEntry;
  }
  
  logPerformance(operation, metrics = {}) {
    const logEntry = {
      type: 'performance',
      operation: operation,
      perf_id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...metrics
    };
    
    this.logger.info('Performance log', logEntry);
    return logEntry;
  }
  
  getExecutionLogs(executionId) {
    return this.executionLogs.get(executionId);
  }
  
  getTaskLogs(taskId) {
    return this.taskLogs.get(taskId);
  }
  
  getRecentLogs(limit = 100, type = null) {
    // 在實際實作中，這會從檔案或資料庫查詢
    const allLogs = [
      ...Array.from(this.executionLogs.values()),
      ...Array.from(this.taskLogs.values())
    ];
    
    let filtered = allLogs;
    if (type) {
      filtered = allLogs.filter(log => log.type === type);
    }
    
    return filtered
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }
  
  getMetrics(timeRange = '1h') {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.parseTimeRange(timeRange));
    
    const recentTasks = Array.from(this.taskLogs.values())
      .filter(log => new Date(log.timestamp) > cutoff);
    
    const successful = recentTasks.filter(log => log.status === 'success').length;
    const failed = recentTasks.filter(log => log.status === 'error').length;
    const total = recentTasks.length;
    
    const durations = recentTasks
      .filter(log => log.duration_ms)
      .map(log => log.duration_ms);
    
    return {
      time_range: timeRange,
      total_tasks: total,
      successful_tasks: successful,
      failed_tasks: failed,
      success_rate: total > 0 ? successful / total : 0,
      avg_duration_ms: durations.length > 0 
        ? durations.reduce((a, b) => a + b, 0) / durations.length 
        : 0,
      p95_duration_ms: this.percentile(durations, 0.95),
      timestamp: now.toISOString()
    };
  }
  
  parseTimeRange(timeRange) {
    const unit = timeRange.slice(-1);
    const value = parseInt(timeRange.slice(0, -1));
    
    switch (unit) {
      case 'h': return value * 60 * 60 * 1000;
      case 'm': return value * 60 * 1000;
      case 's': return value * 1000;
      default: return 60 * 60 * 1000; // 預設 1 小時
    }
  }
  
  percentile(arr, p) {
    if (arr.length === 0) return 0;
    
    const sorted = arr.slice().sort((a, b) => a - b);
    const index = Math.floor(sorted.length * p);
    return sorted[index] || 0;
  }
  
  // 清理舊日誌（可定期執行）
  cleanup(retentionDays = 30) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    
    let cleaned = 0;
    
    for (const [id, log] of this.executionLogs.entries()) {
      if (new Date(log.timestamp) < cutoff) {
        this.executionLogs.delete(id);
        cleaned++;
      }
    }
    
    for (const [id, log] of this.taskLogs.entries()) {
      if (new Date(log.timestamp) < cutoff) {
        this.taskLogs.delete(id);
        cleaned++;
      }
    }
    
    this.logger.info(`Cleaned up ${cleaned} old log entries`);
    return cleaned;
  }
}

module.exports = AuditLogger;