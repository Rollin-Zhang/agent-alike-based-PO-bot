import * as vscode from 'vscode';
import { Config } from './config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
    private outputChannel: vscode.OutputChannel;
    private logLevel: LogLevel;
    private configDisposable: vscode.Disposable;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Agent PO Bot');
        this.logLevel = Config.get().logs.level;

        // 監聽配置變更
        this.configDisposable = Config.onDidChange(() => {
            this.logLevel = Config.get().logs.level;
        });
    }

    private shouldLog(level: LogLevel): boolean {
        const levels = ['debug', 'info', 'warn', 'error'];
        const currentLevelIndex = levels.indexOf(this.logLevel);
        const messageLevelIndex = levels.indexOf(level);
        return messageLevelIndex >= currentLevelIndex;
    }

    private formatMessage(level: LogLevel, message: string, data?: any): string {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        const baseMessage = `[${timestamp}] ${levelStr} ${message}`;
        
        if (data) {
            try {
                const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
                return `${baseMessage}\n${dataStr}`;
            } catch (e) {
                return `${baseMessage}\n[Failed to serialize data: ${e}]`;
            }
        }
        
        return baseMessage;
    }

    private log(level: LogLevel, message: string, data?: any): void {
        if (!this.shouldLog(level)) {
            return;
        }

        const formattedMessage = this.formatMessage(level, message, data);
        this.outputChannel.appendLine(formattedMessage);

        // 對於錯誤級別，也顯示通知
        if (level === 'error') {
            vscode.window.showErrorMessage(`PO Bot: ${message}`);
        } else if (level === 'warn') {
            vscode.window.showWarningMessage(`PO Bot: ${message}`);
        }
    }

    debug(message: string, data?: any): void {
        this.log('debug', message, data);
    }

    info(message: string, data?: any): void {
        this.log('info', message, data);
    }

    warn(message: string, data?: any): void {
        this.log('warn', message, data);
    }

    error(message: string, data?: any): void {
        this.log('error', message, data);
    }

    // 票據相關的結構化日誌
    logTicketProcessing(ticketId: string, action: string, data?: any): void {
        this.info(`Ticket ${action}`, {
            ticket_id: ticketId,
            action,
            timestamp: new Date().toISOString(),
            ...data
        });
    }

    logModelInvocation(ticketId: string, modelName: string, latencyMs: number, tokens?: { prompt: number; completion: number }): void {
        this.info('Model invocation completed', {
            ticket_id: ticketId,
            model: modelName,
            latency_ms: latencyMs,
            tokens,
            timestamp: new Date().toISOString()
        });
    }

    logApiCall(method: string, url: string, statusCode: number, latencyMs: number, error?: string): void {
        const level = statusCode >= 400 ? 'error' : 'debug';
        this.log(level, `API ${method} ${url}`, {
            status_code: statusCode,
            latency_ms: latencyMs,
            error,
            timestamp: new Date().toISOString()
        });
    }

    show(): void {
        this.outputChannel.show();
    }

    dispose(): void {
        this.configDisposable.dispose();
        this.outputChannel.dispose();
    }
}