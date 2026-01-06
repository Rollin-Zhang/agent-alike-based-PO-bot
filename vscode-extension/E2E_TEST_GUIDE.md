# VS Code Extension E2E Guide

## Phase A (NO_MCP) — 最小可重跑閉環

目標：在不依賴 MCP/外部服務的前提下，驗證 **HTTP 合約 + 票據生命週期 + direct fill + TRIAGE→TOOL→REPLY 派生** 都能穩定跑通，並產出可追溯 evidence。

---

## 一鍵 Smoke（建議先跑這個）

在 repo 根目錄執行：

```bash
cd orchestrator
./scripts/e2e_smoke_phaseA_no_mcp.sh
```

輸出：
- evidence 目錄：`orchestrator/evidence_store/<YYYY-MM-DD>/phaseA/<run_id>/`
- latest 指標：`orchestrator/evidence_store/latest_phaseA.json`
- 最新摘要：`orchestrator/out/phaseA_smoke_report.json`

Exit codes：
- `0` PASS
- `2` runtime/server error
- `7` contract drift（合約形狀/必填欄位不符，視為「合約壞」）

---

## VS Code 一鍵啟動（Extension Development Host + Orchestrator NO_MCP）

前置：已在 root `.vscode` 加入 tasks/launch。

1. 在 VS Code 的 Run and Debug
2. 選擇 `Phase A: Run Extension + Orchestrator (NO_MCP)`
3. 按 F5

這會：
- 啟動 orchestrator（`NO_MCP=true`, port `3000`）
- 啟動 extension TypeScript watch
- 開 Extension Development Host

---

## 手動操作：跑 Extension Self-Test（Phase A）

在 Extension Development Host 視窗：

1. 開 Command Palette
2. 執行 `PO Bot: Self Test`（命令 id: `agent-po-bot.selfTest`）
3. 觀察 Output Channel：`PO Bot Self-Test`

Self-test 行為（Phase A/NO_MCP-safe）：
- `POST /events` 建立 TRIAGE ticket
- `POST /v1/tickets/:id/fill` 使用 `by=manual` 做 deterministic direct fill
- `GET /v1/tickets/:id` 輪詢到 terminal status（done/failed/blocked）
- 驗證 `metadata.final_outputs.decision === "APPROVE"`

---

## 常見問題

- 如果 F5 後 orchestrator 沒起來：查看 VS Code Terminal 對應 `orchestrator: start (NO_MCP)` task 的輸出，確認沒有 `EADDRINUSE` 或 npm 錯誤。
- 如果 self-test 顯示 blocked/failed：Output Channel 會印出 `metadata`，其中可能有 `metadata.block`（schemaGate/policy）或錯誤原因。
