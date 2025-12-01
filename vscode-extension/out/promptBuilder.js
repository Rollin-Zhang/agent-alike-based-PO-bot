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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptBuilder = exports.UnsupportedTicketKindError = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml_1 = __importDefault(require("yaml"));
const cache = {
    reply: null,
    triage: null,
};
/* ───────────────────────────── Prompts 檔案載入 ───────────────────────────── */
function resolvePromptsDir() {
    const override = process.env.POB_PROMPTS_DIR;
    if (override)
        return override;
    const root = path.resolve(__dirname, '..'); // 打包後 out/ → 專案根
    return path.join(root, 'src', 'prompts');
}
function getSpecFile(kind) {
    const dir = resolvePromptsDir();
    return path.join(dir, kind === 'reply' ? 'reply.yaml' : 'triage.yaml');
}
function readYamlFileStrict(filePath) {
    if (!fs.existsSync(filePath))
        throw new Error(`[promptBuilder] spec file not found: ${filePath}`);
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
        return yaml_1.default.parse(raw);
    }
    catch (e) {
        throw new Error(`[promptBuilder] YAML parse error @ ${filePath}: ${e?.message || e}`);
    }
}
function isCacheFresh(c, file, mtime) {
    return !!c && c.file === file && c.mtime === mtime;
}
function normalizeSpecs(parsed, file) {
    let specs = [];
    if (Array.isArray(parsed))
        specs = parsed;
    else if (parsed?.prompts && Array.isArray(parsed.prompts))
        specs = parsed.prompts;
    else if (parsed?.prompt_id)
        specs = [parsed];
    else
        throw new Error(`[promptBuilder] No valid prompt spec in ${file}`);
    return specs.map((s) => {
        if (!s || typeof s !== 'object' || typeof s.prompt_id !== 'string') {
            throw new Error(`[promptBuilder] spec missing prompt_id in ${file}`);
        }
        return s;
    });
}
function buildCacheEntry(file, mtime, specs) {
    const byId = new Map();
    let first = null;
    for (const s of specs) {
        if (!first)
            first = s.prompt_id;
        byId.set(s.prompt_id, s);
    }
    return { file, mtime, byId, defaultId: first };
}
function loadSpec(kind) {
    const file = getSpecFile(kind);
    const mtime = fs.statSync(file).mtimeMs;
    const c = cache[kind];
    if (isCacheFresh(c, file, mtime))
        return c;
    const parsed = readYamlFileStrict(file);
    const specs = normalizeSpecs(parsed, file);
    const entry = buildCacheEntry(file, mtime, specs);
    cache[kind] = entry;
    return entry;
}
function pickSpec(kind, preferredId) {
    const entry = loadSpec(kind);
    const id = preferredId && entry.byId.has(preferredId) ? preferredId : entry.defaultId;
    if (!id)
        throw new Error(`[promptBuilder] No ${kind} prompt_id resolvable`);
    return entry.byId.get(id);
}
/* ─────────────────────────────── 共用小工具 ─────────────────────────────── */
function clampMaxChars(n, fallback) {
    const x = Number(n);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : fallback;
}
function smartTrim(text, maxChars) {
    const s = (text ?? '').toString();
    if (s.length <= maxChars)
        return s;
    const target = maxChars - 3;
    const end1 = ['。', '？', '！', '：'];
    for (let i = target; i >= Math.floor(target * 0.8); i--) {
        if (end1.includes(s[i]))
            return s.slice(0, i + 1);
    }
    const end2 = ['，', '；', '、'];
    for (let i = target; i >= Math.floor(target * 0.9); i--) {
        if (end2.includes(s[i]))
            return s.slice(0, i + 1) + '...';
    }
    return s.slice(0, target) + '...';
}
function looksLikeMetaAck(reply) {
    if (typeof reply !== 'string')
        return false;
    const s = reply.trim();
    if (!s)
        return false;
    const bad = [
        '已收到你的角色',
        '已收到你的立場',
        '我會以',
        '請告訴我你想要的任務',
        '請提供具體任務',
        '我將以',
        '我會採取',
    ];
    return bad.some(k => s.includes(k));
}
function isZhHantLike(s) {
    // 極簡檢查：含 CJK 即通過；再用少量常見簡體字作為負面訊號
    const hasCjk = /[\u4e00-\u9fff]/.test(s);
    const simplified = /[务国体东华间后发这战]/; // 粗略範例
    return hasCjk && !simplified.test(s);
}
/* ─────────────────────────────── 主類（文本 Only） ─────────────────────────────── */
class UnsupportedTicketKindError extends Error {
    constructor(message = 'Unsupported ticket kind', ticketSummary) {
        super(message);
        this.code = 'UNSUPPORTED_TICKET_KIND';
        this.name = 'UnsupportedTicketKindError';
        this.ticketSummary = ticketSummary;
    }
}
exports.UnsupportedTicketKindError = UnsupportedTicketKindError;
class PromptBuilder {
    /** 僅支援 REPLY / TRIAGE，其他直接丟錯（由上游標記失敗） */
    static buildPrompt(ticket) {
        if (isReplyTicket(ticket))
            return this.buildReplyPrompt(ticket);
        if (isTriageTicket(ticket))
            return this.buildTriagePrompt(ticket);
        throw new UnsupportedTicketKindError(`Unsupported ticket kind (flow_id=${ticket.flow_id}, event=${ticket.event?.type})`, `${ticket.type}/${ticket.flow_id}/${ticket.event?.type}`);
    }
    /** REPLY：三層分離（SYSTEM / CONTENT / CONTEXT），只輸出純文本 */
    static buildReplyPrompt(ticket) {
        // 從 YAML 取 system/assistant_style，但輸出層級由此檔統一產生
        const preferId = process.env.ORCH_REPLY_PROMPT_ID || undefined;
        const spec = pickSpec('reply', preferId);
        const lang = (spec.constraints?.language || ticket?.constraints?.lang || 'zh-Hant').toString();
        const maxChars = clampMaxChars((spec.constraints?.max_chars ?? ticket?.constraints?.max_chars), PromptBuilder.DEFAULT_MAX_CHARS);
        const meta = ticket?.metadata ?? {};
        const ri = (meta?.reply_input ?? {});
        const triage = (meta?.triage_result ?? {});
        const stanceSummary = (ri?.stance_summary ?? triage?.short_reason ?? '').toString().trim();
        const candidateSnippet = (ri?.candidate_snippet ?? ticket?.event?.content ?? '').toString().trim();
        const contextNotes = (ri?.context_notes ?? '').toString().trim();
        const replyObjectives = Array.isArray(ri?.reply_objectives)
            ? ri.reply_objectives.filter((x) => typeof x === 'string' && x.trim().length > 0).map(x => x.trim())
            : [];
        // SYSTEM：角色/語氣（採用 YAML 的 system 與 assistant_style 內容）、嚴格輸出規則
        const sysParts = [];
        if (spec.sections?.system)
            sysParts.push(spec.sections.system.trim());
        if (spec.sections?.assistant_style)
            sysParts.push(spec.sections.assistant_style.trim());
        const guard = [
            `語言：${lang}；長度 ≤ ${maxChars} 字。`,
            '只輸出「純文本」回覆，不得輸出 JSON、Markdown、程式碼圍欄、前後綴或說明語。',
            '禁止回覆任何角色/立場確認或任務請求（meta-ack），直接對應原文內容提供論證與回覆。',
            '不使用 emoji；攻擊論點，不攻擊人格；避免口號式語句；重視邏輯與制度性分析。',
            '資訊不足時，請用保守表述與可驗證的指涉，不要要求對方提供任務或再說明。',
        ].join('\n');
        const SYSTEM = ['[SYSTEM]', ...sysParts, guard].filter(Boolean).join('\n');
        // CONTENT：只放原文（最小充分訊息）
        const CONTENT = ['[CONTENT]', candidateSnippet || '（無原始內容）'].join('\n');
        // CONTEXT：僅在非空時加上，避免稀釋焦點
        const ctxLines = ['[CONTEXT]'];
        if (stanceSummary)
            ctxLines.push(`立場摘要：${stanceSummary}`);
        if (contextNotes)
            ctxLines.push(`補充資訊：${contextNotes}`);
        if (replyObjectives.length > 0) {
            ctxLines.push('回覆目標：');
            for (const obj of replyObjectives)
                ctxLines.push(`- ${obj}`);
        }
        const CONTEXT = ctxLines.length > 1 ? ctxLines.join('\n') : '';
        const TAIL = [
            '[OUTPUT]',
            '請直接輸出最終回覆的純文本（不得含任何額外符號或圍欄）。'
        ].join('\n');
        return [SYSTEM, CONTENT, CONTEXT, TAIL].filter(Boolean).join('\n\n');
    }
    /** TRIAGE：暫保 JSON 輸出（與現有 TicketProcessor.validateTriage 對齊） */
    static buildTriagePrompt(ticket) {
        const snippet = (ticket?.event?.content ?? '').toString().trim();
        return [
            '你是一個社群分流助手。請只輸出合法 JSON（不含註解/圍欄/多餘文字），結構如下：',
            '{',
            '  "decision": "APPROVE" | "SKIP" | "FLAG",',
            '  "confidence": number,',
            '  "reasons": string[],',
            '  "summary": string,',
            '  "signals": { "toxicity": number, "risk": string[] }',
            '}',
            '',
            '規則：',
            '1) 僅輸出 JSON（無任何額外文字）。',
            '2) summary 20~80字。',
            '3) reasons 控制在 3~5 點精煉標記。',
            '',
            '候選內容：',
            '"""',
            snippet,
            '"""'
        ].join('\n');
    }
    /* ──────────── 文本級驗證（REPLY用） ──────────── */
    static validateAndTrimResponse(response, maxChars) {
        return smartTrim(response, maxChars);
    }
    static validateResponse(response, constraints) {
        const errors = [];
        const text = (response ?? '').toString().trim();
        if (!text)
            errors.push('回覆不能為空');
        if (text.length > (constraints?.maxChars ?? PromptBuilder.DEFAULT_MAX_CHARS)) {
            errors.push(`回覆超過最大長度限制 ${(constraints?.maxChars ?? PromptBuilder.DEFAULT_MAX_CHARS)} 字`);
        }
        // 語言（粗略）：預設 zh-Hant
        const lang = (constraints?.lang || 'zh-Hant').toString().toLowerCase();
        if (lang === 'zh-hant' || lang === 'zh-tw' || lang === 'zh') {
            if (!isZhHantLike(text))
                errors.push('回覆應為繁體中文，且避免常見簡體字');
        }
        // 禁詞（可自行擴充）
        const taboo = ['保證', '絕對', '立即', '馬上完成', '免費', '特價', '限時', '個人資料', '帳號', '密碼'];
        for (const k of taboo)
            if (text.includes(k))
                errors.push(`回覆包含不建議使用的詞彙：${k}`);
        // 禁止 meta-ack
        if (looksLikeMetaAck(text))
            errors.push('回覆疑似包含角色/立場確認等 meta-ack');
        return { valid: errors.length === 0, errors };
    }
    static estimateTokens(prompt) {
        const s = (prompt ?? '').toString();
        const zh = (s.match(/[\u4e00-\u9fff]/g) || []).length;
        const en = (s.match(/[a-zA-Z]+/g) || []).length;
        const other = s.length - zh - en;
        return Math.ceil(zh * 1.5 + en * 1.3 + other * 0.5);
    }
}
exports.PromptBuilder = PromptBuilder;
PromptBuilder.DEFAULT_MAX_CHARS = 500;
/* ────────────────────────────── Gate helpers ────────────────────────────── */
function isReplyTicket(t) {
    if (t.type !== 'DraftTicket')
        return false;
    const evtType = t?.event?.type;
    return (t.flow_id === 'reply_zh_hant_v1' ||
        evtType === 'reply_request' ||
        evtType === 'reply_candidate');
}
function isTriageTicket(t) {
    if (t.type !== 'DraftTicket')
        return false;
    const evtType = t?.event?.type;
    return t.flow_id === 'triage_zh_hant_v1' || evtType === 'triage_candidate';
}
//# sourceMappingURL=promptBuilder.js.map