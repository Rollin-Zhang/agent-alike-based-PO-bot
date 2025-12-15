# Agent-PO-Bot VS Code Extension — Architecture (v4.1)

> 本文件聚焦在 VS Code Extension（`vscode-extension/`）作為分散式系統中的「運算節點（Worker）」之設計、模組責任與資料流。

---

## 1. 專案全景 (System Overview)

### 1.1 系統定位：分散式 Worker

Agent-PO-Bot Extension 在整體架構中扮演「分散式運算節點（Worker）」：

- **上游 Orchestrator（Server）**：負責票據（Tickets）的建立、派發/租賃（Lease）、狀態管理、回填（Fill）、以及必要時的退回（NACK）。
- **下游 VS Code Extension（本專案）**：在本機 VS Code 中啟動後，週期性向 Orchestrator 租賃票據，並使用 **VS Code Copilot / Built-in Chat Models 的 LLM 算力**進行 Triage/Reply 推論，最後將結果回填到 Orchestrator。

此設計讓「運算能力」可以水平擴充：多個開發者的 VS Code（或多個機器）都可以同時作為 Worker 加入處理隊列。

### 1.2 票據種類與目標

- **TRIAGE**：判斷是否值得回覆（APPROVE / SKIP），並產生「回覆戰術路由」（`target_prompt_id`）與「資訊需求」（`information_needs`）。
- **REPLY**：根據 Orchestrator 給的 `reply_input`（包含 triage 戰略與外部 context）生成最終回覆文字（繁體中文），並經過 reviewer 迴圈做品質/安全檢查。

---

## 2. 核心設計哲學 (Core Design Philosophy)

### 2.1 Control/Data Separation (v4.0)：控制面與資料面分離

本專案的關鍵架構是 **控制面（Control Plane）** 與 **資料面（Data Plane）** 的嚴格分離：

- **控制面 (Control Plane / TypeScript)**
  - 由程式碼（核心是 PromptBuilder）**強制定義 Prompt 的結構容器（Structure Container）**，例如：
    - `### TARGET CONTENT ...`（目標內容容器）
    - `### SYSTEM INSTRUCTION / OUTPUT FORMAT`（輸出要求容器）
    - `### KNOWLEDGE BASE / CONTEXT`（外部脈絡容器）
  - 目的：
    - 確保資料流穩定（同一種 flow 的 prompt 具有固定骨架）
    - 在結構層面防止 Prompt Injection（即使票據內容包含「請忽略前述指令」之類字串，也只能落在 `TARGET CONTENT` 區塊中，被模型視為「待分析資料」，而非可改寫系統指令的控制訊號）

- **資料面 (Data Plane / YAML)**
  - 由 `vscode-extension/src/prompts/*.yaml` 定義：
    - LLM 人設與語氣（`sections.system`, `sections.assistant_style`）
    - 決策邏輯（triage 的決策標準、策略選擇）
    - 輸出 Schema（`outputs.schema`, `outputs.reviewer_schema`）
  - YAML 是「單一真理來源（SSOT）」：同一份 YAML 的 schema 同時作為 prompt 指示與 runtime 驗證依據。

### 2.2 原則：程式碼搬運與組裝，YAML 思考與邏輯

- **程式碼負責「搬運與組裝」**
  - 從 Ticket 萃取內容、策略、context
  - 套入硬編碼的容器結構
  - 執行 LLM 呼叫
  - 依 schema 驗證與回填

- **YAML 負責「思考與邏輯」**
  - 定義 triage 如何判斷 APPROVE/SKIP
  - 定義允許的 `target_prompt_id`（Enum）以防止 ID 幻覺
  - 定義 reply writer/reviewer 的人設與檢核維度

- **嚴格介面與 Enum 約束**
  - Triage 的 YAML schema 以 `enum: [reply.standard, reply.debunk, reply.empathy]` 限定策略 ID。
  - Worker 端在 runtime 進行 schema 驗證（缺欄位、enum 不符合會視為失敗並重試），將「模型幻覺」轉成「可觀測且可恢復的系統錯誤」。

---

## 3. 關鍵模組詳解 (Key Modules)

> 本節依據實作行為描述模組機制。

### 3.1 TicketWorker (vscode-extension/src/ticketWorker.ts)

#### 3.1.1 職責

- 週期性向 Orchestrator 取得票據（Lease）並在本機併發處理。
- 依票據種類（TRIAGE / REPLY）分流，執行不同的 prompt pipeline。
- 在錯誤時決定：重試退回（NACK）或永久失敗（FAIL）。

#### 3.1.2 X-RAY 診斷系統（TRIAGE Flow）

TRIAGE 流程內建兩段「X-RAY」可觀測性檢查，用於定位資料在哪個環節被截斷或污染：

- **X-Ray 1：輸入檢查（Worker Input Data）**
  - 直接檢查 `ticket.event.content` 是否完整存在。
  - 若 `event_content_full` 缺失，通常代表 Orchestrator 回傳格式或 ApiClient mapping 有問題。

- **X-Ray 2：輸出檢查（Builder Output Check）**
  - 檢查 prompt 是否包含 `TARGET CONTENT` 段落與內容是否成功注入。
  - 若 Worker 有內容但 prompt 未包含內容，通常代表 PromptBuilder 組裝或 YAML/變數命名不一致。

此 X-RAY 設計的價值是：把「LLM 回答怪」的問題，拆成可定位的工程問題（Input/Builder/Schema/Model）而不是主觀猜測。

#### 3.1.3 Triage / Reply 的分流處理機制

Worker 會用兩層邏輯判斷票據種類：

1. **強制指定（優先）**：`ticket.metadata.kind`（lease 時由 Worker 標記）
2. **推斷（備援）**：若未標記，則從 `flow_id` 或 `event.type` 字串包含 `triage` / `reply` 來推斷。

分流後：

- TRIAGE：生成 JSON 輸出並以 schema 驗證 → `fillTicketV1(outputs)`
- REPLY：writer 生成 → hard guardrails 檢查 → reviewer JSON schema 檢查 → 迴圈重寫（最多重試）→ `fillTicketV1(outputs.reply, process_trace)`

---

### 3.2 PromptBuilder (vscode-extension/src/promptBuilder.ts)

#### 3.2.1 強力路徑搜尋 (Robust Path Resolution)

PromptBuilder 必須在兩種執行型態都能找到 YAML：

- 開發時：TypeScript 原始碼在 `src/`
- 發佈/執行時：編譯後在 `out/`，`__dirname` 指向 `out/`

因此 `resolvePromptsDir()` 採取「多候選路徑搜尋」：

- 先看環境變數覆寫：`POB_PROMPTS_DIR`
- 否則依序嘗試：
  - `out/prompts`
  - `out/src/prompts`（專門解決 out/ 與 src/ 路徑錯位）
  - 以及上一層/上兩層的 `prompts` / `src/prompts`

找不到時會丟出包含 `CurrentDir` 與 `Searched` 清單的錯誤，便於排除「prompts directory not found」。

#### 3.2.2 Hardcoded Template：用固定容器組裝 YAML 與 Ticket 資料

PromptBuilder 的關鍵是「硬編碼容器」：

- **TRIAGE prompt**
  - 取 `ticket.event.content` 作為目標內容
  - 注入 YAML 的 `sections.system`
  - 在 prompt 中固定建立：
    - `### TARGET CONTENT (Candidate for Analysis):` + triple-quoted content
    - `### SYSTEM INSTRUCTION:` + JSON Schema（`outputs.schema`）

- **REPLY prompt**
  - 取 `ticket.metadata.reply_input`（策略、context）與貼文 snippet
  - 注入 YAML 的 `sections.system + sections.assistant_style`
  - 固定建立：
    - `### CURRENT STRATEGY:`
    - `### KNOWLEDGE BASE / CONTEXT:`
    - `### TARGET CONTENT (Reply to this):`
    - `### INSTRUCTION:`（限定繁中、只輸出回覆本文）

- **Reviewer prompt**
  - 讀取 YAML 的 `sections.reviewer_system` 與 `outputs.reviewer_schema`
  - 把「生成規範」當成 Requirements，要求 reviewer 以 JSON 回報 PASS/RETRY/FAIL。

此做法的架構效果是：
- YAML 可以演進（人設、規則、schema）
- 但 prompt 的資料容器固定，降低 prompt injection 與資料漏失機率。

---

### 3.3 ApiClient (vscode-extension/src/apiClient.ts)

#### 3.3.1 NACK 機制的版本降級 (Fallback)

本專案同時面對不同版本的 Orchestrator 路由差異，因此採取「版本降級」策略：

- **Lease（取得票據）**
  - 優先使用新版：`POST /v1/tickets/lease`
  - 若關閉或不相容則回退舊版：`POST /tickets/lease`

- **NACK（退回票據）**
  - v1 的 `nackTicketV1()` 會刻意改打 legacy 路徑：`POST /tickets/{id}/nack`（並帶 `lease_id`）
  - 避免某些後端環境沒有 `/v1/.../nack` 路由導致 404。

這種降級策略讓 Worker 對後端版本更具韌性：即使 Orchestrator 部署版本不一致，也能保持基本工作能力。

#### 3.3.2 強力內容搜索 (Robust Content Search)

為避免 Orchestrator 回傳欄位名稱變動造成「內容為空」導致模型幻覺，ApiClient 在 `mapLeasedTicket()` 中用固定優先序搜尋內容來源：

1. `raw.inputs.candidate_snippet`
2. `raw.inputs.snippet`
3. `raw.event.content`
4. `raw.content`

找不到時會記錄 warning，並提醒「LLM 可能 hallucinate」。

---

## 4. 資料流與版本狀態 (Data Flow & Status)

### 4.1 目前版本：v4.1

- TRIAGE YAML：`prompt_id: triage.zh-Hant@v4.1`
- 主要改進聚焦在：
  - **雜訊過濾**：忽略爬蟲尾端 UI 文字（例如「翻譯」、「查看更多」等）
  - **ID 幻覺防禦**：以 YAML schema enum + Worker runtime 驗證，強制 `target_prompt_id` 只能是既定集合

### 4.2 Triage 流程狀態

- 已具備：
  - X-RAY 1/2 的可觀測性診斷
  - schema 驗證（缺欄位或 enum 不符 → 視為可重試失敗）

### 4.3 Reply 流程狀態

- 已具備：
  - 回覆生成（繁中）
  - hard guardrails（長度、空字串、禁止 token）
  - reviewer 迴圈（PASS/RETRY/FAIL）與 `process_trace` 可追蹤

- 現階段限制：
  - 外部 Context 仍可能為空（Worker 會在沒有 `context_notes` 時提示警告）
  - 待整合：NotebookLM（或其他 MCP）讓 Orchestrator 能提供更完整的 `reply_input.context_notes`

### 4.4 基礎設施：`npm run compile` 與 prompts 搬運

- 目的：讓編譯後的 `out/` 仍能讀到 YAML。
- 本專案在 `npm run compile` 中包含 `copy-prompts` 步驟，將 `vscode-extension/src/prompts/*.yaml` 複製到：
  - `vscode-extension/out/prompts/`
  - `vscode-extension/out/src/prompts/`

搭配 PromptBuilder 的 Robust Path Resolution，能最大化避免「prompts directory not found」。

---

## 附錄：常用排障清單

- 問題：`[PromptBuilder] ❌ Critical: 'prompts' directory not found`
  - 確認：`vscode-extension/out/src/prompts` 或 `vscode-extension/out/prompts` 是否存在 YAML。
  - 重新執行：`cd vscode-extension && npm run compile`
  - 或設定：`POB_PROMPTS_DIR=/absolute/path/to/prompts`
