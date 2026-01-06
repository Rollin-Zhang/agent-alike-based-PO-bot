# M2‑C.2 Strict Enable/Rollback Gate

本文件描述「何時可以安全啟用 strict/cleanup」的操作流程。

## 核心概念

- Orchestrator 的 `/metrics` 會回傳 `cutover` block，包含：
  - `cutover_until_ms` / `env_source` / `mode`
  - `metrics`：低基數 counters（`canonical_missing` / `cutover_violation` / `legacy_read`）
- Gate 規則（SSOT）：由 `orchestrator/lib/compat/strictCutoverGate.js` 定義。

## 一鍵檢查

啟動 Orchestrator（任何環境皆可），然後執行：

```bash
cd orchestrator
npm run strict:check
# 或：node scripts/strict_gate_check.js --url http://localhost:3000/metrics
```

成功（exit=0）代表 gate OK；失敗（exit=1）代表目前不建議啟用 strict。

## 何時可以「Enable」

當 gate OK 時，代表：
- `canonical_missing(tool_verdict) == 0`
- `cutover_violation(tool_verdict) == 0`
- 若 `mode=post_cutover`：`legacy_read(tool_verdict) == 0`

在這個狀態下，可以進行 strict/cleanup 的切換（例如：將 `CUTOVER_UNTIL_MS` 設為過去時間，讓系統進入 post‑cutover 判定）。

## Rollback 指引

若 gate BLOCKED（exit=1），請不要切換 strict。建議：
- 先看 `/metrics` 的 `cutover.metrics.counters` 找出是哪一個 signal 非 0
- 優先處理 `canonical_missing`（代表 canonical 欄位缺失仍在發生）
- 修復後讓系統穩定一段時間，再重跑 `npm run strict:check`

## 補充

- 這個 gate 只依賴低基數 metrics snapshot，不需要讀取 ticket payload。
- 若要針對非預設 port/host 檢查，使用 `--url` 參數。
