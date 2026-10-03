# 參與 Kairomes

感謝協助改善 Kairomes。文件與介面以繁體中文為主；程式碼命名採英文，MCP tool description 採模型能理解的明確英文。請遵守[社群行為準則](CODE_OF_CONDUCT.md)。

## 開發環境

- 安裝 [Bun](https://bun.sh/docs/installation) 1.4.2 或以上。在專案根目錄執行 `bun install --frozen-lockfile`。
- 修改 Desktop 或建置桌面程式時，依 [Tauri v2 前置需求](https://v2.tauri.app/start/prerequisites/)安裝 Rust 1.90 或以上與作業系統套件。Windows 需要 Microsoft C++ Build Tools、WebView2 與 Rust MSVC toolchain。
- Windows 11 是目前已驗證的 Desktop 開發環境。CI 會在 Windows、macOS 與 Linux 執行核心檢查；macOS／Linux 的 Desktop 發佈與真實 Tunnel 流程尚未完成實機驗證。
- 現行操作方式見 [README](README.md)；安全邊界與回報方式見 [SECURITY.md](SECURITY.md)。

修改後先執行：

```sh
bun run check
```

此命令會建置 Widget／Extension、檢查 TypeScript 與 Biome，並執行測試。修改 Desktop 時，再執行 `bun run desktop:check`；修改 Rust 程式時，另執行 `cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml` 與 `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`。格式修正可用 `bun run format`。

修改依賴時，同時執行 `bun audit`；Rust 鎖檔可用 `cargo audit --file apps/desktop/src-tauri/Cargo.lock` 檢查 RustSec 公告。CI 會在鎖檔／manifest 變更及每週排程時重跑依賴稽核；警告與影響平台需在 PR 說明。

## 從原始碼執行

在專案根目錄執行 `bun run build`、`bun run desktop`。`bun run package:extension` 會建立側欄 ZIP；`bun run build:desktop` 會建立未簽章的 Windows NSIS 安裝程式。

Headless 模式需先結束 Desktop 或既有 Host，再以 `bun run app --port 0 --extension-id YOUR_EXTENSION_ID` 啟動工作台。另建立指向 `bun run kairomes serve --attach --stdio` 的 Tunnel profile；若使用自訂 `--data-dir`，工作台與 relay 必須一致。手動執行 `tunnel-client run` 時，需自行安全地提供 `CONTROL_PLANE_API_KEY` 環境變數。Desktop 的憑證保管庫不會替手動終端機注入金鑰；若未安裝 Desktop sidecar，也不能沿用 Desktop 複製的 profile 指令。此模式的程序由你自行管理。

`bun run companion` 與 `bun run preview` 主要供開發及復原使用。Desktop「從 Codex 接續」與選用的 `kairomes handoff` 唯讀來源預覽需要 Codex CLI；Desktop 手動摘要不需要。H1 管理通道與原生側欄授權分離，接續不會改變 grant。Desktop H1 接續介面尚未包含於 `v0.1.4` 發佈檔案。

### 開發用合成側欄預覽

在根目錄執行：

```sh
bun run scripts/preview-sidebar.ts
```

依終端機列出的入口檢查配對、1／3／10 件核准、MCP 設定、歷史閱讀與 `/host-viewer` 的晚回覆順序。這是內部工程工具，一般使用者不需操作。頁面使用純合成資料及 mock bridge；測試控制的 POST 只接受白名單操作並修改記憶體，不啟動真實 Host、Tunnel、shell 或 Codex reader，也不使用真實配對憑證或私人聊天。可用於窄版、鍵盤與文字密度檢查；通過不代表 Extension 真實配對、桌面剪貼簿、Codex 或 ChatGPT／Tunnel 帳號端到端流程已通過。測試證據須分清合成預覽、受控本機與真實帳號流程。

`/panel-flow?pending=1&mcp-unavailable=1` 可模擬 MCP 新增回覆遺失、關閉表單、公布已儲存但無法連線的配置，再以「查詢狀態」恢復控制。只使用合成程式名稱，不啟動程序。MCP 管理寫入的側欄請求上限為 150 秒；唯讀目錄查詢仍為 10 秒，涵蓋 Host 的 stdio 初始化 120 秒與工具清單 10 秒。

`/panel-flow?idle=1` 可檢查沒有待核准工作時的頂列：連線圓點、「設定」與單行布局。設定應直達 MCP 整合，返回時保留入口焦點；未配對／配對失效則進入一般設定並停用 MCP 分類。使用記憶體控制另檢查恢復入口與有工作時的操作列，不能代替原生側欄驗收。

`/panel-flow?oauth=1` 為原生 MCP 登入的合成卡片；登入、取消、清除與未知結果查詢只修改測試記憶體，不註冊 client 或開啟真登入頁。加上 `oauth-tools-error=1` 可檢查清單失敗與展開管理的布局；`/oauth-result?outcome=authorized` 可直接檢查靜態回呼頁，另有 `connected`／`failed`。這些入口只供工程驗收。

登入管理器另以實際 loopback listener、注入 provider／network、固定時間及 HTTP 發送計數測試；不能用合成畫面代替 Layer 帳號相容性。修改登入生命週期、網路、儲存或 SDK 時，須保留世代失效、callback、owner、收據容量與工具不重送的失敗案例。公開相容性查核可使用無憑證 metadata GET、MCP `initialize` 與 `tools/list`，不建立 OAuth client 或呼叫 `tools/call`。真實授權與工具測試由帳號使用者完成，不以付費或寫入操作冒煙驗證。詳見[MCP OAuth 實作紀錄](docs/product-design/mcp-oauth-implementation.md)及[相容性修補](docs/product-design/mcp-oauth-recovery.md)。

## 發佈預覽版

將根目錄 `package.json`、各 workspace、擴充功能 manifest、Tauri 與 Rust 版本維持一致，先執行 `bun run check` 和 `bun run desktop:check`。從已推送的發佈 commit 建立同版號的 tag，例如 `v0.1.4`，再推送該 tag。Release 工作流程只接受與 `package.json` 版本相符的 tag；檢查通過後會建立 Windows NSIS 安裝程式、可解壓載入的 Chrome／Edge 擴充功能 ZIP 與 SHA-256 清單，並附在 GitHub Release。`0.x` 版本標記為預覽版。安裝程式目前未簽章，擴充功能也未經商店發佈。

## 提交變更

側欄 UI／UX 與 Codex 接續的後續提案見[產品設計與開發文件](docs/product-design/README.md)。其中未實作項目不代表目前版本功能。

1. 在 issue 或 PR 說明要解決的使用者問題、實際行為與設計取捨。較大的功能先討論範圍，避免同時改動安全邊界與 UI 流程。
2. 保持變更聚焦，更新受影響的文件。新增 MCP 工具時，同步更新 schema、資源上限、權限敘述與使用指南。
3. 在 PR 列出執行過的檢查、結果，以及仍未驗證的作業系統、瀏覽器或 ChatGPT／Tunnel 路徑。不要把本機測試寫成真實帳號端到端驗證。
4. 不要提交憑證、工作區原始碼、私人連線 URL、日誌或真實聊天逐字稿。安全漏洞請依[安全回報方式](SECURITY.md)處理，不要在公開 issue／PR 提供利用細節。

## 重要安全邊界

- MCP server 的 stdout 僅供 JSON-RPC 使用；診斷寫入 stderr。
- 工作區只能由本機 Desktop／CLI 管理面掛載或解除掛載，模型沒有這項權限。模型輸入使用 opaque ID 與相對路徑。
- 新工具要有明確的輸入／輸出 Zod schema、上限與 annotations。
- 命令與終端機批准只能出現在可信本機管理通道；MCP／widget 不取得批准能力或管理權杖。
- 路徑驗證、授權、預覽網路邊界或程序管理變更，要加入對應的失敗案例並說明剩餘限制。
- 升級 MCP SDK 與 MCP Apps 時一併檢查 peer dependencies。UI 資源若有不相容變更，更新 `WIDGET_URI` 版本並重新建置。
- 不要把已知的工具限制包裝成已實作功能，也不要把程序回收或路徑檢查稱為 OS sandbox。
