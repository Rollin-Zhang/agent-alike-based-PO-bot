# M2-A ↔ M2-B 整合備忘

**Date**: 2026-01-04 (Updated)  
**Scope**: M2-A (readiness/evidence/schemaGate) 與 M2-B (TOOL runner/executor/derivation) 的介面契約與執行路徑決策。

---

## 0) 執行路徑決策（Execution Path Decision）

**Decision**: Z 路線（in-process ToolExecutionService）為當前預設；Y 路線（HTTP `/v1/tools/execute`）保留為未來可選升級路徑。

### 當前預設路徑（Phase M2）: In-Process

- **架構**: M2-B RunnerCore 透過 `InProcessToolsGatewayAdapter` 直接呼叫 `ToolExecutionService`（同進程、同記憶體）。
- **優勢**:
  - 無 HTTP 序列化/transport overhead
  - 共享治理邏輯（readiness gating, schemaGate, audit, allowlist）
  - 單一 process 觀測（log/metrics 集中）
  - 無需啟動 HTTP server 即可執行工具
- **適用場景**: 當前系統（worker 數量有限、TicketStore in-memory、不需要跨機器）

### 未來升級路徑（可選）: HTTP

- **架構**: 透過 `HttpToolsExecuteGatewayAdapter` 呼叫 `/v1/tools/execute` HTTP API
- **升級觸發條件** (任一成立即可考慮升級):
  1. 多機器水平擴展需求（orchestrator 與 tool runner 分離部署）
  2. 工具執行隔離需求（runtime isolation、resource limits per tool）
  3. 跨語言 runtime 需求（非 Node.js worker）
  4. 集中節流/熔斷/觀測需求（HTTP layer rate-limiting/circuit-breaking）
  5. 跨進程 TicketStore 持久化需求（目前不支援）
  6. 工具執行服務獨立測試/部署/升級需求
- **升級方式**: 只需替換 adapter 實例，不改 RunnerCore 核心與合約測試

**架構不變性保證**: 無論哪種路徑，M2-A 治理能力（readiness, schemaGate, audit, allowlist）與 M2-B 合約（SSOT codes, RunReport shape）必須保持一致。

---

## 1) 共同環境旗標（Env）

- `NO_MCP=true`
  - M2-A：readiness 會呈現 unavailable；部分路由會被 `requireDeps` 擋下。
  - M2-B：B-script 用 stub gateway 跑出 deterministic 結果（不依賴 MCP）。

- `SCHEMA_GATE_MODE=off|warn|strict`
  - M2-A：作為 ingress/internal gate 策略與 audit/metrics 的來源。
  - M2-B：TOOL→REPLY 派生流程需遵守 schemaGate internal strict reject 的語意：**return ok=false、不 throw、不污染 parent**。

- `ENABLE_REPLY_DERIVATION=true`
  - M2-B：開啟 TOOL→REPLY 派生（透過 `maybeDeriveReplyFromToolOnFill` 單一入口）。

---

## 2) Tool steps 資料來源（SSOT）

Stage 2 TOOL runner 讀取 steps 的順序：

1. `ticket.metadata.tool_input.tool_steps`（新路徑，schema SSOT）
2. `ticket.tool_steps`（legacy）
3. `[]`

並在 bridge 時統一 normalize 成 canonical 形狀：
- `{ tool_name, args }`

實作位置：
- `orchestrator/lib/tool_runner/b_script_bridge.js`

---

## 3) Tool 名稱 canonicalization

- `tool_name` 必須是「server-level」key（例如 `web_search`），不可組合成 `server.tool`。
- **MUST NOT contain '.'**（此為不可逆約束；測試與 allowlist 皆以此為準）。
- 原因：TOOL allowlist 的 key 以 server-level 為準，避免 runner 端出現 key mismatch。

補充：legacy `{server, tool, args}` 的 `tool` 只能作為 debug/trace（例如 `_original_tool`），不可參與 allowlist key，也不可被塞回 args 去影響 allowlist 驗證。

---

## 4) Evidence contract

- M2-B 透過 Evidence wrapper 將 `attachEvidence()` 回傳的 `{ item }` 形狀轉成 runner 使用的 EvidenceItem。
- **證據 bytes 不可進入 report JSON**：candidate 只送 metadata，`bytes` 由 policy 管控（候選中不得攜帶 blob）。

---

## 5) TOOL→REPLY 派生入口

- M2-B 的派生必須走單一入口：`maybeDeriveReplyFromToolOnFill(updatedTool, outputs, ticketStore, logger)`
- 原則：
  - complete 成功後才嘗試派生
  - 派生失敗不得回滾 complete（只記錄 derive_failed / stable_codes）
  - guardrail 禁止 B-script 直接 import/呼叫 `deriveReplyTicketFromTool`

---

## 6) TicketStore 行為假設

- `TicketStore` 目前為 in-memory（非跨 process 持久化）。
- **TICKETSTORE_PATH 目前僅作為配置欄位，不代表任何 fs persist/hydrate 行為。**
- 因此 executor/worker 的合約測試以「單 process、lease proof、idempotency」為主；不要依賴跨 process 共享 state 的測試或流程。
