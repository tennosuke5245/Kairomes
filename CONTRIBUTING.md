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

`bun run companion` 與 `bun run preview` 主要供開發及復原使用。選用的 `kairomes handoff` 唯讀交接預覽才需要 Codex CLI。

## 發佈預覽版

將根目錄 `package.json`、各 workspace、擴充功能 manifest、Tauri 與 Rust 版本維持一致，先執行 `bun run check` 和 `bun run desktop:check`。從已推送的發佈 commit 建立同版號的 tag，例如 `v0.1.4`，再推送該 tag。Release 工作流程只接受與 `package.json` 版本相符的 tag；檢查通過後會建立 Windows NSIS 安裝程式、可解壓載入的 Chrome／Edge 擴充功能 ZIP 與 SHA-256 清單，並附在 GitHub Release。`0.x` 版本標記為預覽版。安裝程式目前未簽章，擴充功能也未經商店發佈。

## 提交變更

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
