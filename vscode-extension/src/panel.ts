import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiClient } from './apiClient';
import { Config } from './config';
import { Ticket } from './types';

// 面板項目基類
abstract class PanelItem extends vscode.TreeItem {}

export class TicketPanel implements vscode.TreeDataProvider<PanelItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<PanelItem | undefined | null | void> = new vscode.EventEmitter<PanelItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<PanelItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private tickets: Ticket[] = [];
    private logger: Logger;
    private apiClient: ApiClient;
    private refreshTimer: NodeJS.Timeout | undefined;
    private configDisposable: vscode.Disposable;

    constructor(
        private context: vscode.ExtensionContext,
        logger: Logger
    ) {
        this.logger = logger;
        this.apiClient = new ApiClient(logger);

        // 監聽配置變更
        this.configDisposable = Config.onDidChange(() => {
            this.refresh();
        });

        // 定期刷新票據列表
        this.startAutoRefresh();
    }

    /**
     * 開始自動刷新
     */
    private startAutoRefresh(): void {
        this.refreshTimer = setInterval(() => {
            this.refresh();
        }, 10000); // 每 10 秒刷新一次
    }

    /**
     * 刷新票據列表
     */
    async refresh(): Promise<void> {
        try {
            this.logger.debug('Refreshing ticket panel');

            // 獲取所有狀態的票據
            const allTickets = await Promise.allSettled([
                this.apiClient.getPendingTickets(),
                // Stage 2
                this.fetchTicketsByStatus('running'),
                this.fetchTicketsByStatus('done'),
                this.fetchTicketsByStatus('blocked'),
                this.fetchTicketsByStatus('drafted'),
                this.fetchTicketsByStatus('completed'),
                this.fetchTicketsByStatus('approved'),
                this.fetchTicketsByStatus('failed')
            ]);

            this.tickets = [];
            
            for (const result of allTickets) {
                if (result.status === 'fulfilled') {
                    this.tickets.push(...result.value);
                }
            }

            // 依時間排序（最新的在前）
            this.tickets.sort((a, b) => 
                new Date(b.metadata.updated_at).getTime() - new Date(a.metadata.updated_at).getTime()
            );

            this._onDidChangeTreeData.fire(undefined);
            
            this.logger.debug(`Refreshed ${this.tickets.length} tickets`);

        } catch (error) {
            this.logger.error('Failed to refresh tickets', error);
            vscode.window.showErrorMessage('無法刷新票據列表');
        }
    }

    /**
     * 依狀態獲取票據（備用方法）
     */
    private async fetchTicketsByStatus(status: string): Promise<Ticket[]> {
        try {
            return await this.apiClient.getTicketsByStatus(status, 500);
        } catch (error) {
            this.logger.debug(`Failed to fetch ${status} tickets`, error);
            return [];
        }
    }

    /**
     * TreeDataProvider 實作
     */
    getTreeItem(element: PanelItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: PanelItem): Thenable<PanelItem[]> {
        if (!element) {
            // 根節點：按狀態分組
            const groupedItems: PanelItem[] = [];
            
            const statusGroups = this.groupTicketsByStatus();
            
            for (const [status, tickets] of Object.entries(statusGroups)) {
                if (tickets.length > 0) {
                    groupedItems.push(new StatusGroupItem(status, tickets.length));
                }
            }

            return Promise.resolve(groupedItems);
        } else if (element instanceof StatusGroupItem) {
            // 狀態分組：返回該狀態的票據
            const statusTickets = this.tickets.filter(t => t.status === element.status);
            return Promise.resolve(statusTickets.map(ticket => new TicketItem(ticket)));
        }

        return Promise.resolve([]);
    }

    /**
     * 依狀態分組票據
     */
    private groupTicketsByStatus(): Record<string, Ticket[]> {
        const groups: Record<string, Ticket[]> = {};
        
        for (const ticket of this.tickets) {
            if (!groups[ticket.status]) {
                groups[ticket.status] = [];
            }
            groups[ticket.status].push(ticket);
        }

        return groups;
    }

    /**
     * 核准票據
     */
    async approveTicket(ticketItem: TicketItem): Promise<void> {
        if (!ticketItem.ticket) {
            return;
        }

        const ticket = ticketItem.ticket;
        
        try {
            this.logger.info(`Approving ticket ${ticket.id}`);

            const config = Config.get();
            await this.apiClient.approveTicket(ticket.id, {
                approved: true,
                dry_run: config.send.dryRun
            });

            vscode.window.showInformationMessage(
                `票據 ${ticket.id.substring(0, 8)} 已核准${config.send.dryRun ? ' (乾跑模式)' : ''}`
            );

            // 刷新列表
            await this.refresh();

        } catch (error) {
            this.logger.error(`Failed to approve ticket ${ticket.id}`, error);
            vscode.window.showErrorMessage(`核准票據失敗：${error instanceof Error ? error.message : '未知錯誤'}`);
        }
    }

    /**
     * 拒絕票據
     */
    async rejectTicket(ticketItem: TicketItem): Promise<void> {
        if (!ticketItem.ticket) {
            return;
        }

        const ticket = ticketItem.ticket;

        try {
            this.logger.info(`Rejecting ticket ${ticket.id}`);

            await this.apiClient.approveTicket(ticket.id, {
                approved: false,
                dry_run: true // 拒絕總是乾跑
            });

            vscode.window.showInformationMessage(`票據 ${ticket.id.substring(0, 8)} 已拒絕`);

            // 刷新列表
            await this.refresh();

        } catch (error) {
            this.logger.error(`Failed to reject ticket ${ticket.id}`, error);
            vscode.window.showErrorMessage(`拒絕票據失敗：${error instanceof Error ? error.message : '未知錯誤'}`);
        }
    }

    /**
     * 檢視票據詳情
     */
    async viewTicket(ticketItem: TicketItem): Promise<void> {
        if (!ticketItem.ticket) {
            return;
        }

        const ticket = ticketItem.ticket;

        try {
            // 獲取最新票據資料
            const latestTicket = await this.apiClient.getTicket(ticket.id);
            
            // 創建並顯示詳情面板
            const panel = vscode.window.createWebviewPanel(
                'ticketDetail',
                `票據詳情 - ${ticket.id.substring(0, 8)}`,
                vscode.ViewColumn.One,
                {
                    enableScripts: true
                }
            );

            panel.webview.html = this.generateTicketDetailHTML(latestTicket);

        } catch (error) {
            this.logger.error(`Failed to view ticket ${ticket.id}`, error);
            vscode.window.showErrorMessage(`無法檢視票據詳情：${error instanceof Error ? error.message : '未知錯誤'}`);
        }
    }

    /**
     * 產生票據詳情 HTML
     */
    private generateTicketDetailHTML(ticket: Ticket): string {
        const formatDate = (dateStr: string) => {
            return new Date(dateStr).toLocaleString('zh-TW');
        };

        const getStatusBadge = (status: string) => {
            const colors: Record<string, string> = {
                'pending': '#ffa500',
                'in_progress': '#0066cc',
                'running': '#0066cc',
                'drafted': '#28a745',
                'completed': '#17a2b8',
                'done': '#28a745',
                'approved': '#6f42c1',
                'blocked': '#ffa500',
                'failed': '#dc3545'
            };
            
            return `<span style="background-color: ${colors[status] || '#6c757d'}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px;">${status}</span>`;
        };

        return `<!DOCTYPE html>
        <html lang="zh-TW">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>票據詳情</title>
            <style>
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                    margin: 20px; 
                    line-height: 1.6;
                }
                .header { 
                    border-bottom: 1px solid #eee; 
                    padding-bottom: 15px; 
                    margin-bottom: 20px; 
                }
                .section { 
                    margin-bottom: 20px; 
                    padding: 15px; 
                    border: 1px solid #ddd; 
                    border-radius: 4px; 
                }
                .label { 
                    font-weight: bold; 
                    color: #333; 
                }
                .value { 
                    margin-left: 10px; 
                }
                .draft-content { 
                    background-color: #f8f9fa; 
                    padding: 10px; 
                    border-radius: 4px; 
                    margin-top: 10px; 
                    border-left: 4px solid #007acc; 
                }
                .metadata { 
                    font-size: 12px; 
                    color: #666; 
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>票據詳情</h2>
                <p><span class="label">ID:</span> <span class="value">${ticket.id}</span></p>
                <p><span class="label">狀態:</span> <span class="value">${getStatusBadge(ticket.status)}</span></p>
                <p><span class="label">流程:</span> <span class="value">${ticket.flow_id}</span></p>
            </div>

            <div class="section">
                <h3>原始事件</h3>
                <p><span class="label">類型:</span> <span class="value">${ticket.event.type}</span></p>
                <p><span class="label">討論串 ID:</span> <span class="value">${ticket.event.thread_id}</span></p>
                <p><span class="label">發送者:</span> <span class="value">${ticket.event.actor}</span></p>
                <p><span class="label">時間:</span> <span class="value">${formatDate(ticket.event.timestamp)}</span></p>
                <div class="draft-content">
                    <strong>內容:</strong><br>
                    ${ticket.event.content}
                </div>
            </div>

            <div class="section">
                <h3>限制條件</h3>
                <p><span class="label">語言:</span> <span class="value">${ticket.constraints.lang}</span></p>
                <p><span class="label">最大字數:</span> <span class="value">${ticket.constraints.max_chars}</span></p>
            </div>

            ${ticket.draft ? `
            <div class="section">
                <h3>草稿回覆</h3>
                <p><span class="label">信心分數:</span> <span class="value">${(ticket.draft.confidence * 100).toFixed(1)}%</span></p>
                <div class="draft-content">
                    <strong>回覆內容:</strong><br>
                    ${ticket.draft.content}
                </div>
            </div>
            ` : ''}

            <div class="section metadata">
                <h3>元資料</h3>
                <p><span class="label">建立時間:</span> <span class="value">${formatDate(ticket.metadata.created_at)}</span></p>
                <p><span class="label">更新時間:</span> <span class="value">${formatDate(ticket.metadata.updated_at)}</span></p>
                ${ticket.version ? `<p><span class="label">版本:</span> <span class="value">${ticket.version}</span></p>` : ''}
            </div>
        </body>
        </html>`;
    }

    /**
     * 清理資源
     */
    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this.configDisposable.dispose();
        this._onDidChangeTreeData.dispose();
    }
}

/**
 * 狀態分組項目
 */
class StatusGroupItem extends PanelItem {
    constructor(
        public readonly status: string,
        public readonly count: number
    ) {
        super(`${status} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
        
        this.tooltip = `${count} 張 ${status} 狀態的票據`;
        this.contextValue = 'statusGroup';
        
        // 設定圖示
        const iconMap: Record<string, string> = {
            'pending': 'clock',
            'in_progress': 'loading~spin',
            'running': 'loading~spin',
            'drafted': 'edit',
            'completed': 'check',
            'done': 'check',
            'approved': 'verified',
            'blocked': 'warning',
            'failed': 'error'
        };
        
        this.iconPath = new vscode.ThemeIcon(iconMap[status] || 'circle-outline');
    }
}

/**
 * 票據項目
 */
class TicketItem extends PanelItem {
    constructor(
        public readonly ticket: Ticket
    ) {
        const label = `${ticket.event.actor}: ${ticket.event.content.substring(0, 30)}${ticket.event.content.length > 30 ? '...' : ''}`;
        
        super(label, vscode.TreeItemCollapsibleState.None);
        
        this.tooltip = this.buildTooltip();
        this.description = this.buildDescription();
        this.contextValue = `ticket-${ticket.status}`;
        
        // 設定圖示
        this.iconPath = this.getStatusIcon(ticket.status);
    }

    private buildTooltip(): string {
        const t = this.ticket;
        return `ID: ${t.id}
狀態: ${t.status}
發送者: ${t.event.actor}
時間: ${new Date(t.event.timestamp).toLocaleString('zh-TW')}
內容: ${t.event.content}
${t.draft ? `\n草稿: ${t.draft.content}\n信心: ${(t.draft.confidence * 100).toFixed(1)}%` : ''}`;
    }

    private buildDescription(): string {
        const t = this.ticket;
        const timeStr = new Date(t.metadata.updated_at).toLocaleString('zh-TW', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        if (t.draft) {
            return `${(t.draft.confidence * 100).toFixed(0)}% • ${timeStr}`;
        }
        
        return timeStr;
    }

    private getStatusIcon(status: string): vscode.ThemeIcon {
        const iconMap: Record<string, string> = {
            'pending': 'clock',
            'in_progress': 'loading~spin',
            'running': 'loading~spin',
            'drafted': 'edit',
            'completed': 'check',
            'done': 'check',
            'approved': 'verified',
            'blocked': 'warning',
            'failed': 'error'
        };
        
        return new vscode.ThemeIcon(iconMap[status] || 'circle-outline');
    }
}