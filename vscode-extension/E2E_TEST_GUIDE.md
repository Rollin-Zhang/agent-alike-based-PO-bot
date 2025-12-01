/**
 * VS Code Extension E2E 測試指引
 * 
 * 這個檔案提供了手動測試 VS Code Extension 的完整步驟
 */

# VS Code Extension E2E 測試步驟

## 環境準備

1. **確認 Orchestrator 服務運行**
   ```bash
   cd /Users/wangshihya/agent-alike_based_PO_bot/orchestrator
   npm start
   # 或檢查：curl http://localhost:3000/health
   ```

2. **啟動 Extension 開發模式**
   ```bash
   cd /Users/wangshihya/agent-alike_based_PO_bot/vscode-extension
   npm run watch
   ```

3. **在 VS Code 中載入 Extension**
   - 開啟 VS Code Extension 專案目錄
   - 按 F5 或 Cmd+R 啟動 Extension Development Host
   - 在新視窗中測試

## 測試資料準備

在 Orchestrator 中建立測試票據：

```bash
# 提交測試事件
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "user_request", 
    "event_id": "test-manual-001", 
    "thread_id": "thread-manual-001", 
    "content": "需要實作一個使用者註冊功能，包含 email 驗證、密碼強度檢查、重複註冊防護，以及註冊成功後的歡迎信發送機制。請提供完整的實作方案。", 
    "actor": "manual_test_user", 
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"
  }'

# 建立更多測試資料
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "feature_request", 
    "event_id": "test-manual-002", 
    "thread_id": "thread-manual-002", 
    "content": "實作購物車功能：商品加入、數量調整、優惠券套用、結帳流程，需要支援多種付款方式", 
    "actor": "manual_test_user", 
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"
  }'

# 檢查票據狀態
curl http://localhost:3000/tickets
```

## VS Code Extension 測試流程

### 1. 啟動與設定檢查

1. **開啟 Extension**
   - 在 Extension Development Host 視窗中
   - 側邊欄應該出現 "PO Bot" 圖示
   - 點擊進入 PO Bot 側邊欄

2. **檢查初始設定**
   - 檢查輸出面板 (View > Output > PO Bot Extension)
   - 確認 logger 正常運作
   - 檢查設定：File > Preferences > Settings > 搜尋 "poBot"

### 2. 票據列表功能

1. **刷新票據**
   - 點擊側邊欄的 "Refresh Tickets" 按鈕
   - 或使用命令面板：Cmd+Shift+P > "PO Bot: Refresh Tickets"

2. **檢查票據顯示**
   - 確認票據按狀態分組 (Pending, In Progress, Completed)
   - 檢查票據標題和摘要顯示正確
   - 點擊票據查看詳細資訊

### 3. 背景處理流程

1. **觀察背景輪詢**
   - 檢查輸出面板的 polling 日誌
   - 預期：每 5-15 秒輪詢一次 (適應性間隔)

2. **票據自動處理**
   - 當有 pending 票據時，worker 會自動：
     - 拉取票據 (lease/query)
     - 建構 Traditional Chinese prompt
     - 調用 VS Code Chat API
     - 回填生成結果

3. **檢查處理品質**
   - 生成的草稿是否為繁體中文
   - 內容是否合理回應原始請求
   - 檢查 confidence 評分

### 4. 人工審批流程

1. **票據詳細檢視**
   - 點擊已處理的票據
   - 檢查詳細資訊面板內容
   - 確認顯示：原始請求、生成草稿、confidence、模型資訊

2. **Approve/Reject 操作**
   - 在票據詳情中點擊 "Approve" 或 "Reject"
   - 檢查操作結果和狀態更新
   - 確認 audit log 記錄

### 5. 錯誤處理與邊界情況

1. **網路錯誤**
   - 暫停 Orchestrator 服務
   - 觀察 Extension 的錯誤處理和重試機制

2. **空佇列處理**
   - 清空所有票據
   - 檢查輪詢間隔是否增加 (5s → 15s → 30s)

3. **並發控制**
   - 建立多個票據
   - 檢查是否按設定的並發數處理

## 驗收標準檢查

### 效能要求
- [ ] P95 端到端延遲 < 30 秒
- [ ] 背景處理不影響 VS Code 回應性
- [ ] 記憶體使用合理 (< 100MB)

### 功能要求  
- [ ] 票據拉取與處理正確
- [ ] Traditional Chinese prompt 生成
- [ ] VS Code Chat API 整合成功
- [ ] Approve/Reject 流程完整
- [ ] 狀態更新及時反映

### 穩定性要求
- [ ] 錯誤處理與重試機制
- [ ] 網路斷線恢復
- [ ] 衝突處理 (lease conflicts)
- [ ] 設定持久化

### Audit & Logging
- [ ] 完整的 audit trail
- [ ] 包含模型資訊的日誌
- [ ] 性能指標記錄

## 除錯資源

1. **輸出面板**：View > Output > PO Bot Extension
2. **開發者工具**：Help > Toggle Developer Tools
3. **Extension Host 日誌**：在 Extension Development Host 中檢查
4. **Orchestrator 日誌**：logs/orchestrator.log

## 已知問題與限制

1. **Chat API 模擬**：目前使用 mock 實作，實際 VS Code Chat API 可能行為不同
2. **Lease 機制**：Orchestrator 暫無 lease API，使用 polling 替代
3. **干運行模式**：Orchestrator 處於 dry_run=true 狀態