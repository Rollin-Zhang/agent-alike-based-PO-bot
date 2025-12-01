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
exports.Config = void 0;
const vscode = __importStar(require("vscode"));
class Config {
    static get() {
        const config = vscode.workspace.getConfiguration(this.CONFIGURATION_SECTION);
        return {
            orchestrator: {
                baseUrl: config.get('orchestrator.baseUrl', 'http://127.0.0.1:3000'),
                authToken: config.get('orchestrator.authToken')
            },
            worker: {
                pollIntervalMs: config.get('worker.pollIntervalMs', 5000),
                concurrency: config.get('worker.concurrency', 2),
                batchSize: config.get('worker.batchSize', 3),
                useV1Lease: config.get('worker.useV1Lease', true),
                kinds: config.get('worker.kinds', ['TRIAGE']),
                kindStrategy: config.get('worker.kindStrategy', 'triage_first'),
                kindWeights: config.get('worker.kindWeights', { TRIAGE: 7, REPLY: 3 })
            },
            send: {
                dryRun: config.get('send.dryRun', true)
            },
            model: {
                preferred: config.get('model.preferred', 'gpt-4')
            },
            logs: {
                level: config.get('logs.level', 'info')
            },
            reply: {
                maxChars: config.get('reply.maxChars', 320)
            }
        };
    }
    static async update(section, value) {
        const config = vscode.workspace.getConfiguration(this.CONFIGURATION_SECTION);
        await config.update(section, value, vscode.ConfigurationTarget.Global);
    }
    static onDidChange(listener) {
        return vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(this.CONFIGURATION_SECTION)) {
                listener();
            }
        });
    }
}
exports.Config = Config;
Config.CONFIGURATION_SECTION = 'agent-alike-po-bot';
//# sourceMappingURL=config.js.map