# Agent-alike PO Bot

這個 repo 包含一套分散式的「票據驅動（Ticket-driven）」自動化回覆系統。

- Orchestrator（`orchestrator/`）：負責派發/租賃票據、回填結果、整合外部工具（MCP）
- VS Code Extension（`vscode-extension/`）：作為 Worker，使用 VS Code Copilot LLM 算力處理 TRIAGE/REPLY

設計細節請見 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 快速開始 (Quick Start)

### 1) 安裝依賴

```bash
cd vscode-extension
npm install
```

### 2) 編譯（會自動複製 YAML）

```bash
npm run compile
```

> `compile` 會先執行 `copy-prompts`，把 `src/prompts/*.yaml` 搬到 `out/src/prompts` 與 `out/prompts`，供執行期讀取。

### 3) 啟動偵錯（F5）

- 用 VS Code 開啟本工作區（或直接開啟 repo 根目錄）。
- 切到 Run and Debug，選擇 Extension 的偵錯設定，按下 `F5`。
- Extension Host 啟動後會自動在 `onStartupFinished` 啟用並開始輪詢票據。

### 4) 常見問題排除

- 問題：出現 `prompts directory not found`
  - 請確認 `vscode-extension/out/src/prompts` 或 `vscode-extension/out/prompts` 內有 YAML 檔案。
  - 若沒有，重新執行 `cd vscode-extension && npm run compile`。
  - 若你有自訂部署路徑，也可設定環境變數 `POB_PROMPTS_DIR` 指向 prompts 目錄。

---

## 其他文件

- LLM/流程導引：`README_LLM_GUIDE.md`
- 運維與流程：`docs/`
