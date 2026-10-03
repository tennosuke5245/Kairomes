# 畫面證據索引

擷取與查閱日期：2026-10-02（Asia/Taipei）。Kairomes 基準 revision：`5edf3dcb61eb5021135ccf200f0aa7af97ddceb1`、版本 `0.1.4`。

## Kairomes 合成資料畫面

本次在 Codex in-app browser 擷取現行元件；JPEG 檔案均已重新讀取檢視，尺寸已以圖像 metadata 確認。沒有登入 ChatGPT、執行主機命令、啟動實際 Host／Tunnel、取得側欄憑證或匯入私人聊天。

| ID | 畫面 | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- | --- |
| K1 | 尚未配對 | [01-setup-400.jpg](01-setup-400.jpg)，400×900 | 現行 setup 結構、文字密度、窄版隱藏狀態 |
| K2 | 三件待核准 | [02-approvals-400.jpg](02-approvals-400.jpg)，400×900 | 真實 ApprovalPanel、浮層遮擋、必要資訊字級 |
| K3 | 展開 diff | [03-diff-400.jpg](03-diff-400.jpg)，400×900 | 查看差異、橫向捲動、核准動作位置 |
| K4 | 操作權限選單 | [04-access-400.jpg](04-access-400.jpg)，400×900 | 真實 AccessPanel 三模式、專案欄位與選單布局 |
| K5 | MCP 整合 | [05-settings-400.jpg](05-settings-400.jpg)，400×900 | 真實 McpPanel、整合／工具件數與信任提示 |
| K6 | 27 個工具展開 | [06-tools-400.jpg](06-tools-400.jpg)，400×900 | 長清單與雙重捲動區 |
| K7 | 本機操作動態 | [07-activity-400.jpg](07-activity-400.jpg)，400×900 | 現行 widget 的專案 rail、活動、完成狀態 |
| K8 | 檔案詳情 | [08-detail-400.jpg](08-detail-400.jpg)，400×900 | 窄版詳情覆蓋、返回與檔案檢查 |
| K9 | 較寬動態 | [09-activity-720.jpg](09-activity-720.jpg)，720×900 | 仍以單閱讀區呈現；不可推論所有 breakpoint 已測 |

建構方法：讀取原始 `sidepanel.html` 與 CSS，移除真實 `sidepanel.js`；setup 使用假的 Extension ID。核准與權限採 [approval-preview.ts](../../../tests/approval-preview.ts)，設定採 [settings-preview.ts](../../../tests/settings-preview.ts)。widget 直接 bundle [main.tsx](../../../apps/widget/src/main.tsx) 和原 CSS，僅以純合成 bridge 替換 `createBridge`：回傳一個假專案、兩筆已完成讀取事件、短檔案與空的程序／catalog。所有操作只改記憶體，伺服器只提供 GET 靜態頁。

因此可以研究目前元件的可見密度、展開與返回，但**不能**驗證 Extension 原生 `sidePanel` API、可信 Origin、實際配對、SSE 重連、指紋核准、主機程序、ChatGPT 宿主或 Tunnel。fixture 頁的返回設定／配對按鈕沒有接真實流程。圖片中的時鐘、路徑、指紋和命令皆為測試資料，並非實際驗證紀錄。當次暫存 harness 留於被 Git 忽略的 `test-results/product-design`，不作公開產品入口。

## 官方公開畫面

| ID | 圖片 | 來源與版本限制 |
| --- | --- | --- |
| O1 | [codex-official-01.jpg](codex-official-01.jpg)，1280×720 | [官方 Features](https://learn.chatgpt.com/docs/features) 頁內重建示意；非原生安裝版截圖 |
| O2 | [codex-official-02.jpg](codex-official-02.jpg)，1280×720 | [官方 Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) 的 Hand off 示意；同產品 Local／Worktree |
| A1 | [claude-official-01.jpg](claude-official-01.jpg)，1280×720 | [官方 web 示範影片](https://www.youtube.com/watch?v=s-avRazvmLg)；2025-10 發表時的畫面，詳細片段以研究稿為準 |
| A2 | [claude-official-02.jpg](claude-official-02.jpg)，1280×720 | [官方桌面改版影片](https://www.youtube.com/watch?v=rWaQSQEm_aY)；2026-04 版本示範，非十月實機 |

完整來源、畫面觀察與版本限制見 [Codex 研究](../codex-app-research.md) 與 [Claude 研究](../claude-code-research.md)。上述圖片是公開資料研究證據；不得包裝成當前私人 app 操作錄製。官方圖不作產品圖示、品牌資產或商業素材重用。

## 開發後的合成畫面

日期同為 2026-10-02；下表是工作目錄的新程式，與前述改版前基準分開保存。PNG 為 in-app browser 的原始截圖，尺寸以 metadata 確認；元件使用真實 UI，資料／IPC／bridge 使用合成 fixture。可重跑方式與路由見 [實作報告](../implementation.md#驗證與證據) 及 [preview-sidebar.ts](../../../scripts/preview-sidebar.ts)。沒有私人紀錄或憑證。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| N1 | [setup-400.png](implementation/setup-400.png)，400×900 | Extension ID、配對欄位、一個主動作、折疊取得方式；配對不會執行 |
| N2 | [approvals-10-400.png](implementation/approvals-10-400.png)，400×900 | 十件短佇列，由件數入口主動開啟；無自動堆疊浮層 |
| N3 | [command-400.png](implementation/command-400.png)，400×900 | 單次命令的 argv、解析執行檔、cwd、範圍與期限 |
| N4 | [terminal-360.png](implementation/terminal-360.png)，360×900 | shell 的工作區外／網路範圍與 15 分鐘語意，必要判斷資料保留 |
| N5 | [terminal-480.png](implementation/terminal-480.png)，480×900 | 同一 shell 詳情在較寬側欄的換行與操作位置 |
| N6 | [diff-400.png](implementation/diff-400.png)，400×900 | 完整差異與單件核准；資料是合成，沒有實際檔案套用 |
| N7 | [diff-200-equivalent.png](implementation/diff-200-equivalent.png)，400×900 | 200px CSS iframe × 2 縮放，標題／返回不被擠成逐字垂直；並非真瀏覽器 200% |
| N8 | [mcp-search-400.png](implementation/mcp-search-400.png)，400×900 | 一百項中搜尋一項、關閉設定、篩選；描述不常駐 |
| N9 | [widget-480.png](implementation/widget-480.png)，480×900 | 全名專案選擇與單閱讀區，沒有 initials rail；獨立 widget，非真正 sidePanel |
| N10 | [overview-paused-1200.png](implementation/overview-paused-1200.png)，1200×900 | 新活動存在，但概要／內容預覽仍固定原操作；測試按鈕不是產品 UI |
| N11 | [handoff-copied-1200.png](implementation/handoff-copied-1200.png)，1200×900 | 真實 HandoffFlow、mock 來源／核對與較短摘要；已複製只表示 browser clipboard 成功 |
| N12 | [handoff-stale-1200.png](implementation/handoff-stale-1200.png)，1200×900 | prepare 回報檔案失效後清除舊預覽／已核對，不保留可複製狀態 |

互動另驗證錯誤 MessageEvent origin／window／version 不改導覽、合法合成訊息才隱藏重複頂列；核准內容變更要重新審閱，截斷僅可拒絕，斷線／到期均停用；工具加入失敗保留欄位；過期結果只有短狀態與目前讀取入口。fixture 的有效訊息使用合成 MessageEvent，不能證明真正 Extension origin E2E。

這批仍未驗證原生 sidePanel、真實配對／SSE、ChatGPT／Tunnel、新版 Tauri 畫面、實際 200% zoom、對比數值、螢幕閱讀器或 D10 真人試用。後端邊界與失敗測試另記於實作報告；畫面截圖本身不證明主機命令、權限或來源生命週期通過。

## 第二輪修補的合成畫面

日期：2026-10-02。下列 PNG 擷取於 Chrome，使用真實元件加純合成邊界；Chrome 分頁不等於原生 sidePanel 或 Tauri。來源、路徑、狀態及輸出均為合成資料。有限互動與文字對比抽樣詳見 [續作紀錄](../continuation.md)。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| R1 | [approval-reconciled-400.png](continuation/approval-reconciled-400.png)，400×900 | 提交後回應遺失，唯讀查到 running；變更計數 1，沒有假失敗 alert |
| R2 | [mcp-uncertain-400.png](continuation/mcp-uncertain-400.png)，400×900 | 讀到原目錄仍停用新增，dialog 保留單句未知狀態與查詢；關閉後的鎖另由 DOM 驗證 |
| R3 | [mcp-reconciled-400.png](continuation/mcp-reconciled-400.png)，400×900 | 匹配的新 ID 出現後解除鎖；變更計數仍 1；不是實際 MCP 程序 |
| R4 | [inspector-820.png](continuation/inspector-820.png)，820×615 | Home 的 320px 實際摘要欄與窄版閱讀；ARIA 數值另以 DOM 核對 |
| R5 | [terminal-selection-1200.png](continuation/terminal-selection-1200.png)，1200×900 | 目前終端缺失後仍保留選擇，另一個 shell 未自動選中，停止停用；內容是合成輸出 |
| R6 | [handoff-unknown-1200.png](continuation/handoff-unknown-1200.png)，1200×900 | 未知來源即使勾完人工聲明仍不能複製，原因為單句 |
| R7 | [desktop-unmounted-1200.png](continuation/desktop-unmounted-1200.png)，1200×900 | 真 App 的合成解除掛載後草稿歸零；返回焦點在後續 DOM 確認 |
| R8 | [desktop-offline-1200.png](continuation/desktop-offline-1200.png)，1200×900 | 真 App 的合成離線撤銷核對、取消草稿、停用接續入口並返回專案焦點 |

圖上的測試控制與計數器不是產品 UI。SSE／fetch、Tauri invoke、終端 bridge 都由記憶體資料替換；後端與來源 child 的生命週期依自動化測試另驗，不能從截圖宣稱真帳號或原生流程通過。

## 第三輪的傳輸與閱讀畫面

日期：2026-10-02。以下 PNG 在 Chrome 分頁擷取，與原生 Extension 分開記錄。`/panel-http` 是真正 loopback HTTP／SSE、合成記憶體後端與替換 Chrome API；`/panel-flow` 替換 fetch／SSE；閱讀頁替換 widget bridge。測試路徑、ID、設定、命令與檔案均為合成資料；沒有安裝 Extension。完整驗收及限制見[第三輪驗證](../verification.md)。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| V1 | [http-reconciled.png](verification/http-reconciled.png)，400×900 | 真 HTTP 502 後唯讀對帳到執行中，合成變更數 1；非 TCP 遺失或真程序 |
| V2 | [http-offline.png](verification/http-offline.png)，400×900 | SSE EOF 後 MCP 新增停用；當時短提示被 catalog failure 覆寫成「結果待確認」，第四輪另修 |
| V3 | [http-invalid.png](verification/http-invalid.png)，400×900 | 401 後重新配對入口與停用控制；沒有自動換憑證 |
| V4 | [read-failed.png](verification/read-failed.png)，1200×900 | 重新讀取失敗保留原版本、內容與執行時來源 |
| V5 | [read-unmounted.png](verification/read-unmounted.png)，1200×900 | 跟隨摘要解除掛載後保留內容、版本與來源專案名；卸載狀態只說一次 |
| V6 | [read-unmounted-detail.png](verification/read-unmounted-detail.png)，1200×900 | 歷史詳情可閱讀，重新讀取與搜尋停用；未自動換到另一個專案 |
| V7 | [image-stale.png](verification/image-stale.png)，1200×900 | 歷史圖片版本已更新；一個重新讀取入口 |
| V8 | [image-current.png](verification/image-current.png)，1200×900 | 成功後才變更目前預覽與版本；圖片是 repository logo |
| V9 | [mcp-locked.png](verification/mcp-locked.png)，400×900 | 查到舊目錄與關閉 dialog 都不能解除未知鎖；合成變更數 1 |
| V10 | [mcp-reconciled.png](verification/mcp-reconciled.png)，400×900 | 完整配置身份符合後恢復操作；變更數仍 1，非真正 MCP 程序 |

截圖只能證明當時可見狀態，full config 不符／取消排隊 frame／reader child 清理由對應回歸測試支持。實際縮放、讀屏、完整對比、原生 sidePanel／Tauri／Codex、ChatGPT／Tunnel 與 D10 真人接續仍待驗收。分頁與 viewport override 已清理，合成伺服器已停止。

## 第四輪的身份與未決驗證

日期：2026-10-02。Chrome 合成分頁；沒有載入 Extension。結果／取消頁掛實際子面板、固定 promise 與透明 PNG；HTTP 頁使用真正 loopback transport、合成記憶體後端與 Chrome API stub。詳見[第四輪稽核](../completion-audit.md)，測試控制與計數不是產品 UI。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| A1 | [result-switch.png](completion-audit/result-switch.png)，1000×900 | A 已載入後切 B，B 只顯自己的載入狀態，沒有 A payload |
| A2 | [result-mismatch.png](completion-audit/result-mismatch.png)，1000×900 | 錯 ID 的 diff／command 被拒絕；合成 media 仍依自身讀取 |
| A3 | [result-late.png](completion-audit/result-late.png)，1000×900 | A 晚回覆不進 B；圖片建立 1／回收 1，B 仍等待自身內容 |
| A4 | [cancel-switched.png](completion-audit/cancel-switched.png)，990×891 | A 取消失敗後，B 不顯 A error；回 A 的錯誤歸屬另由 DOM 確認 |
| A5 | [handoff-count-clipped.png](completion-audit/handoff-count-clipped.png)，1200×900 | 只有 itemsTruncated 仍顯一個範圍有限標記；未複製或發送 |
| A6 | [approval-pending-unknown.png](completion-audit/approval-pending-unknown.png)，400×900 | 同 pending 與不相關 SSE 後維持決策鎖，變更數 1、單一未知提示 |
| A7 | [approval-late-offline.png](completion-audit/approval-late-offline.png)，400×900 | 觀察 held list、EOF，再送回成功 list，仍上次快照／權限待確認；操作停用 |
| A8 | [approval-settled.png](completion-audit/approval-settled.png)，400×900 | 同件變 running 才清未知；另一件 pending 保留，變更數仍 1 |

截圖不證明 private source、真程序、原生 sidePanel、帳號 E2E 或真人成效。核心權限與核准入口 computed style 為 14px；完整對比／讀屏仍另驗。合成分頁、viewport override 與伺服器在本輪結束時清理。

## 可讀性修補畫面

日期：2026-10-02。Chrome 合成分頁，資料與 ID 固定；沒有載入 Extension。原元件、CSS 與 renderer 依[可讀性報告](../readability-audit.md)驗證。以下六張 PNG 是修補後的可見狀態，背景／字級／焦點的數值另保存在量測 JSON。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| L1 | [setup-400.png](readability-audit/setup-400.png)，400×900 | 配對提示使用既有 muted；沒有填入配對連結 |
| L2 | [tools-400.png](readability-audit/tools-400.png)，400×900 | 設定導覽／狀態／操作 14px；工具按需展開，neutral 風險標籤可讀 |
| L3 | [command-400.png](readability-audit/command-400.png)，400×900 | 固定命令的 cwd／截斷提示、深色 console stderr；沒有執行主機命令 |
| L4 | [handoff-focus-400.png](readability-audit/handoff-focus-400.png)，400×900 | 來源與核對文字 14px；真 Tab 到首個勾選框的實色焦點；沒有複製 |
| L5 | [mcp-dark-error-400.png](readability-audit/mcp-dark-error-400.png)，400×900 | 真 dark media query 下的錯誤正文／通知；記憶體 SDK adapter，圖片為透明 1×1 PNG |
| L6 | [desktop-pending-1200.png](readability-audit/desktop-pending-1200.png)，1200×900 | 固定 ChatGPT 待完成資訊不再整節點淡化；不是實際帳號連線 |

[measurements.json](readability-audit/measurements.json) 記錄 14 組狀態、197 個文字元素紀錄與 15 個窄版尺寸；gradient、opacity、disabled 與未解背景分開。淺色及 reduce-motion 由 fixture 選 CSS 分支；真縮放、OS 偏好、宿主主題、讀屏與完整對比仍待驗。測試分頁、viewport override 與伺服器已清理。

## D10 材料與入口檢查

日期：2026-10-02。Chrome 合成分頁，以下 JPEG 由 Agent 操作，不計真人成功或耗時；方法、材料限制與最終 checks 見[試用準備紀錄](../usability-test.md#7-工程準備紀錄)。沒有安裝 Extension、複製到剪貼簿或送出 ChatGPT。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| U1 | [approval-command-400.jpg](study-materials/approval-command-400.jpg)，400×900 | 兩長名稱專案各五件；單件有相對應專案、argv、cwd、範圍與單次期限 |
| U2 | [approval-shell-400.jpg](study-materials/approval-shell-400.jpg)，400×900 | 合成命令已結束，shell 核准後在既有執行中入口；沒有啟動程序 |
| U3 | [file-entry-400.jpg](study-materials/file-entry-400.jpg)，400×900 | 修正首次「檔案」入口，清單正常載入 |
| U4 | [file-current-400.jpg](study-materials/file-current-400.jpg)，400×900 | 主持更新後讀取目前合成文字檔版本 5 |
| U5 | [diff-history-400.jpg](study-materials/diff-history-400.jpg)，400×900 | 相同專案仍保留套用時版本 1→2，不把歷史改成目前版本 |
| U6 | [artifact-current-400.jpg](study-materials/artifact-current-400.jpg)，400×900 | 歷史圖片原可載入；更新後重新讀取顯目前預覽／版本 2，透明合成圖片不驗尺寸或品質 |
| U7 | [handoff-recheck-1200.jpg](study-materials/handoff-recheck-1200.jpg)，1200×1641 | 摘要保留完成／未驗欄位及兩檔；重新核對更新 hash 並清分享審閱，未複製 |
| U8 | [handoff-incomplete-1200.jpg](study-materials/handoff-incomplete-1200.jpg)，1200×1641 | 缺少 README.md 為 unknown／基準不完整；已審閱仍不能複製，來源 coverage 分開 |

另以 DOM 確認參與者頁沒有主持控制或 probe；HTTP 延遲 catalog 的串流中斷路徑會取消查詢，舊資料維持上次快照、操作停用，服務恢復後取得新快照。未取消查詢的晚到失敗由 HTTP 回歸支持，沒有宣稱它抵達已取消的 UI。所有分頁與 viewport override 已清理，合成服務已停止；真人記錄保持未測。

## 核心流程修補

日期：2026-10-03。Chrome 合成分頁；原 React widget 配固定 callback bridge，Extension 元件配記憶體 HTTP／SSE 工作台，沒有真 SDK／宿主、grant、檔案操作或訊息傳送。方法與結果見[核心流程修補](../core-flow-fixes.md)。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| C1 | [host-viewer-order.jpg](core-flow/host-viewer-order.jpg)，1676×1256 | B 成果已取代等待中的 A；放行 A 後不覆蓋由 DOM 操作確認。連線標籤為合成 host 分支，非 ChatGPT 實際連線 |
| C2 | [expired-source-400.jpg](core-flow/expired-source-400.jpg)，400×900 | 全部本機操作中的過期詳情保留原 A 專案名稱，只有「瀏覽目前檔案」一個動作 |
| C3 | [access-recovered-400.jpg](core-flow/access-recovered-400.jpg)，400×900 | 授權未知結果收回後回到「逐步確認」；僅支持恢復後布局。查詢、跨專案、重新載入、收回與晚回覆整段在 662×687 由 HTTP／DOM 操作確認 |

H1 取消由對應失敗案例驗證，授權晚回覆另有合成 HTTP 操作；不以截圖宣稱真來源／權限或帳號流程成功。

同日補驗重新配對布局：復原按鈕移到連線狀態旁，320／360／400／480／720／721／869px 無橫向溢出，正常連線時隱藏；Tab 可抵達並顯示 2px 焦點，點擊回到配對頁。使用 `/panel-flow` 合成資料，沒有操作真配對；替身撤銷未實作而保留錯誤提示，不宣稱伺服器撤銷成功。`bun run check` 296 項測試通過。

- [400px 狀態與按鈕](core-flow/re-pair-layout-400.jpg)，400×180，擷取頂列與工作台上緣。
- [寬版狀態與按鈕](core-flow/re-pair-layout-wide.jpg)，869×600。

同日補驗 MCP 新增回覆遺失與通知：見 [MCP 連線與恢復](../mcp-connection-recovery.md)。使用實際側欄協調器與假 fetch／SSE，未執行真 MCP 或 OAuth。

- [通知寬版](core-flow/mcp-notice-wide.jpg)，869×900。
- [通知窄版](core-flow/mcp-notice-400.jpg)，400×900。
- [核對後恢復控制](core-flow/mcp-recovered-400.jpg)，400×900；設定已保存但連線失敗，未知新增結果已核對，通知高度為零。

## MCP OAuth 第一階段

日期：2026-10-03。實際 Extension 卡片與協調器配純記憶體 OAuth fixture，沒有真帳號、註冊 client、Host 或第三方工具。自動檢查另有真 Workbench／loopback listener 與 SDK 配合成 HTTPS adapter，見 [實作紀錄](../mcp-oauth-implementation.md)。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| O1 | [oauth-waiting-400.jpg](core-flow/oauth-waiting-400.jpg)，400×900 | 等待登入的一行狀態及取消；其他 MCP 可操作 |
| O2 | [oauth-connected-400.jpg](core-flow/oauth-connected-400.jpg)，400×900 | 合成授權後最新兩工具清單；不是 Layer 已連線證據 |
| O3 | [oauth-long-360.jpg](core-flow/oauth-long-360.jpg)，360×675 JPEG | 80 字名稱與長登入網域換行；CSS viewport 寬與溢出另以 DOM 核對 |

360／400／480 CSS px 與 200 CSS px 等效內容寬度另以 DOM 尺寸抽查；不宣稱真 200% 瀏覽器縮放、讀屏或原生側欄帳號流程。合成頁操作與自動化測試不能當作多人使用研究。

## Layer 相容性與回呼修補

日期：2026-10-03。卡片以真 Extension 元件及純記憶體 fixture 顯示清單失敗；回呼頁直接使用產品的靜態 HTML 產生器。Chrome 分頁沒有帳號或真 OAuth，公開清單相容性由獨立的真 SDK／Host 查核支持，見 [修補紀錄](../mcp-oauth-recovery.md)。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| O4 | [oauth-tools-error-fixed-400.jpg](core-flow/oauth-tools-error-fixed-400.jpg)，400×900 JPEG | 合成 schema 超限，連線詳情與管理展開；重試、清除登入、解除掛載皆為 36px 高度 |
| O5 | [oauth-result-authorized.jpg](core-flow/oauth-result-authorized.jpg)，720×480 JPEG | 精簡深色回呼卡片，只稱授權完成及要求重試，沒有假稱工具已可用 |

卡片 360／400／480 CSS px 及 200 CSS px 等效內容寬度均無橫向溢出；回呼頁另抽查 360 CSS px。不是原生側欄、真縮放或真人帳號完成證據。分頁、viewport override 與合成服務已清理。

## 頂列與設定入口

日期：2026-10-03。真側欄元件／協調器、純記憶體資料及假 Chrome API；沒有真 Host 或 Extension 安裝。原生側欄的使用者回報與本輪合成驗收分開，詳見 [核心流程紀錄](../core-flow-fixes.md#頂列與設定入口修補)。

| ID | 圖片／尺寸 | 支持的觀察 |
| --- | --- | --- |
| C4 | [settings-entry-720.jpg](core-flow/settings-entry-720.jpg)，720×240 JPEG | 狀態改為標誌旁圓點，右側有明確「設定」；正常頂列一行 |
| C5 | [settings-entry-400.jpg](core-flow/settings-entry-400.jpg)，400×240 JPEG | 窄版仍保留專案、操作權限與設定的 36px 控制 |

360／400／480／720 CSS px 與 200 CSS px 等效內容寬度另有 DOM 檢查；不是實際縮放。設定直達新增 MCP 表單、返回焦點、斷線／配對失效／未配對及執行中位置由合成操作支持。測試分頁、viewport override 及服務已清理。
