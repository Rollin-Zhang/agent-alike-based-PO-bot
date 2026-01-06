# M2-B.3 Guardrails 實作報告

**Date**: 2026-01-03  
**Phase**: M2-B.3 (Stage 2 TOOL Worker Guardrails)  
**Status**: ✅ **COMPLETED**

---

## 📋 Executive Summary

本階段新增「合約級 guardrail 測試」，用來鎖死 M2-B 在後續整合/重構時不可退化的行為：

- **TOOL→REPLY strict reject 對稱性**：在 `SCHEMA_GATE_MODE=strict` 的 internal reject 模式下，派生失敗不得污染 parent ticket（TOOL/parent ticket 不應被寫入錯誤欄位、不得產生不完整 REPLY）。
- **Lease / rerun / idempotency 不變量**：ticket lease 必須互斥、lease proof 必須驗證；ticket 已 `done` 後不得再被 lease；重複 complete 不得覆蓋 `metadata.final_outputs`。
- **跨 process 持久化可行性決策**：以最小實驗確認 `TicketStore` 非跨 process 持久化，因此「跨 process rerun」測試不具意義，改以合約級 invariant 測試作為驗收。

---

## ✅ What Changed

### 1) TOOL→REPLY strict reject guardrail

新增測試：
- `orchestrator/test/unit/derive_tool_reply_guardrail.test.js`

鎖死行為：
- `SCHEMA_GATE_MODE=strict` 下，internal gate reject 必須 **return ok=false 且不 throw**
- 若 TOOL→REPLY 派生被 strict reject：
  - 不得新增 REPLY ticket
  - 不得變更 TOOL parent ticket 的狀態/派生 backref/錯誤欄位
  - 必須寫入 schemaGate audit（含非空的 `warn_codes`/`errors`）並增加 metrics

### 2) Lease / rerun / idempotency guardrails

新增測試：
- `orchestrator/test/unit/tool_runner_b_idempotency_guardrail.test.js`

鎖死行為：
- running 狀態 lease 互斥；ownerB 不可搶到 ownerA 的 lease
- release/complete 必須要求正確 lease proof
- ticket `done` 後不可再 lease
- 重複 complete 必須 idempotent，且不得覆蓋既有 `metadata.final_outputs`

### 3) Unit runner wiring

- `orchestrator/test/unit/run.js` 已納入上述兩個新測試模組，避免測試入口分散。

---

## 🔎 TicketStore 跨 process 持久化結論

結論：`TicketStore` 目前屬於 **in-memory store**（即使有 `TICKETSTORE_PATH` 也不會跨 process hydrate）。

因此：
- 不新增「兩個 process 之間共享 ticket 狀態」的 rerun 測試（測試本身無法反映真實合約）。
- 改以單 process 的合約級 guardrail（lease/idempotency）作為驗收依據。

---

## 🧪 How To Validate

- 跑完整 unit suite：
  - `node orchestrator/test/unit/run.js`

---

## 📎 Notes

- **B3 scope note**: M2-B.3 guardrails 鎖的是**合約行為**，不綁定執行路徑（in-process / HTTP 均必須通過相同合約）。
- 合約包含：
  - TOOL→REPLY strict reject 對稱性（internal gate return ok=false, no throw, no parent pollution）
  - Lease/idempotency invariants（lease proof, final_outputs immutability）
  - SSOT codes stability（RUN_CODES, EXIT_CODE mappings）
- **跨 process rerun 不在驗收範圍**：因 TicketStore 非跨 process 持久化，單 process 合約級測試已足夠驗收階段目標。
