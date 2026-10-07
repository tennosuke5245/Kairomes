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

> **原始碼版本 0.3.0**：新介面與深色模式、ChatGPT 圖片匯入、唯讀 Git 與批次讀檔工具。現有下載仍為 [v0.1.4](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.1.4)；新版可依[貢獻指南](CONTRIBUTING.md)建置，變更見[更新紀錄](CHANGELOG.md)。Windows 安裝程式尚未簽章，側欄需手動載入。

## 功能

- **使用專案檔案**：掛載不會整包上傳；ChatGPT 列出、讀取、一次讀多個檔案、依檔名尋找或搜尋內容時，結果經 Tunnel 傳回。
- **Git 唯讀檢視**：ChatGPT 可查看分支、變更清單、差異與最近 commit；不執行儲存庫設定的程式，也不連網。
- **保存 ChatGPT 圖片**：把對話中的圖片存成專案內的新檔，每張都先在側欄預覽並核准。
- **查看操作與成果**：側欄與工作台列出待確認、執行中與最近的工作；差異、圖片與命令輸出可固定閱讀。
- **管理權限**：檔案修改、命令與終端機可逐次核准，也可限時自主；拒絕時可附原因讓 ChatGPT 調整。
- **加入 MCP**：在側欄管理本機 stdio 或遠端 HTTP 服務；需要 OAuth 的服務由系統瀏覽器登入。
- **Desktop 儀表板**：總覽列出需注意事項與專案；首次設定有六步清單，疑難排解可複製不含私人資料的診斷摘要。
- **從 Codex 接續**：選取同一專案的紀錄或手動摘要，核對後複製到 ChatGPT。

Desktop、側欄與工作台跟隨系統的淺色或深色主題；在 ChatGPT 內則跟隨 ChatGPT。

## 安裝

### 事前準備

- Windows 11、Chrome 或 Edge，以及 [Kairomes 安裝程式與側欄 ZIP](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.1.4)。
- [官方 `tunnel-client`](https://github.com/openai/tunnel-client/releases/latest)：另行安裝完整 Windows client，將 `tunnel-client.exe` 加入 PATH；可用 `tunnel-client help quickstart` 確認。
- OpenAI 權限：ChatGPT developer mode 需另外開啟；Platform 建立 Tunnel 需 **Tunnels Read + Manage**，使用時需 **Tunnels Read + Use**。詳見[官方指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

### 1. 安裝 Desktop 與側欄

安裝並開啟 Kairomes Desktop。「總覽」會列出六個設定步驟，依序完成即可；第一步是加入一個專案資料夾。

解壓側欄 ZIP；在 Chrome／Edge 擴充功能頁開啟開發人員模式，選「載入未封裝項目」，指定含 `manifest.json` 的資料夾。之後請保留該資料夾。

### 2. 建立一次性的 Tunnel profile

到 [OpenAI Platform](https://platform.openai.com/settings/organization/tunnels)建立 Tunnel，將它連到要使用的 ChatGPT workspace，記下 Tunnel ID 並取得 Runtime API Key。

在 Desktop「總覽」的 Tunnel profile 步驟按「複製指令」（之後可在「連線設定 › 安全通道 › 進階」找到）。接著在 PowerShell 執行以下命令，依提示貼上指令，並替換 Tunnel ID：

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

在 Desktop 按「設定金鑰」並儲存 Runtime API Key。金鑰保存在 Windows Credential Manager；Desktop 會重新啟動 Host，由 Host 執行 `tunnel-client run --profile kairomes`。往後開啟 Desktop 即可，不必手動執行這個命令。

點擴充功能圖示（或按 `Alt+Shift+K`）開啟側欄，將 Extension ID 貼到 Desktop「連線設定 › 瀏覽器側欄」並按「儲存並配對」，再按「複製連結」貼回側欄。瀏覽器詢問時，允許連接本機 `127.0.0.1`。配對連結在 Desktop 只以遮蔽方式顯示並倒數，兩分鐘內有效，到期或離開頁面即清除；請勿分享或貼進 ChatGPT。

### 4. 在 ChatGPT 驗證

在 ChatGPT 建立 developer-mode app，選 **Tunnel** 和剛建立的連線。請 ChatGPT「列出我的專案」（`workspace_list`），確認能看到已掛載專案；若工具清單或工作台沒更新，到 Connector 設定按「重新整理」。

## 日常操作

### Desktop

- 「總覽」列出需注意事項：待確認件數與最早到期、自主授權剩餘時間、最近一次 ChatGPT 呼叫。Desktop 只顯示數量，核准仍在側欄。
- 「專案」可加入、改名（只改 Kairomes 內的名稱）、在檔案總管中顯示或解除掛載，也可一次選取或拖入最多 20 個資料夾。解除掛載不會刪除檔案，側欄會同步更新。
- 關閉視窗會縮到系統匣（第一次會提示）。系統匣提示顯示「需確認 N」「已就緒」或「需要處理」，有待確認時圖示加紅點。要停止 Host 和 Tunnel，選「結束 Kairomes」；「重新啟動本機服務」會先說明會停止的工作再確認。
- 連線有問題時看「疑難排解」：每個檢查項目最多一個修正動作，「複製診斷摘要」只含狀態代碼、數量與版本。Tunnel 意外結束會自動重啟（5 分鐘內最多 3 次）；金鑰、profile 錯誤或找不到 tunnel-client 時不重啟，修正後再啟動。
- 若已有手動啟動的 Host，先結束它再開 Desktop，讓 Desktop 接手管理。

更新時先完全結束舊版，再安裝新版 Desktop。把新版側欄檔案覆蓋到原本載入的資料夾，並在擴充功能頁按「重新載入」；若 Extension ID 改變，需重新配對。

### 側欄與核准

頂列依序是連線圓點、專案切換、操作模式、「需確認」與設定；有工作執行時另顯示執行中數量。側欄連線時，擴充功能圖示的徽章顯示待確認數。選專案只篩選瀏覽，不改變 ChatGPT 工具目標或授權範圍。

操作模式分「逐步確認」「檔案自主」「全自主」。自主模式可選 15 分鐘、1 小時、4 小時或直到收回，頂列倒數且不會自動延長；授權適用同一實例的所有 ChatGPT 聊天。

點「需確認」開啟核准頁，分三個分頁：

- **需確認**：依到期順序排列。單件詳情先列風險，再列參數、工作目錄或完整差異；內容變更須重新審閱，截斷的差異、斷線或到期都不能核准。決定後自動開啟下一件，按鈕在開啟 0.7 秒後才可按。
- **執行中**：可停止命令與終端機。
- **最近**：唯讀紀錄，本機服務重啟後清空；結束碼 0 標為「已完成」，不代表整個任務已驗證。

「拒絕並說明原因…」可附一行原因（最多 200 字），ChatGPT 會讀到並據此調整；請勿貼金鑰或配對連結。回覆遺失時按「查詢狀態」核對原操作；結果未明前不重送。

### 工作台

側欄下方的工作台列出 ChatGPT 的動態，可用「全部／變更／命令／失敗」篩選。「即時」表示跟隨最新；捲動或開啟詳情時改為「已暫停跟隨」，按「有 N 則新動態 · 回到最新」或 `f` 恢復，`Esc` 返回。詳情保留執行時版本、結束碼、輸出截斷與到期狀態，可複製輸出、指令與路徑。工作台不能核准。

### 保存 ChatGPT 圖片

請 ChatGPT 把圖片存進專案，例如「把剛才的圖存成 images/cover.png」，再到側欄「需確認」開啟這筆匯入：

1. **ChatGPT 交出圖片**：側欄顯示預覽、儲存位置、格式、尺寸與 SHA-256，核對完成後按「匯入圖片」。
2. **顯示「等待圖片」**：在 ChatGPT 的圖片上按右鍵選「複製圖片」（Edge 為「複製影像」），回到側欄按 `Ctrl+V`；也可按「選擇檔案」或把圖片檔拖進側欄。核對完成後按「匯入圖片」。

不經 ChatGPT 也能匯入：在「需確認」按「匯入圖片」，或直接在側欄貼上、拖入圖片，選專案並確認「儲存為」後按「匯入」。在 ChatGPT 內開啟的工作台，若 ChatGPT 提供選檔功能，會出現「從 ChatGPT 選擇圖片」，之後仍在側欄核准。

- 每張圖片都要在側欄個別核准，即使開啟檔案自主或全自主。
- 只建立新檔，不覆寫既有檔案；儲存資料夾必須已存在。
- 只接受靜態 PNG、JPEG、WebP，最大 25 MiB、16 MP，每邊最多 16,384 px；副檔名須符合實際格式，側欄可替貼上的圖片轉檔。
- 「已匯入」表示已寫入並讀回確認；「結果待確認」表示寫入結果不明，請先檢查目的檔案，不要重新匯入。等待中的匯入 10 分鐘後到期，Host 重啟後不保留。

由 ChatGPT 交出檔案的途徑已實作，但尚未在真實 ChatGPT 驗證；貼上、選擇檔案與拖放隨時可用。

### 加入 MCP 與登入

點「設定 → MCP 整合 → 加入 MCP」，選擇本機程式或遠端網址；範本（遠端 HTTPS（OAuth）、Layer、mcp-remote 橋接、npx 套件）只預填表單。伺服器可按 `/` 搜尋、以「全部／已開啟／需處理」篩選，工具可個別開關；服務未連線或清單失敗時按卡片的「重試」。「移除」會先確認。

本機程式未指定工作目錄時，在 Kairomes 資料目錄的 `mcp-runtime` 資料夾啟動，不受 Kairomes 從哪裡啟動影響。伺服器需要特定資料夾時，「工作目錄」請填絕對路徑；舊設定的相對路徑不再使用，請移除後重新加入。

需要 OAuth 的遠端服務：填名稱與 MCP 網址 → 加入 → 按「登入」→ 在系統瀏覽器完成授權。取得最新工具清單後才顯示已連線；等待時可取消。登入保留於當次 Host，重啟需再登入；「清除登入」只清除本機資料。

目前支援公開 HTTPS、PKCE S256 與 DCR public client；內網 OAuth、CIMD 專用服務及跨重啟登入尚未支援。Layer 的網址為 `https://mcp.app.layer.ai/mcp`，使用者已回報修補後連線成功，詳見[相容性紀錄](docs/product-design/mcp-oauth-recovery.md)。既有 stdio 與靜態 Authorization 配置可繼續使用。

<details>
<summary>以 stdio 橋接 Layer</summary>

依 [Layer 官方設定](https://layer.ai/mcp)使用 `mcp-remote`：選「mcp-remote 橋接」範本，把 `<url>` 換成 Layer 網址。完成後的參數每行一個，啟動程式為 `npx.cmd`：

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

在 Desktop「專案」的卡片選單選「從 Codex 接續」，依「選擇來源 → 整理內容 → 預覽並複製」進行：選同一已掛載資料夾的 Codex 紀錄或手動摘要，填目標與下一步，停止來源、核對側欄權限，再審閱摘要及相關檔案，複製貼入 ChatGPT；複製前會再次檢查版本。

接續不自動發送訊息、移轉程序或授權。來源仍進行中、未知或版本不符時只能看草稿；讀取紀錄需本機 Codex CLI，手動摘要不需要。設計、檢查與待驗證範圍見[產品設計文件](docs/product-design/README.md)。

## 安全

模型不能自行掛載資料夾或核准操作。檔案與 Git 工具使用已掛載專案的 ID 與相對路徑；側欄提供逐次核准、檔案自主與全自主模式。全自主可限時或手動收回；**命令與終端機使用你的主機權限，不是 OS sandbox**，可能存取工作區外或網路。

不要分享 Runtime API Key、配對連結、本機工作台網址或診斷紀錄。詳見 [安全說明](SECURITY.md)。Kairomes 是獨立開源專案，未獲 OpenAI 背書，也未在 ChatGPT 公開商店上架。

## 開發與貢獻

原始碼建置、headless 模式與檢查指令見[貢獻指南](CONTRIBUTING.md)。另請閱讀[社群行為準則](CODE_OF_CONDUCT.md)；程式碼採 [MIT 授權](LICENSE)。
