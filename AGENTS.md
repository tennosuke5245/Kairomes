# Kairomes 開發指引

## 語言與依據

- 對使用者的回覆、介面文字及公開文件使用繁體中文，禁止簡體中文。程式識別字使用英文；MCP 工具描述使用清楚的英文。
- 以目前程式碼及根目錄的 `README.md`、`CONTRIBUTING.md`、`SECURITY.md` 為準；歷史計畫不能作為現行功能的唯一依據。

## 專案位置

- `apps/desktop`：React 桌面介面與 Tauri 生命週期。
- `apps/extension`：Chrome／Edge 側欄；`apps/widget`：聊天內 MCP App。
- `apps/cli`：CLI 與 Desktop sidecar 入口；`apps/daemon`：本機服務、MCP、核准與工具執行。
- `packages/protocol`：共享 schema；`packages/workspace-core`：工作區登錄與檔案操作；`scripts`：建置與檢查。

## 修改與驗證

- 程式碼變更後執行 `bun run check`；涉及 Desktop、Tauri 或 sidecar 時再執行 `bun run desktop:check`。純文件修改須檢查相對連結與對外敘述。
- 變更 MCP 工具、schema、權限或 UI resource 時，同步更新相關測試與公開文件。不相容的 widget resource 變更需更新 `WIDGET_URI`。
- 版本、依賴與可用指令以各 manifest 和根目錄 `package.json` 為準；不要依歷史計畫推斷功能已實作。

## 安全邊界

- MCP stdio 的 stdout 只輸出 JSON-RPC；診斷寫入 stderr。
- 工作區掛載與命令／終端機核准只由可信本機管理面執行。模型輸入使用 opaque ID 與相對路徑；MCP 和 widget 不得取得管理權杖或自行核准。
- 命令與終端機使用主機使用者權限，不是 OS sandbox。修改路徑驗證、授權、預覽網路邊界或程序管理時，加入對應的失敗案例。
- 不提交或輸出 API key、Token、配對連結、私人本機 URL、使用者工作區內容、日誌或聊天逐字稿。
