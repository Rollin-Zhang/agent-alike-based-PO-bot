# PO Bot LLM 問答系統完整運行指南

## 🎯 系統概述

這是一個智能產品經理 (PO) 助理機器人系統，使用 LLM 技術自動處理各種工作票據和問答任務。系統分為三個主要組件：

1. **Orchestrator** - 後端調度服務 (http://localhost:3000)
2. **VS Code Extension** - 前端用戶界面
3. **測試腳本** - 自動化驗證工具

## 🚀 快速啟動指南

### 步驟 1: 啟動 Orchestrator 服務

```bash
# 進入 orchestrator 目錄
cd /Users/wangshihya/agent-alike_based_PO_bot/orchestrator

# 確認環境配置 (DRY_RUN=false)
cat .env

# 啟動服務
node index.js &

# 檢查服務狀態
curl -s http://localhost:3000/health
```

**預期輸出：**
```json
{
  "status": "healthy",
  "uptime": X.X,
  "queue_depth": 0,
  "last_poll": "2025-09-22T...",
  "timestamp": "2025-09-22T...",
  "dry_run": false
}
```

### 步驟 2: 編譯 VS Code Extension

```bash
# 進入 vscode-extension 目錄
cd /Users/wangshihya/agent-alike_based_PO_bot/vscode-extension

# 安裝依賴
npm install

# 編譯 TypeScript
npm run compile
```

### 步驟 3: 執行測試

#### 3.1 Shell 自動化測試

```bash
# 回到根目錄
cd /Users/wangshihya/agent-alike_based_PO_bot

# 執行基本診斷測試
./test_diagnostic_qa.sh

# 執行強化場景測試
./test_enhanced_scenarios.sh
```

#### 3.2 VS Code 內建測試

1. 在 VS Code 中按 `Cmd+Shift+P` (macOS) 或 `Ctrl+Shift+P` (Windows/Linux)
2. 搜尋並執行 "PO Bot: Self-test"
3. 查看輸出窗口中的測試結果

## 📋 測試問題與預期

### 當前測試問題
**問題：** "簡單介紹線性代數"

### 預期 LLM 回應內容
- 包含 "線性代數" 關鍵字
- 可能包含：向量、矩陣、線性變換等概念
- 回應長度超過 10 字符
- 具有教育性和解釋性內容

### 驗證邏輯
系統會檢查 LLM 回應是否包含以下關鍵字：
- "線性代數"
- "向量" 
- "矩陣"
- "線性"
- "數學"
- "代數"

## 🔧 系統配置

### Orchestrator 配置 (.env)
```
DRY_RUN=false          # 必須為 false 才能實際調用 LLM
ORCHESTRATOR_PORT=3000
LOG_LEVEL=info
MCP_CONFIG_PATH=./mcp_config.json
TICKET_STORE_TYPE=memory
```

### MCP 配置 (mcp_config.json)
包含 LLM 工具配置：
```json
"llm": {
  "endpoint": "http://localhost:3006/mcp",
  "description": "LLM service for text generation",
  "tools": ["llm.generate", "llm.chat", "llm.embed"]
}
```

### VS Code Extension 配置
```json
{
  "orchestrator.baseUrl": "http://localhost:3000",
  "worker.pollIntervalMs": 5000,
  "worker.concurrency": 2
}
```

## 📊 測試流程說明

### 1. 基本診斷測試 (test_diagnostic_qa.sh)

**執行流程：**
1. 檢查 Orchestrator 服務健康狀態
2. 提交 `diagnostic_qa` 事件到 `/events` 端點
3. 輪詢 `/ticket/{ticket_id}` 檢查處理狀態
4. 驗證回應內容是否符合預期

**日誌示例：**
```
🤖 PO Bot Q&A 診斷自動化驗收
==================================
ℹ️  檢查 Orchestrator 服務狀態...
✅ Orchestrator 狀態: healthy, dry_run: false
ℹ️  提交診斷事件 (ID: diagnostic-qa-...)...
✅ 事件已提交，票據 ID: xxx-xxx-xxx
ℹ️  等待 Extension 處理票據 (最長等待 30s)...
✅ 處理完成: "線性代數是數學的一個分支..."
🎉 診斷測試通過！
```

### 2. 強化場景測試 (test_enhanced_scenarios.sh)

包含 5 種測試情境：
1. **長度限制測試** - 驗證 max_chars=30 限制
2. **格式測試** - 驗證日期格式 (yyyy-mm-dd)
3. **記憶注入測試** - 測試上下文記憶功能
4. **空佇列測試** - 驗證輪詢間隔調整
5. **診斷測試** - 線性代數介紹驗證

### 3. VS Code 自我測試

**執行步驟：**
1. 提交診斷事件到 Orchestrator
2. 等待 LLM 處理 (最長 30 秒)
3. 驗證回應包含線性代數相關內容
4. 顯示通過/失敗結果

## 🔍 故障排除

### 常見問題與解決方案

#### 1. Orchestrator 無法啟動
```bash
# 檢查端口占用
lsof -i :3000

# 檢查日誌
tail -f orchestrator/logs/orchestrator.log
```

#### 2. LLM 工具不可用
```bash
# 檢查 MCP 配置
cat orchestrator/mcp_config.json | grep -A 10 "llm"

# 確認 LLM 服務運行狀態
curl -s http://localhost:3006/mcp/tools
```

#### 3. VS Code Extension 錯誤
```bash
# 重新編譯
cd vscode-extension
rm -rf out/
npm run compile

# 重啟 TypeScript 服務
# 在 VS Code 中：Cmd+Shift+P → "TypeScript: Restart TS Server"
```

#### 4. 測試逾時
```bash
# 檢查票據狀態
curl -s http://localhost:3000/ticket/{ticket_id}

# 檢查佇列深度
curl -s http://localhost:3000/health | grep queue_depth
```

## 📈 性能監控

### 關鍵指標
- **回應時間**: LLM 處理單個請求的時間
- **佇列深度**: 待處理票據數量
- **成功率**: 測試通過率
- **錯誤率**: 處理失敗的票據比例

### 監控命令
```bash
# 即時監控服務狀態
watch -n 2 "curl -s http://localhost:3000/health"

# 查看最近的票據
curl -s "http://localhost:3000/tickets?limit=10"

# 檢查錯誤日誌
tail -f orchestrator/logs/orchestrator.log | grep ERROR
```

## 🎉 成功標準

### 測試通過標準
1. ✅ Orchestrator 服務健康運行
2. ✅ 診斷事件成功提交
3. ✅ LLM 成功生成回應
4. ✅ 回應內容包含線性代數相關概念
5. ✅ 整個流程在 30 秒內完成

### 預期輸出示例
```
📄 Draft: "線性代數是數學的一個重要分支，主要研究向量空間和線性映射。它包括向量、矩陣、線性方程組等核心概念..."
🎯 Confidence: 0.95
🎉 Self-test PASSED! Response contains linear algebra content.
```

這個系統現在已準備好處理各種 PO 工作流程和智能問答任務！🚀