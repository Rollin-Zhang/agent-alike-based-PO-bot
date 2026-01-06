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
        
        // Phase A / NO_MCP-safe: deterministic contract self-test
        // - Create a TRIAGE ticket via POST /events
        // - Direct-fill via POST /v1/tickets/:id/fill (by=manual)
        // - Poll GET /v1/tickets/:id until terminal, then validate metadata.final_outputs
        outputChannel.appendLine('📤 Creating TRIAGE ticket via POST /events ...');

        const eventId = `self-test-${Date.now()}`;
        const event = {
            type: 'thread_post',
            source: 'vscode_self_test',
            event_id: eventId,
            content: 'VS Code self-test (Phase A) deterministic direct fill',
            features: {
                engagement: { likes: 100, comments: 50 }
            }
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
        
        // Deterministic fill (no LLM required)
        outputChannel.appendLine('🧾 Direct-filling TRIAGE ticket via /v1/tickets/:id/fill ...');

        const fillResp = await fetch(`${baseUrl}/v1/tickets/${ticketId}/fill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                outputs: {
                    decision: 'APPROVE',
                    short_reason: 'VS Code self-test direct fill',
                    reply_strategy: 'standard',
                    target_prompt_id: 'reply.standard'
                },
                by: 'manual'
            })
        });

        if (!fillResp.ok) {
            const txt = await fillResp.text();
            throw new Error(`Failed to fill ticket: ${fillResp.status} ${fillResp.statusText} body=${txt}`);
        }

        // Poll until terminal
        outputChannel.appendLine('⏳ Waiting for terminal status (done/failed/blocked)...');
        
        const maxWaitTime = 15000; // 15 seconds
        const pollInterval = 2000; // 2 seconds
        let elapsed = 0;
        
        while (elapsed < maxWaitTime) {
            const ticketResponse = await fetch(`${baseUrl}/v1/tickets/${ticketId}`);
            if (!ticketResponse.ok) {
                throw new Error(`Failed to fetch ticket: ${ticketResponse.status}`);
            }
            
            const ticket = await ticketResponse.json();

            const status = String(ticket.status || '');
            if (status === 'done') {
                const finalOutputs = ticket?.metadata?.final_outputs;
                const decision = finalOutputs?.decision;
                outputChannel.appendLine(`✅ Terminal status: done`);
                outputChannel.appendLine(`📦 final_outputs.decision: ${decision ?? 'N/A'}`);

                if (decision === 'APPROVE') {
                    outputChannel.appendLine('✅ TRIAGE contract + fill path OK.');

                    // Bonus target for Phase A: wait for derived REPLY ticket to reach terminal status
                    outputChannel.appendLine('🔎 Looking for derived REPLY ticket (triage_reference_id match) ...');

                    const findReplyTicketId = async (triageId: string, timeoutMs: number): Promise<string | null> => {
                        const started = Date.now();
                        while (Date.now() - started < timeoutMs) {
                            const listResp = await fetch(`${baseUrl}/v1/tickets?limit=10000`);
                            if (listResp.ok) {
                                const listJson: any = await listResp.json();
                                const tickets: any[] = Array.isArray(listJson)
                                    ? listJson
                                    : Array.isArray(listJson?.tickets)
                                        ? listJson.tickets
                                        : Array.isArray(listJson?.data)
                                            ? listJson.data
                                            : [];

                                const reply = tickets.find((t: any) =>
                                    (t?.metadata?.kind === 'REPLY') && (t?.metadata?.triage_reference_id === triageId)
                                );
                                if (reply?.id) {
                                    return String(reply.id);
                                }
                            }

                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                        return null;
                    };

                    const replyTicketId = await findReplyTicketId(ticketId, 20000);
                    if (!replyTicketId) {
                        outputChannel.appendLine('❌ Could not find derived REPLY ticket within timeout');
                        vscode.window.showErrorMessage('❌ PO Bot Self-test failed: REPLY ticket not found');
                        return;
                    }

                    outputChannel.appendLine(`✅ Found REPLY ticket: ${replyTicketId}`);
                    outputChannel.appendLine('⏳ Waiting for REPLY terminal status (done/blocked/failed)...');

                    const maxWaitReplyMs = 45000;
                    let replyElapsed = 0;
                    while (replyElapsed < maxWaitReplyMs) {
                        const replyResp = await fetch(`${baseUrl}/v1/tickets/${replyTicketId}`);
                        if (!replyResp.ok) {
                            throw new Error(`Failed to fetch REPLY ticket: ${replyResp.status}`);
                        }
                        const replyTicket = await replyResp.json();
                        const replyStatus = String(replyTicket?.status || '');

                        if (replyStatus === 'done') {
                            outputChannel.appendLine('✅ REPLY terminal status: done');
                            outputChannel.appendLine('🎉 Self-test PASSED! TRIAGE + REPLY reached terminal states.');
                            vscode.window.showInformationMessage('✅ PO Bot Self-test passed!');
                            return;
                        }

                        if (replyStatus === 'blocked') {
                            outputChannel.appendLine('⚠️ REPLY terminal status: blocked');
                            outputChannel.appendLine(`📦 REPLY metadata: ${JSON.stringify(replyTicket?.metadata || {}, null, 2)}`);
                            outputChannel.appendLine('🎉 Self-test PASSED (with warning): REPLY reached terminal state (blocked).');
                            vscode.window.showWarningMessage('⚠️ PO Bot Self-test passed (REPLY blocked)');
                            return;
                        }

                        if (replyStatus === 'failed') {
                            outputChannel.appendLine('❌ REPLY terminal status: failed');
                            outputChannel.appendLine(`📦 REPLY metadata: ${JSON.stringify(replyTicket?.metadata || {}, null, 2)}`);
                            vscode.window.showErrorMessage('❌ PO Bot Self-test failed: REPLY failed');
                            return;
                        }

                        outputChannel.appendLine(`⏱️  REPLY Status: ${replyStatus}, waiting...`);
                        await new Promise(resolve => setTimeout(resolve, pollInterval));
                        replyElapsed += pollInterval;
                    }

                    outputChannel.appendLine('⏰ REPLY wait timed out');
                    vscode.window.showWarningMessage('⚠️ PO Bot Self-test timed out waiting for REPLY');
                    return;
                } else {
                    outputChannel.appendLine(`❌ Self-test FAILED! Expected decision=APPROVE, got ${String(decision)}`);
                    vscode.window.showErrorMessage('❌ PO Bot Self-test failed!');
                }
                return;
            }

            if (status === 'failed' || status === 'blocked') {
                outputChannel.appendLine(`❌ Terminal status: ${status}`);
                outputChannel.appendLine(`📦 metadata: ${JSON.stringify(ticket?.metadata || {}, null, 2)}`);
                vscode.window.showErrorMessage(`❌ PO Bot Self-test failed: ${status}`);
                return;
            }

            outputChannel.appendLine(`⏱️  Status: ${status}, waiting...`);
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