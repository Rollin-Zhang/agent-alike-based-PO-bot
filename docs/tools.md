# MCP 工具白名單

本文件記錄了系統中可用的 MCP (Model Context Protocol) 工具及其說明。

## 工具分類

### Threads Provider (threads)
負責處理社群媒體貼文的拉取與回覆功能。

- **thread.fetch**: 獲取指定貼文的完整內容 (輸入: thread_id)
- **threads.list_notifications**: 列出新的通知與提及
- **threads.post_reply**: 發布回覆到指定貼文
- **threads.get_thread_history**: 獲取貼文的歷史對話記錄

### Memory Service (mem)
提供語義搜尋與記憶存儲功能。

- **mem.search**: 基於語義相似度搜尋相關記憶 (輸入: query, limit)
- **mem.write**: 寫入新的記憶條目 (輸入: content, context, kind)
- **mem.get**: 獲取指定記憶條目 (輸入: memory_id)
- **mem.delete**: 刪除記憶條目 (輸入: memory_id)

### LLM Generation Service
大語言模型回覆生成服務。

- **llm.generate**: 基於上下文生成回覆草稿 (輸入: context, memories, persona) [占位實作]

### Guardrails Service (guard)  
內容安全與政策檢查服務。

- **guard.check**: 檢查內容是否符合安全政策 (輸入: content, policies)
- **guard.check_policy**: 驗證操作是否符合業務政策
- **guard.classify_risk**: 對內容進行風險分級

### Reply Service (reply)
負責回覆的發送與管理。

- **reply.send**: 發送回覆內容
- **reply.schedule**: 排程延遲發送
- **reply.cancel**: 取消待發送的回覆

### NotebookLM (nb) [可選]
知識檢索與 RAG 功能。

- **nb.navigate**: 導航到指定筆記本
- **nb.chat_with_notebook**: 與筆記本進行對話查詢
- **nb.search_notebooks**: 搜尋相關筆記本內容

## 速率限制

各服務都有獨立的速率限制設定：
- Threads: 60 req/min (burst: 10)
- Memory: 100 req/min (burst: 20)  
- Guard: 200 req/min (burst: 50)
- Reply: 30 req/min (burst: 5)
- NotebookLM: 20 req/min (burst: 3)

## 容錯機制

- **工具不可用**: 跳過該節點，繼續執行流程
- **伺服器超時**: 重試一次後失敗
- **速率限制**: 將請求加入佇列等待

## 配置檔案

詳細設定請參考 `orchestrator/mcp_config.json`。