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
exports.PromptSpecLoader = void 0;
// vscode-extension/src/services/promptSpecLoader.ts
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const YAML = __importStar(require("yaml"));
class PromptSpecLoader {
    constructor(opts) {
        this.opts = opts;
        this.replyCache = null;
        this.triageCache = null;
    }
    // ---------- Public API ----------
    getReplySpec(promptId) {
        this.ensureLoaded('reply');
        if (!this.replyCache)
            return null;
        const id = promptId && this.replyCache.byId.has(promptId)
            ? promptId
            : this.replyCache.defaultId;
        return id ? this.replyCache.byId.get(id) || null : null;
    }
    getTriageSpec(promptId) {
        this.ensureLoaded('triage');
        if (!this.triageCache)
            return null;
        const id = promptId && this.triageCache.byId.has(promptId)
            ? promptId
            : this.triageCache.defaultId;
        return id ? this.triageCache.byId.get(id) || null : null;
    }
    listReplyIds() {
        this.ensureLoaded('reply');
        return this.replyCache ? Array.from(this.replyCache.byId.keys()) : [];
    }
    listTriageIds() {
        this.ensureLoaded('triage');
        return this.triageCache ? Array.from(this.triageCache.byId.keys()) : [];
    }
    // ---------- Internal ----------
    ensureLoaded(kind) {
        const wantHot = !!this.opts.hotReload;
        const filePath = kind === 'reply' ? this.opts.replyPath : this.opts.triagePath;
        if (!filePath) {
            throw new Error(`[promptSpecLoader] missing ${kind}Path`);
        }
        if (!fs.existsSync(filePath)) {
            throw new Error(`[promptSpecLoader] ${kind} file not found: ${filePath}`);
        }
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        if (kind === 'reply') {
            if (!this.replyCache || (wantHot && this.replyCache.mtimeMs !== mtimeMs)) {
                this.replyCache = this.loadFile(filePath);
            }
        }
        else {
            if (!this.triageCache || (wantHot && this.triageCache.mtimeMs !== mtimeMs)) {
                this.triageCache = this.loadFile(filePath);
            }
        }
    }
    loadFile(filePath) {
        const raw = fs.readFileSync(filePath, 'utf8');
        let parsed;
        try {
            parsed = YAML.parse(raw);
        }
        catch (e) {
            throw new Error(`[promptSpecLoader] YAML parse error @ ${filePath}: ${e?.message || e}`);
        }
        /**
         * 支援三種形態：
         * 1) 單一規格（頂層含 prompt_id）
         * 2) 陣列規格（頂層為 specs/prompts 陣列或直接陣列）
         * 3) 容錯：若頂層是物件且具有 prompt_id，就當作單一 spec
         */
        let specs = [];
        if (Array.isArray(parsed)) {
            specs = parsed;
        }
        else if (parsed && Array.isArray(parsed.prompts)) {
            specs = parsed.prompts;
        }
        else if (parsed && Array.isArray(parsed.specs)) {
            specs = parsed.specs;
        }
        else if (parsed && parsed.prompt_id) {
            specs = [parsed];
        }
        else {
            throw new Error(`[promptSpecLoader] No prompt specs found in ${path.basename(filePath)}`);
        }
        const byId = new Map();
        let firstId = null;
        for (const item of specs) {
            if (!item || typeof item !== 'object')
                continue;
            if (!item.prompt_id || typeof item.prompt_id !== 'string') {
                throw new Error(`[promptSpecLoader] spec missing prompt_id in ${path.basename(filePath)}`);
            }
            const id = item.prompt_id;
            if (!firstId)
                firstId = id;
            byId.set(id, item);
        }
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        return { path: filePath, mtimeMs, byId, defaultId: firstId };
    }
}
exports.PromptSpecLoader = PromptSpecLoader;
//# sourceMappingURL=promptSpecLoader.js.map