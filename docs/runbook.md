# 系統運維手冊 (Runbook)

本手冊提供系統的啟動、停止、配置與故障排查指引。

## 快速啟動

### 1. 啟動 Orchestrator
```bash
cd orchestrator
npm start
# 或使用 PM2
pm2 start ecosystem.config.js
```

### 2. 啟動 VS Code Client
```bash
cd vs-code-client  
npm run start
```

### 3. 檢查服務狀態
```bash
curl http://localhost:3000/health
curl http://localhost:3001/health
```

## 設定檔案

### 環境變數
```bash
# .env
ORCHESTRATOR_PORT=3000
MCP_CONFIG_PATH=./mcp_config.json
TICKET_STORE_TYPE=memory  # 或 redis
LOG_LEVEL=info
DRY_RUN=true  # 設定為 false 才會真實發送
ORCH_REINDEX_ON_BOOT=true    # 啟動時自動重建 triage/reply 索引
ORCH_TAIL_SNAPSHOTS=true     # 追蹤 triage 決策檔並自動產生回覆
TRIAGE_SNAPSHOT=./logs/triage_decisions.jsonl
REPLY_SNAPSHOT=./logs/reply_results.jsonl
SNAPSHOT_WATERMARK=./logs/reply_watermark.json
```

### MCP 伺服器設定
位置：`orchestrator/mcp_config.json`

重要設定：
- 各 MCP 伺服器的端點
- 速率限制參數
- 超時設定

### VS Code 客戶端設定
位置：`vs-code-client/config.json`

```json
{
  "orchestrator_url": "http://localhost:3000",
  "poll_interval": 5000,
  "batch_size": 5,
  "lease_timeout": 300,
  "dry_run": true
}
```

## 操作模式切換

### Dry-run 模式 (測試)
```bash
# 設定環境變數
export DRY_RUN=true

# 或修改設定檔
echo '{"dry_run": true}' > vs-code-client/config.json
```

### 實際發送模式 (生產)
```bash
# 確認所有設定正確後
export DRY_RUN=false

# 重啟服務
pm2 restart all
```

## M2 完整驗收 (Acceptance Matrix)

M2 驗收至少包含兩條主線（NO_MCP / Real MCP），並建議納入 strict readiness（以 metrics 為證據）。

### A. M2 Acceptance（NO_MCP 模式）

目的：保證「降級模式」下流程能穩定跑完，且所有 guard/metrics 不會崩。

跑法：
```bash
cd orchestrator
npm run accept:no_mcp
```

Pass 條件：
- probes（NO_MCP=true）PASS
- unit suite PASS
- /metrics shape 仍正確（含 cutover block）

### B. M2 Acceptance（Real MCP 模式）

目的：保證整合模式（memory/web_search/notebooklm）能跑到尾，且不因 stdout/網路波動隨機炸掉。

跑法：
```bash
cd orchestrator
npm run accept:real_mcp
```

Pass 條件：
- probes（Real MCP）allPassed: true
- unit suite PASS
- web_search 出現 timeout log 可接受，但測試不得紅

### C. Strict Gate Check（讀 /metrics，建議納入）

核心精神：strict 不靠感覺，靠 metrics=0 的證據。此步驟不一定要「允許切 strict」，但必須能產出可追溯的機械化判定與理由。

前提：orchestrator server 正在跑，且可存取 `/metrics`。

跑法：
```bash
cd orchestrator
npm run strict:check -- --url http://localhost:3000/metrics --json
```

你要收的 evidence：
- cutover.mode
- counters：canonical_missing, cutover_violation, legacy_read
- strictCutoverGate 的 decision（allow/blocked）與理由

### 一鍵總驗收（建議 DoD 寫死）

跑法：
```bash
cd orchestrator
npm run accept:m2
```

輸出：
- 終端機摘要：PASS/FAIL + strict gate status
- JSON 報告：`orchestrator/out/m2_acceptance_report.json`

M2 完整 DoD（建議）：
- ✅ `accept:no_mcp` 必須 PASS
- ✅ `accept:real_mcp` 必須 PASS
- ✅ repo-guard 測試必須在 suite 內（避免 compat / legacy path / scattered writes 回歸）
- ✅ `/metrics.cutover` 形狀固定（含 `env_source` 等必要欄位）
- ✅ strict gate 判斷必須可重跑、可解釋（JSON evidence）

## 監控與日誌

### 關鍵指標
- Ticket 處理速率：`/metrics/tickets_per_second`
- 佇列深度：`/metrics/queue_depth`  
- 成功率：`/metrics/success_rate`
- 平均延遲：`/metrics/avg_latency`

### 日誌位置
- Orchestrator: `logs/orchestrator.log`
- VS Code Client: `logs/vscode-client.log`
- Audit: `logs/audit.log`

### 日誌格式
```json
{
  "timestamp": "2024-01-01T12:00:00Z",
  "task_id": "task_123",
  "flow_id": "reply_basic_tw", 
  "tool": "mem.search",
  "input_summary": "搜尋關鍵字：AI發展趨勢",
  "duration_ms": 1500,
  "status": "success"
}
```

## 故障排查

### 常見問題

#### 1. Orchestrator 無法啟動
**症狀**: 服務啟動失敗或立即退出

**檢查步驟**:
```bash
# 檢查端口是否被占用
lsof -i :3000

# 檢查設定檔語法
node -c orchestrator/index.js

# 檢查 MCP 伺服器連線
curl http://localhost:3001/mcp/health
```

#### 2. VS Code 客戶端無法拉取 Ticket
**症狀**: 客戶端日誌顯示 HTTP 錯誤

**檢查步驟**:
```bash
# 測試 Orchestrator API
curl http://localhost:3000/tickets?status=pending

# 檢查客戶端設定
cat vs-code-client/config.json

# 檢查網路連線
ping localhost
```

#### 3. MCP 工具調用失敗
**症狀**: DAG 執行中斷，工具返回錯誤

**檢查步驟**:
```bash
# 檢查 MCP 伺服器狀態
curl http://localhost:3002/mcp/tools

# 檢查速率限制
grep "rate_limit" logs/orchestrator.log

# 手動測試工具
curl -X POST http://localhost:3002/mcp/mem.search \
  -H "Content-Type: application/json" \
  -d '{"query": "test"}'
```

#### 4. 草稿品質不佳
**症狀**: 生成的回覆不符合預期

**調整方法**:
1. 檢查 persona 設定
2. 調整 memory search 相關性門檻
3. 更新 prompt template
4. 增加更多訓練範例

### 緊急處理

#### 立即停止所有自動回覆
```bash
# 設定為 dry-run 模式
export DRY_RUN=true
pm2 restart all

# 或者直接停止
pm2 stop all
```

#### 清空待處理佇列
```bash
curl -X DELETE http://localhost:3000/tickets/pending
```

#### 檢視最近的錯誤
```bash
tail -100 logs/orchestrator.log | grep ERROR
```

## 效能調校

### 建議設定 (生產環境)
- Batch size: 3-5
- Poll interval: 10-30 秒
- Lease timeout: 5 分鐘
- Memory cache: 啟用
- Rate limits: 根據 API 配額調整

### 擴展建議
- 使用 Redis 作為 Ticket Store
- 多個 VS Code 客戶端實例
- Load balancer 分散負載
- 監控告警設定

## 定期維護

### 每日檢查
- [ ] 檢查日誌中的錯誤
- [ ] 確認成功率 > 95%
- [ ] 檢查佇列積壓情況

### 每週檢查  
- [ ] 回顧 audit 記錄
- [ ] 更新敏感詞清單
- [ ] 檢查成本使用情況

### 每月檢查
- [ ] 分析效能趨勢
- [ ] 更新文檔
- [ ] 系統備份