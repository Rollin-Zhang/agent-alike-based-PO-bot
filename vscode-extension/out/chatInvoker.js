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
exports.ChatInvoker = void 0;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
class ChatInvoker {
    constructor(logger) {
        this.logger = logger;
        this.preferredModel = config_1.Config.get().model.preferred;
        // 初始化時檢查模型可用性
        this.initializeModels();
        // 監聽配置變更
        config_1.Config.onDidChange(() => {
            this.preferredModel = config_1.Config.get().model.preferred;
        });
    }
    /**
     * 初始化並檢查可用模型
     */
    async initializeModels() {
        try {
            this.logger.info('🔍 Checking available chat models...');
            const models = await vscode.lm.selectChatModels();
            if (models.length === 0) {
                this.logger.error('❌ No chat models available. Enable VS Code Chat API and install a provider. Tip: set "agent-alike-po-bot.model.preferred" to an available id/name/family.');
                return;
            }
            const list = models.map(m => ({ id: m.id, vendor: m.vendor, family: m.family, version: m.version, name: m.name }));
            this.logger.info('✅ Available chat models:', { count: models.length, models: list, preferred: this.preferredModel });
            // 嘗試預先解析並打印將使用之模型
            try {
                const selected = await this.selectModelStrict();
                this.logger.info(`🤖 Using model: ${selected.name}`, { id: selected.id, vendor: selected.vendor, family: selected.family, version: selected.version });
            }
            catch (e) {
                this.logger.error('❌ Model selection failed', {
                    error: e instanceof Error ? e.message : String(e),
                    hint: 'Check "agent-alike-po-bot.model.preferred" or install/enable a chat model provider.'
                });
            }
            // 檢查首選模型是否可用
            if (this.preferredModel) {
                const preferredAvailable = models.some(m => m.id === this.preferredModel || m.name === this.preferredModel || m.family === this.preferredModel);
                if (!preferredAvailable) {
                    this.logger.warn(`⚠️ Preferred model '${this.preferredModel}' not available`);
                }
            }
        }
        catch (error) {
            this.logger.error('❌ Failed to check available models', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
    /**
     * 調用 VS Code 內建聊天模型
     */
    async invokeChatModel(prompt, options) {
        const startTime = Date.now();
        // 檢測 Host 環境
        const hostName = vscode.env.appName;
        const hostVersion = vscode.version;
        this.logger.info('LLM invocation started', {
            hostName,
            hostVersion,
            promptLength: prompt.length,
            preferredModel: this.preferredModel,
            maxTokens: options?.maxTokens,
            temperature: options?.temperature,
            timestamp: new Date().toISOString()
        });
        try {
            this.logger.debug('Invoking VS Code chat model', {
                promptLength: prompt.length,
                preferredModel: this.preferredModel,
                options
            });
            // 使用 VS Code Chat API
            const response = await this.callVSCodeChatAPI(prompt, options);
            const latencyMs = Date.now() - startTime;
            this.logger.info('LLM invocation completed', {
                latencyMs,
                responseLength: response.text.length,
                promptTokens: response.usage.promptTokens,
                completionTokens: response.usage.completionTokens,
                totalTokens: response.usage.promptTokens + response.usage.completionTokens,
                model: response.modelId || response.modelName,
                provider: response.provider || 'vscode.lm',
                hostName,
                success: true
            });
            // 簡潔摘要（便於人工掃描）
            this.logger.info('LLM summary', {
                model: response.modelId || response.modelName,
                provider: response.provider || 'vscode.lm',
                latency_ms: latencyMs,
                tokens: `${response.usage.promptTokens}+${response.usage.completionTokens}=${response.usage.promptTokens + response.usage.completionTokens}`,
                chars_in: prompt.length,
                chars_out: response.text.length
            });
            return response;
        }
        catch (error) {
            const latencyMs = Date.now() - startTime;
            this.logger.error('Chat model invocation failed', {
                latencyMs,
                error: error instanceof Error ? error.message : String(error)
            });
            // 分類錯誤
            const processingError = this.classifyModelError(error);
            throw processingError;
        }
    }
    /**
     * 調用 VS Code Chat API（實際實作）
     */
    async callVSCodeChatAPI(prompt, options) {
        const startTime = Date.now();
        try {
            // 選擇實際可用的 VS Code Chat 模型（不做任何模擬）
            const model = await this.selectModelStrict();
            this.logger.debug(`Using model (raw): ${model.name}`, {
                vendor: model.vendor,
                family: model.family,
                version: model.version,
                id: model.id
            });
            // 正規化後的模型識別（供後續一致使用）
            const normalized = this.normalizeModelMeta(model);
            this.logger.info('Normalized model meta', {
                provider: normalized.provider,
                modelId: normalized.modelId,
                rawName: model.name,
                rawId: model.id,
                family: model.family,
                version: model.version
            });
            // 建構聊天請求
            const messages = [
                vscode.LanguageModelChatMessage.User(prompt)
            ];
            // 設定請求選項
            const requestOptions = {
                justification: 'Generate response for customer support ticket'
            };
            // 發送請求
            const chatResponse = await model.sendRequest(messages, requestOptions);
            // 收集回應
            let responseText = '';
            for await (const fragment of chatResponse.text) {
                responseText += fragment;
            }
            const latencyMs = Date.now() - startTime;
            // 估算 token 使用量（VS Code API 可能不提供精確數據）
            const estimatedPromptTokens = this.estimateTokens(prompt);
            const estimatedCompletionTokens = this.estimateTokens(responseText);
            // 重用先前的 normalized 變數
            return {
                text: responseText.trim(),
                usage: {
                    promptTokens: estimatedPromptTokens,
                    completionTokens: estimatedCompletionTokens
                },
                latencyMs,
                modelName: model.name,
                provider: normalized.provider,
                modelId: normalized.modelId
            };
        }
        catch (error) {
            this.logger.error('VS Code Chat API invocation failed (strict mode, no fallback)', {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
    // 移除所有模擬邏輯：不提供 fallback，確保只用真模型
    /**
     * 估算 token 數量
     */
    estimateTokens(text) {
        // 簡化的 token 估算
        const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
        const otherChars = text.length - chineseChars - englishWords;
        return Math.ceil(chineseChars * 1.5 + englishWords * 1.3 + otherChars * 0.5);
    }
    /**
     * 正規化模型中繼資料，抽取 provider 與可辨識的 modelId
     */
    normalizeModelMeta(model) {
        const provider = 'vscode.lm';
        const candidates = [];
        ['id', 'modelId', 'family', 'name'].forEach(k => { if (model && model[k])
            candidates.push(String(model[k])); });
        // 偵測 gpt-4o / gpt4o 家族；否則用第一個
        const preferred = candidates.find(c => /gpt[-_]?4o/i.test(c)) || candidates[0] || 'unknown-model';
        return { provider, modelId: preferred, display: preferred };
    }
    /**
     * 分類模型錯誤
     */
    classifyModelError(error) {
        if (error instanceof Error) {
            const message = error.message.toLowerCase();
            if (message.includes('timeout') || message.includes('timed out')) {
                return { type: 'timeout', message: 'Model request timeout', retryable: true };
            }
            if (message.includes('rate limit') || message.includes('too many requests')) {
                return { type: 'rate_limit', message: 'Model rate limit exceeded', retryable: true };
            }
            if (message.includes('not available') || message.includes('unauthorized')) {
                return { type: 'validation', message: 'Chat model not available or unauthorized', retryable: false };
            }
            return { type: 'model', message: error.message, retryable: true };
        }
        return { type: 'unknown', message: 'Unknown model error', retryable: true };
    }
    // （已簡化）checkModelAvailability 已移除，如需再加可採用更小型介面
    /**
     * 嚴格選擇可用模型：
     * 1) 嘗試以 preferred 比對 family/name/id
     * 2) 找不到則回退到第一個可用模型（仍是真實模型）
     */
    async selectModelStrict() {
        const preferred = this.preferredModel?.trim();
        if (preferred) {
            try {
                const byFamily = await vscode.lm.selectChatModels({ family: preferred });
                if (byFamily.length > 0)
                    return byFamily[0];
            }
            catch { }
            try {
                const all = await vscode.lm.selectChatModels();
                const matched = all.find(m => m.id === preferred || m.name === preferred || m.family === preferred);
                if (matched)
                    return matched;
            }
            catch { }
        }
        const all = await vscode.lm.selectChatModels();
        if (all.length === 0) {
            throw new Error('No VS Code chat models available. Ensure VS Code Chat API is enabled and models are installed.');
        }
        return all[0];
    }
}
exports.ChatInvoker = ChatInvoker;
//# sourceMappingURL=chatInvoker.js.map