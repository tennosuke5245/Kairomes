<div align="center">
  <img src="apps/desktop/src-tauri/app-icon.svg" width="104" alt="Kairomes K 標誌">
  <h1>Kairomes</h1>
  <p><strong>The pathway between AI and your machine.</strong></p>
  <p>讓 ChatGPT 在你授權的本機專案中工作；進度看得見，修改與執行由你決定。</p>
  <p>
    <a href="https://github.com/tennosuke5245/Kairomes/actions/workflows/ci.yml"><img src="https://github.com/tennosuke5245/Kairomes/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI 狀態"></a>
    <a href="https://github.com/tennosuke5245/Kairomes/releases"><img src="https://img.shields.io/github/v/release/tennosuke5245/Kairomes?include_prereleases&amp;label=preview" alt="最新預覽版"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2d6a4f" alt="MIT 授權"></a>
  </p>
  <p><a href="#安裝與首次連線">安裝指南</a> · <a href="#日常操作">操作手冊</a> · <a href="#安全邊界">安全邊界</a></p>
</div>

Kairomes 由 **Desktop 常駐程式、本機工作台與 Chrome／Edge 側欄**組成。ChatGPT 的工具請求經由 OpenAI Secure MCP Tunnel 送到本機；側欄顯示進度與需要你處理的核准。Kairomes 不讀取 ChatGPT Cookie 或聊天 DOM，也不替你送出對話訊息。

> **目前版本：0.1.1 Windows 11 預覽版。** 安裝程式尚未簽章；擴充功能需手動載入。macOS／Linux Desktop 與真實 Tunnel 流程尚未完成實機驗證。

## 你可以做什麼

- **選擇工作範圍**：掛載資料夾本身不會整批複製或上傳；ChatGPT 能列出、讀取及搜尋你掛載的專案，工具讀取結果會經 Tunnel 傳給 ChatGPT。
- **看見正在發生的事**：側欄顯示工具動作、結果、檔案變更摘要與核准；Desktop 新增或解除掛載後，專案清單會自動同步。
- **自己決定執行權限**：結構化檔案修改、一次性命令與終端機依你選擇的模式核准；需要時可撤回授權。
- **擴充工作流程**：可選用下游 MCP 工具與檔案圖片預覽；掛載與工具開關仍由本機使用者管理。

## 安裝與首次連線

### 事前準備

- **Windows 11**，以及 Chrome 或 Edge。從 [Kairomes Releases](https://github.com/tennosuke5245/Kairomes/releases) 取得 Windows 安裝程式與 `Kairomes-extension-v0.1.1.zip`。
- **官方 `tunnel-client`**：從 [OpenAI 的最新版本](https://github.com/openai/tunnel-client/releases/latest)下載完整 Windows client，將 `tunnel-client.exe` 加入 PATH；在 PowerShell 執行 `tunnel-client help quickstart` 確認可用。Kairomes 安裝包不包含這個程式。
- **OpenAI 存取權限**：需要可使用的 ChatGPT developer mode，以及 Platform Tunnel 權限。建立或編輯 Tunnel 需要 **Tunnels Read + Manage**；執行 client 或選擇 Tunnel 需要 **Tunnels Read + Use**。ChatGPT developer mode 是另外授予的工作區權限。詳見[官方 Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

### 1. 安裝 Desktop 與側欄

安裝 Kairomes Desktop，開啟後先到「專案」掛載一個想使用的資料夾。本機工作台此時就會啟動；Desktop 會提供安裝版的本機 MCP 指令。

將擴充功能 ZIP 解壓到固定資料夾。在 Chrome／Edge 的擴充功能頁啟用開發人員模式，選「載入未封裝項目」，指向含有 `manifest.json` 的解壓資料夾。請保留該資料夾；ZIP 本身不是商店安裝包。

### 2. 建立一次性的 Tunnel profile

到 [OpenAI Platform Tunnel 設定](https://platform.openai.com/settings/organization/tunnels)建立 Tunnel，記下 Tunnel ID，並將它關聯到要使用的 ChatGPT workspace。取得供 `tunnel-client` 執行的 Runtime API Key。

在 Kairomes Desktop 的「連線設定」按「複製指令」。它會複製已安裝常駐程式的本機 MCP 指令，不含金鑰。在 **PowerShell** 執行下列命令；第一行出現提示後，貼上剛複製的指令並按 Enter。把範例 Tunnel ID 換成你的值：

~~~powershell
$relay = Read-Host "貼上 Kairomes 的本機 MCP 指令"
if ($PSVersionTable.PSVersion -lt [version]'7.3' -or $PSNativeCommandArgumentPassing -eq 'Legacy') {
  $relay = $relay.Replace('"', '\"')
}
tunnel-client init `
  --sample sample_mcp_stdio_local `
  --profile kairomes `
  --tunnel-id tunnel_YOUR_ID `
  --mcp-command $relay
~~~

相容處理會讓 Windows 內建 PowerShell 5.1 與 PowerShell 7 正確傳入含空格的安裝路徑。`init` 會檢查 sidecar 執行檔路徑是否可用；稍後啟動 Tunnel 時，本機 Host 才需要執行。複製指令使用 Windows 可辨識的正斜線路徑；請勿改回反斜線。若已有 `kairomes` profile，請先用 `tunnel-client profiles edit kairomes` 檢查原設定，避免覆寫自訂內容。

### 3. 讓 Desktop 管理連線

在 Desktop「連線設定」儲存 Runtime API Key。金鑰由 Windows Credential Manager 保管；Desktop 會重新啟動本機 Host，並在背景執行 `tunnel-client run --profile kairomes`。往後開啟 Desktop 就會管理這個程序，**不必每次手動在終端機執行 `tunnel-client run`**。若 Tunnel 顯示停止或失敗，可按「啟動安全連線」並查看「疑難排解」。

點擴充功能圖示開啟側欄，複製 Extension ID 並貼到 Desktop「連線設定」；再將 Desktop 產生的兩分鐘配對連結貼回側欄。瀏覽器詢問時，允許 Kairomes 連接本機 `127.0.0.1`，側欄才能顯示狀態與核准。配對連結只給本機側欄使用，不要貼進 ChatGPT。

### 4. 在 ChatGPT 驗證

在 ChatGPT 建立 developer-mode app，連線類型選 **Tunnel**，選擇剛建立的 Tunnel。實際呼叫 `workspace_list`：應取得 Desktop 掛載的專案；側欄也應顯示專案名稱與後續動作。若工具清單尚未更新，到 ChatGPT Connector 設定按「重新整理」。

## 日常操作

| 想做的事 | 操作 |
|---|---|
| 開始工作 | 開啟 Kairomes Desktop；已設定 Runtime API Key 與 profile 時，Host 會啟動並管理官方 `tunnel-client`。 |
| 加入或解除專案 | 在 Desktop「專案」操作；已開啟的側欄專案清單會自動同步。解除掛載不會刪除原始檔案。 |
| 暫時收起視窗 | 關閉 Desktop 視窗會縮到系統匣，背景連線繼續執行。 |
| 完全停止 | 從系統匣選「結束 Kairomes」，停止它啟動的本機服務與 Tunnel。 |
| 查看問題 | 到 Desktop「疑難排解」確認 Host、`tunnel-client` 與 Connector 狀態；不要公開貼出含本機路徑或憑證的診斷紀錄。 |
| 已有手動啟動的 Host | 先結束該程序，再由 Desktop 啟動並管理 Host；Desktop 連上既有 Host 時不會替它啟動 Tunnel。 |

**更新預覽版**：先從系統匣完全結束 Kairomes，再安裝新版 Desktop。將新版擴充功能 ZIP 解壓到原本的固定資料夾，於擴充功能頁按「重新載入」；若 Extension ID 改變，請重新配對。保留原本的 Tunnel profile 與本機專案設定即可。

## 安全邊界

Kairomes 的內建檔案工具以已掛載工作區的 opaque ID 與相對路徑定位檔案；掛載、核准與權限設定由可信本機介面管理。你可以選擇：

| 模式 | 自動允許 |
|---|---|
| 逐步確認 | 不自動執行，逐筆在側欄核准。 |
| 檔案自主 | 工作區內且通過版本檢查的結構化檔案變更。 |
| 全自主 | 在選定期限內允許檔案變更、主機命令與終端機；可隨時收回。 |

全自主期限可選 15 分鐘、1 小時、4 小時或直到手動收回；配對失效、工作區卸載或 app 關閉也會使授權失效。**命令與終端機使用主機使用者權限，不是 OS sandbox**，可能存取工作區外與網路。使用前請閱讀 [SECURITY.md](SECURITY.md)。Runtime API Key、Tunnel 設定與配對連結不要貼進聊天或提交到 Git；本機工作台 URL 也不是可公開填入 ChatGPT 的 MCP endpoint。

Kairomes 本身不呼叫 OpenAI 模型 API。這是獨立開源專案，未獲 OpenAI 關聯或背書；開源程式碼與個人 developer-mode 使用不代表已在 ChatGPT 公開商店上架。

## 從原始碼執行

安裝版不需要 Bun 或 Rust。若要參與開發，請準備 [Bun](https://bun.sh/docs/installation) 1.4.2 以上、Rust 1.89 以上，以及 [Tauri v2 的 Windows 前置套件](https://v2.tauri.app/start/prerequisites/)：

~~~powershell
bun install --frozen-lockfile
bun run build
bun run desktop
~~~

`bun run check` 會執行建置、型別、Biome 與測試；`bun run desktop:check` 再檢查 sidecar、Vite 與 Rust。`bun run package:extension` 建立擴充功能 ZIP；`bun run build:desktop` 建立未簽章 NSIS 安裝程式。

Headless／伺服器模式需先結束 Desktop 或既有 Host，再執行 `bun run app --port 0 --extension-id YOUR_EXTENSION_ID`。另為 `bun run kairomes serve --attach --stdio` 建立指向同一資料目錄的 Tunnel profile；如有自訂 `--data-dir`，工作台與 relay 都需使用相同值。此模式要自行管理程序，並安全地提供 `CONTROL_PLANE_API_KEY` 環境變數給 `tunnel-client run`；Desktop 憑證保管庫不會替手動終端機注入金鑰。Desktop 的 profile 指向安裝版 sidecar，沒有安裝該執行檔時請勿直接沿用。`bun run companion` 與 `bun run preview` 主要供開發及復原使用。選用的 `kairomes handoff` 唯讀交接預覽才需要 Codex CLI。

## 名字與方向

**Kairo（回路／かいろ）＋ Hermes（希臘神話中的使者之神）**，組成了 Kairomes。它想成為「AI 與本機世界之間的回路使者」：讓請求、核准與結果沿著可見、可控的路徑往返。

目前以 ChatGPT 與本機專案協作為核心，另有選用的 Codex CLI 唯讀交接預覽。讓工作脈絡在不同 coding agents 間延續、**讓工作不綁定單一 Agent**，是長期方向；目前不會自動接手其他 Agent 的工作或轉移權限。

## 參與專案

請讀[貢獻指南](CONTRIBUTING.md)與[社群行為準則](CODE_OF_CONDUCT.md)。程式碼採 [MIT 授權](LICENSE)；安全問題請依 [SECURITY.md](SECURITY.md) 私密協調。專案維護者已確認 K 標誌與平台圖示可隨專案公開散布。
