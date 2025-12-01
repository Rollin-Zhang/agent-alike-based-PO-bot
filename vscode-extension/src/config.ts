import * as vscode from 'vscode';

export interface ExtensionConfig {
    orchestrator: {
        baseUrl: string;
        authToken?: string;
    };
    worker: {
        pollIntervalMs: number;
        concurrency: number;
        batchSize: number;
        useV1Lease: boolean;
        kinds: Array<'TRIAGE' | 'REPLY'>;
        kindStrategy: 'triage_first' | 'reply_first' | 'round_robin' | 'weighted';
        kindWeights: Record<'TRIAGE' | 'REPLY', number>;
    };
    send: {
        dryRun: boolean;
    };
    model: {
        preferred: string;
    };
    logs: {
        level: 'debug' | 'info' | 'warn' | 'error';
    };
    reply: {
        maxChars: number;
    };
}

export class Config {
    private static readonly CONFIGURATION_SECTION = 'agent-alike-po-bot';

    static get(): ExtensionConfig {
        const config = vscode.workspace.getConfiguration(this.CONFIGURATION_SECTION);
        
        return {
            orchestrator: {
                baseUrl: config.get<string>('orchestrator.baseUrl', 'http://127.0.0.1:3000'),
                authToken: config.get<string | undefined>('orchestrator.authToken')
            },
            worker: {
                pollIntervalMs: config.get<number>('worker.pollIntervalMs', 5000),
                concurrency: config.get<number>('worker.concurrency', 2),
                batchSize: config.get<number>('worker.batchSize', 3),
                useV1Lease: config.get<boolean>('worker.useV1Lease', true),
                kinds: config.get<Array<'TRIAGE' | 'REPLY'>>('worker.kinds', ['TRIAGE']),
                kindStrategy: config.get<'triage_first' | 'reply_first' | 'round_robin' | 'weighted'>('worker.kindStrategy', 'triage_first'),
                kindWeights: config.get<Record<'TRIAGE' | 'REPLY', number>>('worker.kindWeights', { TRIAGE: 7, REPLY: 3 })
            },
            send: {
                dryRun: config.get<boolean>('send.dryRun', true)
            },
            model: {
                preferred: config.get<string>('model.preferred', 'gpt-4')
            },
            logs: {
                level: config.get<'debug' | 'info' | 'warn' | 'error'>('logs.level', 'info')
            },
            reply: {
                maxChars: config.get<number>('reply.maxChars', 320)
            }
        };
    }

    static async update(section: string, value: any): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.CONFIGURATION_SECTION);
        await config.update(section, value, vscode.ConfigurationTarget.Global);
    }

    static onDidChange(listener: () => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(this.CONFIGURATION_SECTION)) {
                listener();
            }
        });
    }
}