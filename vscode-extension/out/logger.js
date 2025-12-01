"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
class Logger {
    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Agent PO Bot');
        this.logLevel = config_1.Config.get().logs.level;
        // 監聽配置變更
        this.configDisposable = config_1.Config.onDidChange(() => {
            this.logLevel = config_1.Config.get().logs.level;
        });
    }
    shouldLog(level) {
        const levels = ['debug', 'info', 'warn', 'error'];
        const currentLevelIndex = levels.indexOf(this.logLevel);
        const messageLevelIndex = levels.indexOf(level);
        return messageLevelIndex >= currentLevelIndex;
    }
    formatMessage(level, message, data) {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        const baseMessage = `[${timestamp}] ${levelStr} ${message}`;
        if (data) {
            try {
                const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
                return `${baseMessage}\n${dataStr}`;
            }
            catch (e) {
                return `${baseMessage}\n[Failed to serialize data: ${e}]`;
            }
        }
        return baseMessage;
    }
    log(level, message, data) {
        if (!this.shouldLog(level)) {
            return;
        }
        const formattedMessage = this.formatMessage(level, message, data);
        this.outputChannel.appendLine(formattedMessage);
        // 對於錯誤級別，也顯示通知
        if (level === 'error') {
            vscode.window.showErrorMessage(`PO Bot: ${message}`);
        }
        else if (level === 'warn') {
            vscode.window.showWarningMessage(`PO Bot: ${message}`);
        }
    }
    debug(message, data) {
        this.log('debug', message, data);
    }
    info(message, data) {
        this.log('info', message, data);
    }
    warn(message, data) {
        this.log('warn', message, data);
    }
    error(message, data) {
        this.log('error', message, data);
    }
    // 票據相關的結構化日誌
    logTicketProcessing(ticketId, action, data) {
        this.info(`Ticket ${action}`, {
            ticket_id: ticketId,
            action,
            timestamp: new Date().toISOString(),
            ...data
        });
    }
    logModelInvocation(ticketId, modelName, latencyMs, tokens) {
        this.info('Model invocation completed', {
            ticket_id: ticketId,
            model: modelName,
            latency_ms: latencyMs,
            tokens,
            timestamp: new Date().toISOString()
        });
    }
    logApiCall(method, url, statusCode, latencyMs, error) {
        const level = statusCode >= 400 ? 'error' : 'debug';
        this.log(level, `API ${method} ${url}`, {
            status_code: statusCode,
            latency_ms: latencyMs,
            error,
            timestamp: new Date().toISOString()
        });
    }
    show() {
        this.outputChannel.show();
    }
    dispose() {
        this.configDisposable.dispose();
        this.outputChannel.dispose();
    }
}
exports.Logger = Logger;
//# sourceMappingURL=logger.js.map