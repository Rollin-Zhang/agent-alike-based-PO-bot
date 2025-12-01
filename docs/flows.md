# Flow Specifications

本文件定義系統中的工作流程規格與 DAG 說明。

## 基本流程: reply_basic_tw

這是系統的核心流程，用於處理一般的回覆生成。

### 觸發條件
- 事件類型：`thread_reply`, `mention`
- 語言：繁體中文

### DAG 節點流程

```
[START] → fetch_thread → mem_search → llm_generate → guard_check → reply_send → [END]
```

#### 1. fetch_thread
- **工具**: `threads.fetch_thread`
- **功能**: 獲取觸發事件的貼文完整內容與上下文
- **輸入**: `thread_id` (來自事件)
- **輸出**: 貼文內容、作者資訊、回覆歷史

#### 2. mem_search  
- **工具**: `mem.search`
- **功能**: 搜尋相關的歷史記憶與知識
- **輸入**: 貼文內容摘要、主要關鍵字
- **輸出**: 相關記憶清單與相似度分數

#### 3. llm_generate
- **工具**: `llm.generate` (stub階段)
- **功能**: 基於上下文生成回覆草稿
- **輸入**: 貼文內容、相關記憶、persona設定
- **輸出**: 回覆草稿、信心分數

#### 4. guard_check
- **工具**: `guard.check_content`
- **功能**: 檢查草稿是否符合安全與政策要求
- **輸入**: 回覆草稿、風險類別
- **輸出**: 安全評級、是否需要人工審核

#### 5. reply_send
- **工具**: `reply.send` (stub階段)
- **功能**: 發送回覆或提交待審
- **輸入**: 回覆內容、目標貼文ID
- **輸出**: 發送狀態、回覆ID

### 分支條件

- **mem_search失敗**: 繼續執行，但標記"無歷史記憶"
- **guard_check不通過**: 轉為ApprovalTicket，等待人工審核
- **信心分數 < 0.7**: 轉為ApprovalTicket

### 錯誤處理

- **工具超時**: 記錄錯誤，使用預設值繼續
- **連續失敗**: 標記Ticket為failed，進入重試佇列
- **Critical錯誤**: 立即停止，發送告警

## 未來擴充流程

### notebook_enhanced
當檢測到需要知識檢索時的增強流程：
```
fetch_thread → topic_classify → nb_navigate → nb_chat → mem_search → llm_generate → guard_check → reply_send
```

### flow_selection  
當系統無法確定使用哪個流程時：
```
fetch_thread → analyze_intent → select_flow → execute_selected_flow
```

## 設定參數

### Guardrails
- `auto_send_threshold`: 0.8 (信心分數門檻)
- `sensitive_topics`: ["政治", "醫療建議", "法律諮詢"]
- `max_reply_length`: 500 字

### 速率控制  
- `per_thread`: 每小時最多 3 則回覆
- `per_actor`: 每小時最多 10 則互動
- `global_daily`: 每日最多 1000 則回覆

### 其他設定
- `context_window`: 2000 tokens
- `memory_relevance_threshold`: 0.6
- `retry_attempts`: 3