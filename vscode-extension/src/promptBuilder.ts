import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { Ticket } from './types';

// [Spec Definition]
export type LoadedSpec = {
  prompt_id: string;
  version?: number;
  sections?: { 
    system?: string; 
    assistant_style?: string;
    reviewer_system?: string; 
  };
  outputs?: { 
    schema?: any;          
    reviewer_schema?: any; 
  };
};

export class PromptBuilder {
  static readonly DEFAULT_MAX_CHARS = 800;

  /* ─────────────────────────────────────────────────────────────────────────────
     1. Infrastructure Layer: 路徑解析與檔案讀取 (Internal)
     ───────────────────────────────────────────────────────────────────────────── */
  
  private static resolvePromptsDir(): string {
    const override = process.env.POB_PROMPTS_DIR;
    if (override) return override;

    const currentDir = __dirname; 
    
    // [FIX] 強力搜尋策略：增加 'src/prompts' 路徑
    // 解決 out/ 目錄結構導致找不到 src/prompts 的問題
    const potentialPaths = [
        path.join(currentDir, 'prompts'),
        path.join(currentDir, 'src', 'prompts'),                // <--- 新增：針對 out/src/prompts 結構
        path.join(currentDir, '..', 'prompts'),
        path.join(currentDir, '..', 'src', 'prompts'),          // <--- 新增：針對上一層的 src/prompts
        path.join(currentDir, '..', '..', 'src', 'prompts'),
        path.join(currentDir, '..', '..', 'prompts')
    ];

    for (const p of potentialPaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    
    // 如果真的找不到，印出當前目錄與搜尋過的路徑，方便除錯
    throw new Error(`[PromptBuilder] ❌ Critical: 'prompts' directory not found.\nCurrentDir: ${currentDir}\nSearched: ${potentialPaths.join(', ')}`);
  }

  // [Fix] 將內部實作改名為 loadYamlSpec，避免與公開介面 getSpec 名稱衝突
  private static loadYamlSpec(kind: 'reply' | 'triage', promptId?: string): LoadedSpec {
    const dir = this.resolvePromptsDir();
    let fileName = kind === 'triage' ? 'triage.yaml' : 'reply.standard.yaml';

    if (kind === 'reply' && promptId && promptId.startsWith('reply.')) {
        const specific = path.join(dir, `${promptId}.yaml`);
        if (fs.existsSync(specific)) {
            fileName = `${promptId}.yaml`;
        } else {
            console.warn(`[PromptBuilder] Strategy '${promptId}' not found, falling back to reply.standard.yaml`);
        }
    }

    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) {
        throw new Error(`[PromptBuilder] Spec file not found: ${filePath}`);
    }
    
    try {
        return YAML.parse(fs.readFileSync(filePath, 'utf8')) as LoadedSpec;
    } catch (e: any) {
        throw new Error(`[PromptBuilder] YAML syntax error in ${filePath}: ${e.message}`);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────────
     2. Public Interface: 公開方法
     ───────────────────────────────────────────────────────────────────────────── */

  /**
   * 公開取得 Spec 物件 (包含 Schema)，供 TicketWorker 驗證輸出使用
   */
  static getSpec(kind: 'reply' | 'triage', promptId?: string): LoadedSpec {
      return this.loadYamlSpec(kind, promptId);
  }

  /* ─────────────────────────────────────────────────────────────────────────────
     3. Construction Layer: 資料流組裝 (The Pipeline)
     程式碼負責定義結構 (Structure)，YAML 負責定義邏輯 (Logic)。
     ───────────────────────────────────────────────────────────────────────────── */

  static buildTriagePrompt(ticket: Ticket): string {
    // [Step 1: Data Extraction] 
    const content = ticket.event?.content || (ticket as any).content || "";
    
    if (!content) {
        console.warn(`[PromptBuilder] ⚠️ Triage content is EMPTY for ticket ${ticket.id}`);
    }

    // [Step 2: Control Loading]
    const spec = this.loadYamlSpec('triage', (ticket.metadata as any)?.prompt_id);
    const systemPrompt = spec.sections?.system || '';

    // [Step 3: Structural Assembly]
    // 硬編碼容器結構，確保資料流穩定
    return `
${systemPrompt}

### TARGET CONTENT (Candidate for Analysis):
"""
${content}
"""

### SYSTEM INSTRUCTION:
Please strictly follow this JSON Schema for output:
${JSON.stringify(spec.outputs?.schema || {}, null, 2)}
`.trim();
  }

  static buildReplyPrompt(ticket: Ticket): string {
    const meta = ticket.metadata || {};
    const ri = meta.reply_input || {};
    const promptId = meta.prompt_id; 

    // [Step 1: Data Extraction]
    const content = ticket.event?.content || ri.snippet || ri.candidate_snippet || "";
    
    let contextData = "No specific context provided.";
    if (ri.context_notes) {
        contextData = typeof ri.context_notes === 'string' ? ri.context_notes : JSON.stringify(ri.context_notes);
    }

    // [Step 2: Control Loading]
    const spec = this.loadYamlSpec('reply', promptId);
    const systemPrompt = [spec.sections?.system, spec.sections?.assistant_style].filter(Boolean).join('\n\n');
    
    const dynamicStrategy = ri.strategy || "Standard engagement strategy.";

    // [Step 3: Structural Assembly]
    return `
${systemPrompt}

### CURRENT STRATEGY:
${dynamicStrategy}

### KNOWLEDGE BASE / CONTEXT:
${contextData}

### TARGET CONTENT (Reply to this):
"""
${content}
"""

### INSTRUCTION:
Write the reply directly in Traditional Chinese. Do not output anything else.
`.trim();
  }

  static buildReviewerPrompt(promptId: string | undefined, constraints: string, draft: string): string {
    const spec = this.loadYamlSpec('reply', promptId);
    const reviewerSystem = spec.sections?.reviewer_system || 'You are a QA Reviewer.';

    return `
${reviewerSystem}

### REQUIREMENTS:
${constraints}

### DRAFT TO REVIEW:
"""
${draft}
"""

### OUTPUT FORMAT:
${spec.outputs?.reviewer_schema ? JSON.stringify(spec.outputs.reviewer_schema, null, 2) : "JSON format."}
`.trim();
  }

  /* ─────────────────────────────────────────────────────────────────────────────
     4. Validation Helpers
     ───────────────────────────────────────────────────────────────────────────── */

  static validateReplyFormat(text: string, maxChars: number = 800): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const t = text.trim();
    
    if (!t) errors.push('Empty response');
    if (t.length > maxChars) errors.push(`Exceeds max length (${t.length} > ${maxChars})`);
    
    if (t.includes('[Object object]')) errors.push('Contains forbidden system token');
    
    return { valid: errors.length === 0, errors };
  }

  static validateAndTrimResponse(response: string, maxChars: number): string {
    let clean = response.trim();
    clean = clean.replace(/^```(json|text)?\s*/, '').replace(/\s*```$/, '');
    return clean.length > maxChars ? clean.slice(0, maxChars - 3) + '...' : clean;
  }
}