<p align="center">
  <img src="apps/desktop/src-tauri/app-icon.svg" width="96" alt="Kairomes 標誌">
</p>

# Kairomes

繁體中文 · [English](README.en.md) · [日本語](README.ja.md)

[![CI](https://github.com/tennosuke5245/Kairomes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tennosuke5245/Kairomes/actions/workflows/ci.yml)
[![最新預覽版](https://img.shields.io/github/v/release/tennosuke5245/Kairomes?include_prereleases&label=preview)](https://github.com/tennosuke5245/Kairomes/releases)
[![MIT 授權](https://img.shields.io/badge/license-MIT-2d6a4f)](LICENSE)

Kairomes 讓 ChatGPT 能使用你電腦上的專案資料夾。

它在 Windows 背景執行，透過 OpenAI Secure MCP Tunnel 接收 ChatGPT 的請求。要改檔案、執行命令或存圖片時，會先在 Chrome／Edge 側欄問你，你按下核准才會動手。

Kairomes 不讀 ChatGPT 的 Cookie 或聊天頁面，也不會替你送出訊息。名字來自 Kairo（回路）和 Hermes（使者）。

> 目前狀態：原始碼是 0.3.0，可以下載的安裝程式還是 [v0.1.4](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.1.4)。想用新版請照[貢獻指南](CONTRIBUTING.md)自行建置，改了什麼見[更新紀錄](CHANGELOG.md)。安裝程式還沒簽章，側欄要手動載入。

## 可以做什麼

- 讓 ChatGPT 讀取、搜尋你指定的專案。資料夾不會整包上傳，只傳回 ChatGPT 要求的內容。
- 查看 Git 的分支、變更、差異和最近的 commit（只能看，不能改）。
- 把 ChatGPT 產生的圖片存進專案。每張圖都會先在側欄預覽，確認後才寫入。
- 在側欄核准或拒絕檔案修改和命令。拒絕時可以寫原因，ChatGPT 會照著調整。
- 也可以開一段時間的自主模式，讓 ChatGPT 不用每次都問。
- 在側欄加入其他 MCP 服務，本機程式或遠端網址都可以。
- 把 Codex 的工作整理成摘要，貼到 ChatGPT 接著做。

介面支援淺色和深色模式。

## 安裝

需要先準備：

- Windows 11，以及 Chrome 或 Edge。
- Kairomes 安裝程式和側欄 ZIP，在 [Releases](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.1.4) 下載。
- OpenAI 官方的 [`tunnel-client`](https://github.com/openai/tunnel-client/releases/latest)。安裝完整的 Windows 版，並把 `tunnel-client.exe` 加進 PATH。
- ChatGPT 開啟 developer mode。在 OpenAI Platform 建立 Tunnel 需要 Tunnels Read + Manage 權限，使用時需要 Tunnels Read + Use。詳見[官方說明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

### 1. 安裝 Desktop 和側欄

安裝並打開 Kairomes Desktop。「總覽」頁有六個設定步驟，照順序做就好，第一步是加入一個專案資料夾。

側欄的部分：把 ZIP 解壓縮，到 Chrome／Edge 的擴充功能頁打開「開發人員模式」，按「載入未封裝項目」，選有 `manifest.json` 的那個資料夾。之後這個資料夾不要刪。

### 2. 建立 Tunnel profile（只要做一次）

到 [OpenAI Platform](https://platform.openai.com/settings/organization/tunnels) 建立 Tunnel，連到你要用的 ChatGPT workspace。記下 Tunnel ID，並取得 Runtime API Key。

在 Desktop「總覽」的 Tunnel profile 步驟按「複製指令」。然後打開 PowerShell 執行下面這段，出現提示時貼上剛才複製的指令，並把 `tunnel_YOUR_ID` 換成你的 Tunnel ID：

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

複製的指令請原樣貼上，不要自己改成反斜線，否則會解析失敗。如果之前已經建過 `kairomes` profile，先用 `tunnel-client profiles edit kairomes` 檢查。

### 3. 連線並配對側欄

在 Desktop 按「設定金鑰」，存入 Runtime API Key。金鑰會存在 Windows 認證管理員裡。之後只要打開 Desktop，它就會自動連線，不用再手動跑 tunnel-client。

點擴充功能圖示（或按 `Alt+Shift+K`）打開側欄。把側欄的 Extension ID 貼到 Desktop「連線設定 › 瀏覽器側欄」，按「儲存並配對」，再按「複製連結」貼回側欄。瀏覽器問能不能連到本機 `127.0.0.1` 時，請允許。

配對連結兩分鐘後失效。不要分享給別人，也不要貼進 ChatGPT。

### 4. 在 ChatGPT 確認

在 ChatGPT 建立 developer-mode app，連線方式選 Tunnel 和剛才建立的那條。對 ChatGPT 說「列出我的專案」，看到你加入的資料夾就完成了。如果工具沒更新，到 Connector 設定按「重新整理」。

## 使用方式

裝好之後的日常操作寫在[操作指南](docs/usage.md)，包括：

- Desktop 的總覽、專案管理和疑難排解
- 側欄的核准方式和自主模式
- 工作台怎麼看 ChatGPT 做了什麼
- [保存 ChatGPT 圖片](docs/usage.md#保存-chatgpt-圖片)
- [加入 MCP 與登入](docs/usage.md#加入-mcp-與登入)
- 從 Codex 接續工作

## 安全

ChatGPT 不能自己加入資料夾，也不能自己核准操作，這兩件事只能由你在本機做。

要注意的是：命令和終端機是用你自己的 Windows 帳號權限執行，不是在沙盒裡。你核准的命令，或自主模式下執行的命令，都有可能碰到專案以外的檔案或連上網路。

Runtime API Key、配對連結、本機工作台網址和診斷紀錄都不要分享。更多細節見 [SECURITY.md](SECURITY.md)。

Kairomes 是獨立的開源專案，沒有獲得 OpenAI 背書，也沒有上架 ChatGPT 公開商店。

## 開發

建置方式和檢查指令見[貢獻指南](CONTRIBUTING.md)，參與前請先看[行為準則](CODE_OF_CONDUCT.md)。程式碼採用 [MIT 授權](LICENSE)。
