# Commit 6 Acceptance Tests

## 概述

Commit 6 驗收測試涵蓋 TRIAGE→TOOL→REPLY 三級衍生的所有關鍵場景。

## 快速使用

### 運行所有測試

```bash
cd orchestrator
npm run test:unit
```

或使用便利腳本：

```bash
cd orchestrator
./test/acceptance/commit6_acceptance.sh
```

### 查看測試結果

測試輸出會顯示：
- 通過/失敗的測試數量
- 失敗測試的詳細錯誤

## 驗收場景

### Gate/環境矩陣測試

| 場景 | 環境變數設定 | 測試函數 |
|------|------------|---------|
| Legacy mode | `ENABLE_TOOL_DERIVATION=false` | `testLegacyMode` |
| New Full | `ENABLE_TOOL_DERIVATION=true`<br>`ENABLE_REPLY_DERIVATION=true` | `testTriageToolReplyChain` |
| Tool-only | `TOOL_ONLY_MODE=true` | `testToolOnlyModeNegative` |
| Reply off | `ENABLE_REPLY_DERIVATION=false` | `testReplyDerivationOff` |
| Verdict block | tool_verdict != PROCEED | `testVerdictBlock` |

### 功能測試

- **正向鏈路**: TRIAGE→TOOL→REPLY (`testTriageToolReplyChain`)
- **Idempotency**: 重複 fill 不產生重複票 (`testIdempotency`)
- **Superset compatibility**: 新 metadata 包含舊版所有 keys (`testRequiredKeysSuperset`)
- **Negatives**: TOOL_ONLY_MODE, verdict block, malformed outputs
- **NO_MCP smoke**: 確認無 MCP 依賴 (`testNoMcpSmoke`)

## 測試檔案

```
test/
├── acceptance/
│   ├── commit6_acceptance.sh  # 便利腳本（可選）
│   └── README.md              # 本文件
└── unit/
    ├── http_tool_reply_derivation.test.js  # Integration tests
    │   ├── testTriageToolReplyChain
    │   ├── testIdempotency
    │   ├── testRequiredKeysSuperset
    │   ├── testToolOnlyModeNegative
    │   ├── testNoMcpSmoke
    │   ├── testLegacyMode          # M1
    │   ├── testReplyDerivationOff  # M4
    │   ├── testVerdictBlock        # M5
    │   └── testMalformedOutputs
    └── helpers/
        ├── server.js   # Server spawn helper
        ├── http.js     # HTTP request helpers
        └── waitFor.js  # Polling helpers (findReplyByParent with legacy branch)
```

## Helper 使用

### findReplyByParent

Helper 提供兩種 REPLY 定位邏輯：

```javascript
// New path: parent_ticket_id (TOOL→REPLY)
const reply = await findReplyByParent(baseUrl, toolId);

// Legacy path: triage_reference_id (TRIAGE→REPLY)
const reply = await findReplyByParent(baseUrl, triageId, { legacy: true });
```

## 故障排查

### 測試失敗

1. 檢查測試輸出中的錯誤訊息
2. 查看 server logs (測試會捕獲 stdout/stderr)
3. 確認環境變數設定正確

### 常見問題

**Q: 測試 timeout**  
A: 檢查 waitForTicket 的 timeout 設定，或查看 server 是否正常啟動

**Q: MCP blacklist 失敗**  
A: 確認 NO_MCP=true，檢查 logs 中是否有 MCP 相關輸出

## 維護

### 新增測試場景

1. 在 `http_tool_reply_derivation.test.js` 新增測試函數
2. Export 該函數
3. `run.js` 會自動載入（使用 `Object.values`）

### 修改 Helper

修改 `helpers/waitFor.js` 中的 `findReplyByParent`：
- 新增 legacy 分支邏輯時，只需更新 predicate
- 所有測試會自動受益

## CI/CD 整合

```bash
# 在 CI pipeline 中運行
cd orchestrator
npm install
npm run test:unit  # Exit code: 0=pass, 1=fail
```

