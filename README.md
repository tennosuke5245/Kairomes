<div align="center">
  <img src="apps/desktop/src-tauri/app-icon.svg" width="104" alt="Kairomes K 標誌">
  <h1>Kairomes</h1>
  <p>Kairo（回路）＋ Hermes（使者）</p>
  <p><strong>The pathway between AI and your machine.</strong></p>
  <p>讓 ChatGPT 使用你選的本機專案，在側欄查看進度與核准操作。</p>
  <p>
    <a href="https://github.com/tennosuke5245/Kairomes/actions/workflows/ci.yml"><img src="https://github.com/tennosuke5245/Kairomes/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI 狀態"></a>
    <a href="https://github.com/tennosuke5245/Kairomes/releases"><img src="https://img.shields.io/github/v/release/tennosuke5245/Kairomes?include_prereleases&amp;label=preview" alt="最新預覽版"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2d6a4f" alt="MIT 授權"></a>
  </p>
  <p><a href="#安裝">安裝</a> · <a href="#日常操作">日常操作</a> · <a href="#安全">安全</a></p>
</div>

Kairomes 在 Windows 背景執行，透過 OpenAI Secure MCP Tunnel 接收 ChatGPT 的工具請求。它不讀取 ChatGPT Cookie 或聊天頁面，也不代你送出訊息。

> **0.1.3 預覽版**：目前提供 Windows 11 安裝程式，尚未簽章；側欄需手動載入。macOS／Linux Desktop 與真實 Tunnel 流程尚未完成實機驗證。

## 功能

- **使用專案檔案**：掛載不會整包上傳；ChatGPT 列出、讀取或搜尋時，工具結果會經 Tunnel 傳回。
- **查看操作**：側欄列出專案、工具進度、檔案變更與待核准事項。
- **管理權限**：檔案修改、命令與終端機可逐次核准，也可設定自主模式。

## 安裝

### 事前準備

- Windows 11、Chrome 或 Edge，以及 [Kairomes 安裝程式與側欄 ZIP](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.1.3)。
- [官方 `tunnel-client`](https://github.com/openai/tunnel-client/releases/latest)：另行安裝完整 Windows client，將 `tunnel-client.exe` 加入 PATH；可用 `tunnel-client help quickstart` 確認。
- OpenAI 權限：ChatGPT developer mode 需另外開啟；Platform 建立 Tunnel 需 **Tunnels Read + Manage**，使用時需 **Tunnels Read + Use**。詳見[官方指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

### 1. 安裝 Desktop 與側欄

安裝並開啟 Kairomes Desktop，到「專案」掛載一個資料夾。

解壓側欄 ZIP；在 Chrome／Edge 擴充功能頁開啟開發人員模式，選「載入未封裝項目」，指定含 `manifest.json` 的資料夾。之後請保留該資料夾。

### 2. 建立一次性的 Tunnel profile

到 [OpenAI Platform](https://platform.openai.com/settings/organization/tunnels)建立 Tunnel，將它連到要使用的 ChatGPT workspace，記下 Tunnel ID 並取得 Runtime API Key。

在 Desktop「連線設定」按「複製指令」。接著在 PowerShell 執行以下命令，依提示貼上指令，並替換 Tunnel ID：

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

請原樣貼上 Desktop 複製的指令；改用反斜線會讓 `tunnel-client init` 解析失敗。若已有 `kairomes` profile，先用 `tunnel-client profiles edit kairomes` 檢查設定。

### 3. 連線並配對側欄

在 Desktop「連線設定」儲存 Runtime API Key。金鑰保存在 Windows Credential Manager；Desktop 會重新啟動 Host，由 Host 執行 `tunnel-client run --profile kairomes`。往後開啟 Desktop 即可，不必手動執行這個命令。

點擴充功能圖示開啟側欄，將 Extension ID 貼到 Desktop「連線設定」，再把 Desktop 產生的配對連結貼回側欄。瀏覽器詢問時，允許連接本機 `127.0.0.1`。配對碼兩分鐘內有效；連結仍是私人資訊，請勿分享或貼進 ChatGPT。

### 4. 在 ChatGPT 驗證

在 ChatGPT 建立 developer-mode app，選 **Tunnel** 和剛建立的連線。呼叫 `workspace_list`，確認能看到已掛載專案；若工具清單沒更新，到 Connector 設定按「重新整理」。

## 日常操作

- 在 Desktop「專案」掛載或解除資料夾；側欄會同步更新，解除掛載不會刪除檔案。
- 關閉視窗會縮到系統匣；要停止 Host 和 Tunnel，從系統匣選「結束 Kairomes」。
- 連線有問題時看 Desktop「疑難排解」。若已有手動啟動的 Host，先結束它再開 Desktop，讓 Desktop 接手管理。

更新時先完全結束舊版，再安裝新版 Desktop。把新版側欄檔案覆蓋到原本載入的資料夾，並在擴充功能頁按「重新載入」；若 Extension ID 改變，需重新配對。

## 安全

模型不能自行掛載資料夾或核准操作。檔案工具使用已掛載專案的 ID 與相對路徑；側欄提供逐次核准、檔案自主與全自主模式。全自主可限時或手動收回；**命令與終端機使用你的主機權限，不是 OS sandbox**，可能存取工作區外或網路。

不要分享 Runtime API Key、配對連結、本機工作台網址或診斷紀錄。詳見 [安全說明](SECURITY.md)。Kairomes 是獨立開源專案，未獲 OpenAI 背書，也未在 ChatGPT 公開商店上架。

## 開發與貢獻

原始碼建置、headless 模式與檢查指令見[貢獻指南](CONTRIBUTING.md)。另請閱讀[社群行為準則](CODE_OF_CONDUCT.md)；程式碼採 [MIT 授權](LICENSE)。
