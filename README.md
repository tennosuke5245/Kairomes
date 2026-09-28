# Kairomes

**The pathway between AI and your machine.**

讓 ChatGPT 在你授權的本機專案中工作；工具動作看得見，執行權限由你決定。

Kairomes 透過 Secure MCP Tunnel 連接真正的 ChatGPT 網頁聊天。Desktop 管理本機工作台與連線；Chrome／Edge 側欄顯示動作、結果與核准。Kairomes 不讀取 ChatGPT 的 Cookie 或聊天 DOM，也不替你送出訊息。

> **目前狀態**：`0.1.0` · Windows 11 預覽版。Windows 安裝程式尚未簽章；macOS／Linux 的 Desktop 與真實 Tunnel 流程尚未完成實機驗證。

## 快速啟動

從 [GitHub Releases](https://github.com/tennosuke5245/Kairomes/releases) 下載 Windows 安裝程式與 `Kairomes-extension-v0.1.0.zip`。安裝 Desktop 後，將擴充功能 ZIP 解壓到固定資料夾；在 Chrome／Edge 擴充功能頁開啟開發人員模式，選「載入未封裝項目」，指向含有 `manifest.json` 的解壓資料夾。擴充功能 ZIP 不是商店安裝包，解壓資料夾需保留。

也可以從原始碼執行：準備 [Bun](https://bun.sh/docs/installation) 1.4.2 以上、Rust 1.89 以上、[Tauri v2 Windows 前置套件](https://v2.tauri.app/start/prerequisites/)（C++ Build Tools、WebView2、Rust MSVC toolchain），以及官方 `tunnel-client`。在 Kairomes 專案根目錄開啟 Windows CMD：

```cmd
bun.cmd install --frozen-lockfile
bun.cmd run build
bun.cmd run desktop
```

接著在 Desktop 完成三件事：

1. 到「專案」新增要讓 ChatGPT 協作的資料夾。Kairomes 不會自動掛載目前目錄；解除掛載也不會刪除原始檔案。
2. 若從原始碼執行，在 Chrome／Edge 擴充功能頁將 `apps/extension/dist` **載入未封裝項目**。開啟 Kairomes 側欄並複製 Extension ID。
3. 到 Desktop「連線設定」貼上 Extension ID；將產生的短效配對連結貼回側欄。連結過期可直接重建。Runtime API Key 也在此頁儲存於 Windows Credential Manager。

關閉 Desktop 視窗會縮到系統匣；從系統匣選「結束 Kairomes」才會停止它啟動的服務。聊天仍在 chatgpt.com，側欄只負責呈現本機工作與核准。

## 連接 ChatGPT

1. 在 [OpenAI Platform Tunnel 設定](https://platform.openai.com/settings/organization/tunnels)建立 Tunnel，並關聯目標 ChatGPT workspace。建立／編輯需要 **Tunnels Read + Manage**；執行 client 或選用 Tunnel 需要 **Tunnels Read + Use**。ChatGPT developer mode 是獨立的工作區權限。
2. 從[官方 Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)取得 `tunnel-client`，以 `tunnel-client help quickstart` 核對版本，建立名為 `kairomes` 的 profile。下例的路徑與 Tunnel ID 要換成自己的值；手動執行 client 時，依官方指示在同一個 CMD 工作階段暫時提供 `CONTROL_PLANE_API_KEY`：

   ```cmd
   tunnel-client init ^
     --sample sample_mcp_stdio_local ^
     --profile kairomes ^
     --tunnel-id tunnel_YOUR_ID ^
     --mcp-command "bun run C:/path/to/Kairomes/apps/cli/src/main.ts serve --attach --stdio"

   tunnel-client doctor --profile kairomes --explain
   ```

3. Desktop 會使用此 profile 管理 Tunnel。在 ChatGPT 建立 developer-mode app，連線類型選 Tunnel；實際呼叫 `workspace_list`，確認本機工作台收到請求。若工具清單仍是舊版，在 ChatGPT Connector 設定按「重新整理」。

Runtime API Key、Tunnel 設定、配對連結與本機審批網址都不應貼進聊天或提交到 Git。本機工作台 URL 也不是可公開填入 ChatGPT 的 MCP endpoint。Kairomes 本身不呼叫 OpenAI 模型 API；Tunnel client 使用自己的 runtime credential。

## 可以做什麼

| 能力 | 使用方式 |
|---|---|
| 專案與檔案 | 列出已掛載專案、讀取與搜尋有範圍限制的工作區檔案。 |
| 結構化修改 | 先讀檔案版本，再提出修改；在側欄看摘要或 diff，核准後會重新檢查版本。 |
| 命令與終端機 | 一次性命令回報實際結束碼；互動終端機有時限，兩者執行前須取得相應本機權限。 |
| 圖片預覽 | 預覽工作區內已存在的 PNG／JPEG／WebP；ChatGPT 圖片直接匯入本機目前暫停。 |
| 下游 MCP | 由本機使用者在側欄「設定 → MCP 整合」掛載與停用 server；模型不能修改掛載設定。 |

### 操作權限

| 模式 | 自動允許 |
|---|---|
| 逐步確認 | 不自動執行，逐筆在可信側欄核准。 |
| 檔案自主 | 工作區內、通過版本檢查的結構化檔案變更。 |
| 全自主 | 在選定期限內允許檔案變更、主機命令與終端機；可隨時收回。 |

全自主期限可選 15 分鐘、1 小時、4 小時或直到手動收回；配對失效、工作區卸載或 app 關閉也會使授權失效。命令與終端機擁有主機使用者權限，可以存取工作區外與網路，**不是 OS sandbox**。使用前請閱讀 [安全邊界與回報方式](SECURITY.md)。

## 名字與方向

**Kairo（回路／かいろ）＋ Hermes（希臘神話中的使者之神）**，組成了 Kairomes。它想成為「AI 與本機世界之間的回路使者」：讓請求、核准與結果沿著一條可見、可控的路徑往返。

目前這條路徑以 ChatGPT 與本機專案協作為核心，另有選用的 Codex CLI 唯讀交接預覽。讓工作脈絡能在不同 coding agents 之間延續、**讓工作不綁定單一 Agent**，是長期方向；目前不會自動接手其他 Agent 的工作或轉移權限。

## 開發與進階入口

```cmd
bun.cmd run check
bun.cmd run desktop:check
bun.cmd run kairomes --help
```

`check` 涵蓋建置、型別、Biome 與測試；`desktop:check` 再驗證 sidecar、Vite 和 Rust。

Desktop 是日常入口。Headless／伺服器模式可先執行 `bun.cmd run app --port 0`，再於同一作業系統、同一使用者與相同 `--data-dir` 的另一個 CMD 視窗執行 `tunnel-client run --profile kairomes`；profile 會自行啟動 `serve --attach --stdio` relay。`bun.cmd run companion` 與 `bun.cmd run preview` 保留給開發及復原情境。選用的 `kairomes handoff` 唯讀交接指令才需要 Codex CLI。

`bun.cmd run build:desktop` 可建立未簽章的 Windows NSIS 安裝程式；`bun.cmd run package:extension` 可建立擴充功能 ZIP。一般使用仍需使用者自行具備 ChatGPT、Tunnel 與 developer mode 的存取條件；本機 `doctor` 成功不代表雲端連線已通過。

參與開發請讀 [貢獻指南](CONTRIBUTING.md)與[社群行為準則](CODE_OF_CONDUCT.md)。Kairomes 程式碼採 [MIT 授權](LICENSE)；安全問題請依 [SECURITY.md](SECURITY.md) 私密回報。專案維護者已確認 K 標誌與平台圖示可隨專案公開散布。

Kairomes 是獨立開源專案，未獲 OpenAI 關聯或背書。
