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

> **原始碼版本 0.2.0**：新增原生 MCP 登入、側欄改善與 Codex 接續。現有下載仍為 [v0.1.4](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.1.4)；新版可依[貢獻指南](CONTRIBUTING.md)建置，發版進度見[更新紀錄](CHANGELOG.md)。Windows 安裝程式尚未簽章，側欄需手動載入。

## 功能

- **使用專案檔案**：掛載不會整包上傳；ChatGPT 列出、讀取或搜尋時，工具結果會經 Tunnel 傳回。
- **查看操作與成果**：側欄列出專案、待核准事項及執行中的工作；檔案差異、圖片和命令輸出可固定閱讀。
- **管理權限**：檔案修改、命令與終端機可逐次核准，也可設定自主模式。
- **加入 MCP**：在側欄設定管理本機 stdio 或遠端 HTTP 服務；需要 OAuth 的服務由系統瀏覽器登入。
- **從 Codex 接續**：選取同一專案的紀錄或手動摘要，核對後複製到 ChatGPT。

## 安裝

### 事前準備

- Windows 11、Chrome 或 Edge，以及 [Kairomes 安裝程式與側欄 ZIP](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.1.4)。
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

### 側欄與核准

頂列可選專案、調整操作權限及開啟「設定」。連線圓點位於 K 標誌旁，詳細通道狀態在「設定 → 一般」；選專案只篩選瀏覽，不改變 ChatGPT 工具目標或授權範圍。

點「需確認」查看短佇列，再開啟單件參數、位置、期限或完整差異。內容變更須重新審閱，斷線或到期不能核准。回覆遺失時使用「查詢狀態」核對原操作；結果未明前不重送。

成果可固定閱讀，按「最新」恢復跟隨。畫面保留執行時版本、Exit code、輸出截斷與到期狀態；命令成功不代表整個任務已驗證。

### 加入 MCP 與登入

點「設定 → MCP 整合 → 加入 MCP」，選擇本機程式或遠端網址。工具可搜尋、篩選與開關；服務未連線或清單失敗時，按卡片的重試入口。

本機程式未指定工作目錄時，在 Kairomes 資料目錄的 `mcp-runtime` 資料夾啟動，不受 Kairomes 從哪裡啟動影響；參數中的相對路徑也以此為準。伺服器需要特定資料夾，或啟動程式寫成相對路徑（如 `./start.sh`）時，「工作目錄」請填絕對路徑。舊設定的相對工作目錄或相對啟動程式不再啟動，請解除掛載後重新加入。

需要 OAuth 的遠端服務：填名稱與 MCP URL → 儲存 → 按「登入」→ 在系統瀏覽器完成授權。取得最新工具清單後才顯示已連線；等待時可取消。登入保留於當次 Host，重啟需再登入；「清除登入」只清除本機資料。

目前支援公開 HTTPS、PKCE S256 與 DCR public client；內網 OAuth、CIMD 專用服務及跨重啟登入尚未支援。Layer 的網址為 `https://mcp.app.layer.ai/mcp`，使用者已回報修補後連線成功，詳見[相容性紀錄](docs/product-design/mcp-oauth-recovery.md)。既有 stdio 與靜態 Authorization 配置可繼續使用。

<details>
<summary>以 stdio 橋接 Layer</summary>

依 [Layer 官方設定](https://layer.ai/mcp)使用 `mcp-remote`。Windows 的啟動程式填 `npx.cmd`，參數每行一個：

```text
-y
mcp-remote@latest
https://mcp.app.layer.ai/mcp
--auth-timeout
120
```

`--auth-timeout` 是 [mcp-remote 的回呼等待秒數](https://github.com/punkpeye/mcp-remote/blob/main/README.md)。Kairomes 的 stdio 初始化最多等 120 秒，工具清單另等 10 秒；登入後仍失敗時可重新探索。設定已保存不等於 MCP 已連線。

</details>

### 從 Codex 接續（選用）

在 Desktop「專案」按「從 Codex 接續」，選擇同一已掛載資料夾的 Codex 紀錄或手動摘要。填目標與下一步，停止來源、核對側欄權限，再審閱摘要及相關檔案，複製貼入 ChatGPT；複製前會再次檢查版本。

接續不自動發送訊息、移轉程序或授權。來源仍進行中、未知或版本不符時只能看草稿；讀取紀錄需本機 Codex CLI，手動摘要不需要。設計、檢查與待驗證範圍見[產品設計文件](docs/product-design/README.md)。

## 安全

模型不能自行掛載資料夾或核准操作。檔案工具使用已掛載專案的 ID 與相對路徑；側欄提供逐次核准、檔案自主與全自主模式。全自主可限時或手動收回；**命令與終端機使用你的主機權限，不是 OS sandbox**，可能存取工作區外或網路。

不要分享 Runtime API Key、配對連結、本機工作台網址或診斷紀錄。詳見 [安全說明](SECURITY.md)。Kairomes 是獨立開源專案，未獲 OpenAI 背書，也未在 ChatGPT 公開商店上架。

## 開發與貢獻

原始碼建置、headless 模式與檢查指令見[貢獻指南](CONTRIBUTING.md)。另請閱讀[社群行為準則](CODE_OF_CONDUCT.md)；程式碼採 [MIT 授權](LICENSE)。
