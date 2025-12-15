# Agent-PO-Bot（v4.1）LLM Worker 運行指南

本文件是針對「Orchestrator + VS Code Extension Worker」的端到端運行說明，內容以目前程式碼庫狀態（v4.1）為準。

若要理解架構設計與模組責任，請搭配閱讀：`ARCHITECTURE.md`。

---

## 1. 系統概述

系統由兩個核心元件組成：

1. **Orchestrator（Server）**
   - 提供 API：攝入事件、租賃票據（lease）、回填結果（fill）、提供監控（metrics）。
   - 在 TRIAGE 完成且決策為 APPROVE 時，自動提升到 REPLY 階段，並可透過 NotebookLM MCP 取得外部 context。
2. **VS Code Extension（Worker）**
   - 週期性向 Orchestrator 租賃票據。
   - 使用 VS Code Chat API（例如 Copilot）在本機執行 TRIAGE/REPLY 推論。
   - 回填結果到 Orchestrator 的 `/v1/tickets/:id/fill`。

本版本的主流程是「TRIAGE →（必要時）REPLY」，而非單純的 Q&A 問答系統。

---

## 2. 快速啟動

### 2.1 啟動 Orchestrator

```bash
cd orchestrator
npm install
npm run start
```

健康檢查：

```bash
curl -s http://127.0.0.1:3000/health
```

目前回應格式為（示意）：

```json
{ "status": "ok", "version": "v3-final" }
```

### 2.2 編譯 VS Code Extension（會自動複製 YAML）

```bash
cd vscode-extension
npm install
npm run compile
```

說明：
- `npm run compile` 會先執行 `copy-prompts`，把 `src/prompts/*.yaml` 複製到 `out/prompts` 與 `out/src/prompts`，以符合執行期的路徑解析。

### 2.3 啟動 Extension（F5）

1. 在 VS Code 開啟本 repo。
2. 進入 Run and Debug。
3. 按 `F5` 啟動 Extension Host。
4. Extension 啟動後會自動開始輪詢票據並處理（activation event: `onStartupFinished`）。

---

## 3. 基本操作：送入資料、觀測結果

### 3.1 送入單筆事件（/events）

你可以直接用 API 把一段文本送進系統，形成 TRIAGE 票據：

```bash
curl -s http://127.0.0.1:3000/events \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "triage_candidate",
    "event_id": "manual-1",
    "thread_id": "thread-manual-1",
    "content": "請針對這段貼文做 triage：……",
    "actor": "manual",
    "timestamp": "2025-12-15T00:00:00Z",
    "features": { "engagement": { "likes": 100, "comments": 50 } }
  }'
```

Orchestrator 會回傳：

```json
{ "status": "queued", "ticket_id": "..." }
```

注意：Orchestrator 內建 TriageFilter，會根據內容長度與互動數（likes/comments）決定是否跳過。

### 3.2 批次攝入（推薦使用 ingest script）

Orchestrator 內建 `ingest/run_ingest.js`，會把來源資料映射成 CandidateLite 並批次送入 `/v1/triage/batch`：

```bash
cd orchestrator

# 以 sample 檔案導入
npm run ingest:sample

# 以自訂檔案導入
FILE=ingest/sample_posts.json npm run ingest:file
```

---

## 4. 監控與驗證

### 4.1 看整體處理進度（/metrics）

```bash
curl -s http://127.0.0.1:3000/metrics | jq
```

此端點會回傳票據總數、pending/completed/failed、success rate，以及 reply 的專項統計。

### 4.2 列出票據（/v1/tickets）

```bash
curl -s 'http://127.0.0.1:3000/v1/tickets?limit=50' | jq
```

重要欄位：
- `status`: `pending` / `leased` / `completed`
- `metadata.final_outputs`: Worker 回填的結構化結果
  - TRIAGE：包含 `decision`, `target_prompt_id`, `reply_strategy`, `information_needs` 等
  - REPLY：包含 `reply`, `used_strategy`, `process_trace` 等

如果你要找單一 ticket，可用 `jq` 篩選（示意）：

```bash
TID='你的 ticket_id'
curl -s 'http://127.0.0.1:3000/v1/tickets?limit=500' \
  | jq --arg TID "$TID" '.[] | select(.id==$TID)'
```

### 4.3 審計輸出（logs/*.jsonl）

Orchestrator 會在回填時（fill）寫審計檔：
- `orchestrator/logs/triage_decisions.jsonl`
- `orchestrator/logs/reply_results.jsonl`

---

## 5. VS Code Extension 自我測試（目前狀態說明）

Extension 提供命令：`PO Bot: Self-test`（命令 ID：`agent-po-bot.selfTest`）。

目前 self-test 會：
1. 送出一筆 `diagnostic_qa` 事件到 `/events`。
2. 嘗試輪詢 `/ticket/{ticket_id}` 取得結果並驗證答案。

但請注意：以目前 Orchestrator 程式碼狀態，**尚未提供 `/ticket/:id` 這個查詢端點**，因此 self-test 可能無法完成輪詢驗證。

建議改用本文件「4.2 列出票據」的方法，以 `/v1/tickets` + `jq` 查詢 `metadata.final_outputs` 來確認 Worker 是否成功回填。

---

## 6. 常見故障排除

### 6.1 `prompts directory not found`

症狀：Extension log 出現 PromptBuilder 找不到 prompts 目錄。

處理：
1. 重新編譯：
   ```bash
   cd vscode-extension
   npm run compile
   ```
2. 確認下列任一目錄存在 YAML：
   - `vscode-extension/out/src/prompts`
   - `vscode-extension/out/prompts`
3. 若你有自訂路徑，可設定環境變數 `POB_PROMPTS_DIR` 指向 prompts 目錄。

### 6.2 VS Code 無可用聊天模型（No chat models available）

症狀：Extension log 顯示找不到任何 chat models。

處理：
- 確認已啟用/登入可用的 Chat 模型提供者（例如 Copilot）。
- 檢查設定 `agent-alike-po-bot.model.preferred` 是否對應到可用的 model id/name/family。

### 6.3 Orchestrator 有票但 Worker 不領

檢查點：
- Worker 只會 lease `metadata.kind` 符合的票（`TRIAGE` / `REPLY`）。
- 你可以用 `/v1/tickets?status=pending`（若有支援）或 `/v1/tickets?limit=...` 檢查 pending 票據是否帶有正確的 `metadata.kind`。
