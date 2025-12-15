import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { Logger } from './logger';
import { TicketWorker } from './ticketWorker';
import { TicketPanel } from './panel';

let ticketWorker: TicketWorker | undefined;
let ticketPanel: TicketPanel | undefined;
let logger: Logger | undefined;

export function activate(context: vscode.ExtensionContext) {
    // 👇👇👇【絕對路徑探針 & 時間戳記】👇👇👇
    // 這兩行是我們驗證「到底跑的是哪一版程式」的鐵證
    console.log('📍 [LOCATION PROBE] This code is running from:', __filename);
    console.log('⏰ [TIME PROBE] Compile Time Check:', new Date().toISOString());
    // 👆👆👆 只要看到這兩行，真相就大白了 👆👆👆

    // 初始化日誌
    logger = new Logger();
    
    // [DEBUG] 版本標記，確認 Log 是否來自最新版
    logger.info('🔥🔥🔥 V3-LOCATION-CHECK: Extension Activated! 🔥🔥🔥');
    
    // 記錄啟動信息
    const config = vscode.workspace.getConfiguration('agent-alike-po-bot');
    const hostInfo = {
        host: vscode.env.appName,
        version: vscode.version,
        sessionId: vscode.env.sessionId,
        orchestratorBaseUrl: config.get<string>('orchestrator.baseUrl', 'http://localhost:3000'),
        pollIntervalMs: config.get<number>('worker.pollIntervalMs', 5000),
        concurrency: config.get<number>('worker.concurrency', 2),
        timestamp: new Date().toISOString()
    };
    
    logger.info('Extension host info', hostInfo);

    // 初始化票據面板
    ticketPanel = new TicketPanel(context, logger);
    
    // 初始化票據工作器
    ticketWorker = new TicketWorker(logger, ticketPanel);
    
    // 註冊命令
    const refreshCommand = vscode.commands.registerCommand('agent-po-bot.refresh', () => {
        logger?.info('Manual refresh triggered');
        ticketPanel?.refresh();
    });

    const approveCommand = vscode.commands.registerCommand('agent-po-bot.approveTicket', async (ticket: any) => {
        logger?.info(`Approving ticket: ${ticket.id}`);
        await ticketPanel?.approveTicket(ticket);
    });

    const rejectCommand = vscode.commands.registerCommand('agent-po-bot.rejectTicket', async (ticket: any) => {
        logger?.info(`Rejecting ticket: ${ticket.id}`);
        await ticketPanel?.rejectTicket(ticket);
    });

    const viewCommand = vscode.commands.registerCommand('agent-po-bot.viewTicket', async (ticket: any) => {
        logger?.info(`Viewing ticket: ${ticket.id}`);
        await ticketPanel?.viewTicket(ticket);
    });

    const selfTestCommand = vscode.commands.registerCommand('agent-po-bot.selfTest', async () => {
        logger?.info('Self-test triggered');
        await runSelfTest();
    });

    // 註冊 Tree Data Provider
    vscode.window.registerTreeDataProvider('agent-po-bot.tickets', ticketPanel);

    // 啟動背景工作器
    // [DEBUG] 確保這裡有被執行
    console.log('🔄 [EXTENSION] Starting TicketWorker...');
    ticketWorker.start();

    // 清理註冊
    context.subscriptions.push(
        refreshCommand,
        approveCommand,
        rejectCommand,
        viewCommand,
        selfTestCommand,
        ticketWorker,
        ticketPanel
    );
    
    logger.info('Agent-alike PO Bot extension fully initialized');
}

/**
 * 執行 Q&A 自我測試
 */
async function runSelfTest(): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('PO Bot Self-Test');
    outputChannel.show();
    
    try {
        outputChannel.appendLine('🤖 Starting PO Bot Self-Test...');
        outputChannel.appendLine('================================');
        
        // 檢查設定
        const config = vscode.workspace.getConfiguration('agent-alike-po-bot');
        const baseUrl = config.get<string>('orchestrator.baseUrl', 'http://localhost:3000');
        
        outputChannel.appendLine(`📡 Orchestrator URL: ${baseUrl}`);
        
        // 提交診斷事件
        outputChannel.appendLine('📤 Submitting diagnostic event...');
        
        const timestamp = new Date().toISOString();
        const eventId = `self-test-${Date.now()}`;
        const threadId = `thread-self-test-${Date.now()}`;
        
        const event = {
            type: 'diagnostic_qa',
            event_id: eventId,
            thread_id: threadId,
            content: '請計算 123 + 456，答案只要數字，不要其他文字。',
            actor: 'vscode_self_test',
            timestamp
        };
        
        // 使用 fetch 提交事件
        const response = await fetch(`${baseUrl}/events`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(event)
        });
        
        if (!response.ok) {
            throw new Error(`Failed to submit event: ${response.status} ${response.statusText}`);
        }
        
        const result = await response.json();
        const ticketId = result.ticket_id;
        
        outputChannel.appendLine(`✅ Event submitted, ticket ID: ${ticketId}`);
        
        // 等待處理完成
        outputChannel.appendLine('⏳ Waiting for processing...');
        
        const maxWaitTime = 30000; // 30 seconds
        const pollInterval = 2000; // 2 seconds
        let elapsed = 0;
        
        while (elapsed < maxWaitTime) {
            const ticketResponse = await fetch(`${baseUrl}/ticket/${ticketId}`);
            if (!ticketResponse.ok) {
                throw new Error(`Failed to fetch ticket: ${ticketResponse.status}`);
            }
            
            const ticket = await ticketResponse.json();
            
            // 在 drafted 或 completed/approved 狀態皆可驗證
            if (ticket.status === 'drafted' || ticket.status === 'completed' || ticket.status === 'approved') {
                if (typeof ticket.draft === 'object' && ticket.draft !== null && 'content' in ticket.draft) {
                    outputChannel.appendLine(`✅ Draft available (object)`);
                    outputChannel.appendLine(`📄 Draft: "${ticket.draft.content}"`);
                    outputChannel.appendLine(`🎯 Confidence: ${ticket.draft.confidence ?? 'N/A'}`);

                    const draftText = String(ticket.draft.content).trim();
                    if (draftText === '579') {
                        outputChannel.appendLine('🎉 Self-test PASSED! Answer is correct.');
                        vscode.window.showInformationMessage('✅ PO Bot Self-test passed!');
                    } else {
                        outputChannel.appendLine(`❌ Self-test FAILED! Expected "579", got "${draftText}"`);
                        vscode.window.showErrorMessage('❌ PO Bot Self-test failed!');
                    }
                    return;
                }
                if (typeof ticket.draft === 'string') {
                    outputChannel.appendLine(`✅ Draft available (string)`);
                    outputChannel.appendLine(`📄 Draft: "${ticket.draft}"`);
                    const draftText = ticket.draft.trim();
                    if (draftText === '579') {
                        outputChannel.appendLine('🎉 Self-test PASSED! Answer is correct.');
                        vscode.window.showInformationMessage('✅ PO Bot Self-test passed!');
                    } else {
                        outputChannel.appendLine(`❌ Self-test FAILED! Expected "579", got "${draftText}"`);
                        vscode.window.showErrorMessage('❌ PO Bot Self-test failed!');
                    }
                    return;
                }

                outputChannel.appendLine('❌ Status indicates drafted/completed but no usable draft found');
                vscode.window.showErrorMessage('❌ Self-test failed: No draft generated');
                return;
            } else if (ticket.status === 'failed' || ticket.status === 'rejected') {
                outputChannel.appendLine(`❌ Processing failed with status: ${ticket.status}`);
                vscode.window.showErrorMessage('❌ Self-test failed: Processing failed');
                return;
            }
            
            outputChannel.appendLine(`⏱️  Status: ${ticket.status}, waiting...`);
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            elapsed += pollInterval;
        }
        
        outputChannel.appendLine('⏰ Self-test timed out');
        vscode.window.showWarningMessage('⚠️ Self-test timed out');
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`💥 Self-test failed: ${errorMessage}`);
        vscode.window.showErrorMessage(`❌ Self-test failed: ${errorMessage}`);
    }
}

export function deactivate() {
    logger?.info('Agent-alike PO Bot extension deactivated');
    
    if (ticketWorker) {
        ticketWorker.dispose();
        ticketWorker = undefined;
    }
    
    if (ticketPanel) {
        ticketPanel.dispose();
        ticketPanel = undefined;
    }
    
    if (logger) {
        logger.dispose();
        logger = undefined;
    }
}