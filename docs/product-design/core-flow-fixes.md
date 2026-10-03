# 核心流程修補與範圍收斂

日期：2026-10-03。依目前 0.1.4 原始碼修補既有流程；本次沒有安裝、重新載入或配對 Extension，沒有讀取私人 Codex 紀錄或傳送 ChatGPT 訊息。尚未發布。

## 必要性決策

側欄保留「看操作、處理核准、檢查成果」三個核心用途。可讀性、鍵盤與狀態正確是開發品質；多人試用另行選用；合成免安裝預覽只供內部重現。H1 人工交接是已有程式碼的選配試點；H2、自動發布包及持久摘要須先有實際需求。定位已同步至[開發計畫](development-plan.md#功能與驗證的必要性)、[D10 研究](usability-test.md)與兩份 skills。

使用者先前表示驗證完畢，隨後說明不知道要驗證哪些項目；因此沒有新增通過紀錄、真人成功次數或耗時。

## 已修補的行為

| 既有問題 | 修補後 | 主要程式碼 |
| --- | --- | --- |
| 授權 HTTP 舊快照晚於 SSE 新快照抵達 | 舊 HTTP 回應不能覆寫新快照；換來源後舊失敗也不污染新來源 | [access-mutation-snapshot.ts](../../apps/extension/src/access-mutation-snapshot.ts)、[sidepanel.ts](../../apps/extension/src/sidepanel.ts) |
| 授權回應不明後，普通 SSE 快照就重新開放啟用 | 保留原請求，查同件收據；立即收回先阻止原啟用晚到，再撤銷。頁面重新開啟也恢復未決身份 | [panel-access.ts](../../packages/protocol/src/panel-access.ts)、[access-receipts.ts](../../apps/daemon/src/access-receipts.ts)、[access-mutation.ts](../../apps/extension/src/access-mutation.ts) |
| 同一專案收到新宿主成果，先前手動讀取晚回覆仍搶走畫面 | 新 viewer 成果取消舊讀取的呈現資格並結束 busy；工具目錄更新不取消閱讀 | [read-current-result.ts](../../apps/widget/src/read-current-result.ts)、[main.tsx](../../apps/widget/src/main.tsx) |
| 從 B 專案切到全部，再查看 A 的過期詳情，頂列可能仍標 B | 過期詳情依活動原 workspace 顯示；只有點「瀏覽目前檔案」才讀目前清單 | [main.tsx](../../apps/widget/src/main.tsx) |
| H1 初始化尚未完成時取消，草稿尚未登錄而漏掉取消 | 開始讀取前同步保留草稿與 start 身份；取消、關閉及晚回覆依原身份清理。逾時 UUID 保留至原請求結束，不誤刪新草稿 | [handoff-brief.ts](../../apps/daemon/src/handoff-brief.ts)、[handoff-starts.ts](../../apps/cli/src/handoff-starts.ts)、[companion.ts](../../apps/cli/src/companion.ts) |

缺少詳情資料時也共用來源切換處理；本次瀏覽器實際覆蓋的是**詳情過期**路徑，不能將防禦分支寫成無資料跨專案互動已通過。

### 自主模式失敗恢復的契約

沿用可信 `/api/panel/access`，不新增 MCP 工具或管理權限。新請求包含 UUID 與最長 30 秒的首次接受期限；deadline 不縮短已建立的 grant。操作輸入正規化後取完整 SHA-256，收據依實例與原 panel owner 隔離。同 ID 改內容會拒絕，同內容只讀既有狀態。舊式 client 不帶 ID 時維持原回應，沒有新收據保證。

`pending`、`missing`、`expired` 不能解除未知鎖；只有原 ID、完整 fingerprint 與原呼叫已回覆的收據才解除。`failed` 代表原呼叫回報失敗，先前建立的 grant／工作可能仍存在，仍以目前快照核對；收據不代表命令或檔案工作已完成。唯讀 status 不建立串流可操作資格，換來源／EOF 後晚回覆不能復原。

未知啟用的「立即收回」帶原身份，先建立阻止晚到的記錄，再撤銷 grant，不等待舊啟用的 cleanup。每個 owner 的主要操作與 recovery 各最多四件在途；被 supersede 的舊操作直到真正結束仍占容量。完成收據最多 64 份、保留 10 分鐘；去重身份最多 256 份，接受主要操作時預留一次 recovery 空間，配對失效／服務關閉清除。這些是有界記憶體，不是持久審計或 OS 副作用恰好一次保證。

未完成 envelope 先寫入既有可信 `storage.session` 再送出；只存當前操作與其 recovery 前身，key 綁實例、origin 與 owner 雜湊。頁面重新開啟先恢復 unknown，提供「查詢狀態」；普通快照不清理。若 recovery 本身無法確認，或被 429 拒絕而原請求仍為 unknown，提供既有「解除配對」流程，收回該配對**所有** grant，不冒充單專案收回，也不自動執行。

## 畫面與互動證據

使用原 widget React 介面與合成 bridge。新建 [host-viewer-fixture-bridge.ts](../../tests/host-viewer-fixture-bridge.ts) 只把固定資料送入現有 callback；沒有 MCP Apps SDK 連線、網路讀取、檔案操作、程序、grant 或訊息傳送。延遲讀取最多一件，30 秒逾時，關閉時清理。測試控制與狀態只存在內部 `/host-viewer` 頁。

實際操作確認：

- 延遲讀取 A → callback 送入同專案 B → 放行 A，畫面保持 B。
- 延遲搜尋 → callback 送入 B → 放行搜尋，舊搜尋不改畫面；busy 已解除。
- 延遲讀取 A → 更新工具目錄 → 放行 A，讀取正常完成，沒有被目錄更新取消。
- 400px 下從 B 選「全部本機操作」再開 A 的過期詳情，標示 A，沒有自動讀取；點「瀏覽目前檔案」才列出 A。

自主模式另用合成 HTTP／SSE 工作台操作：啟用回應不明後查詢原收據、瀏覽 B 時仍對 A 提供收回、重新載入後保留未知鎖，再收回並放行舊回覆。整段操作在 662×687 視窗完成，沒有重新送出 enable。收回前後原呼叫仍在等待；放行後保持「逐步確認」，沒有 grant 復活。另以 400×900 檢查恢復後畫面，scrollWidth 為 400；不能將窄版截圖當成整段窄版操作證明。資料、配對與 grant 全為固定記憶體替身，不連到真管理面。

| 畫面 | 支持範圍 |
| --- | --- |
| [宿主成果取代等待中讀取](evidence/core-flow/host-viewer-order.jpg)，1676×1256 | B 已呈現、A 仍等待；晚回覆不覆蓋由操作後 DOM 確認。畫面的「ChatGPT 已連線」僅是合成 host 分支，不能證明真宿主連線 |
| [過期詳情保留來源](evidence/core-flow/expired-source-400.jpg)，400×900 | A 的來源名稱、一次到期提示與一個明確動作；頁面 scrollWidth 為 400 |
| [自主模式收回後](evidence/core-flow/access-recovered-400.jpg)，400×900 | 已回到「逐步確認」、沒有未知提示；操作與晚回覆結果由合成 HTTP／DOM 確認，截圖只支持恢復後窄版布局 |

## 驗證與剩餘範圍

H1 三檔最終針對性測試為 29 通過、0 失敗、272 次斷言。取消與逾時以固定時鐘、真正草稿服務及合成 reader 檢查；包含舊開始回覆晚到、相同 UUID 新世代保護與關閉後清理，不讀私人資料。授權失敗案例只在隔離合成環境執行。

最終 `bun run check` 通過：版本檢查、widget／Extension 建置、TypeScript、Biome，以及 72 檔共 296 項測試，0 失敗、2344 次斷言。429 恢復入口的小修有 TypeScript／Biome 與完整檢查支持；該極端容量分支沒有另做瀏覽器互動驗證。

`bun run desktop:check` 通過：版本檢查、widget／Extension、Desktop sidecar 與 Vite 建置、Cargo check／fmt／Clippy。當次文件 10 檔、162 個本機相對連結無缺檔，`git diff --check` 通過；兩份 skill 結構驗證通過，已同步至本機安裝版本。

原生 sidePanel、Tauri UI、真 Codex 來源及 ChatGPT／Tunnel 相容性仍未驗證。這與選用的多人研究分開記錄；合成畫面、單元測試或建置成功都不取代實機結果。

## 頂列與設定入口修補

日期：2026-10-03。使用者回報 Layer 連線修補後成功，接著指出「本機已連接」落到獨立第二行，以及設定入口藏在狀態按鈕、不易找到新增 MCP。

目前 [側欄 HTML](../../apps/extension/sidepanel.html)、[CSS](../../apps/extension/sidepanel.css) 與 [協調器](../../apps/extension/src/sidepanel.ts) 已調整：正常頂列為 K 標誌／連線圓點、專案、操作權限與明確的「設定」。連線圓點為非互動指示，保留狀態名稱、title 與既有 live 通知；一般設定保留完整通道狀態。同一狀態沒有新增說明卡。

已配對時「設定」直達 MCP 整合與「加入 MCP」；未配對或配對失效時進入一般設定，MCP 分類停用，「解除配對」依 hidden 狀態隱藏。切換分類不覆寫返回目標；從頂列開啟，返回時焦點回到設定按鈕，原工作台訊息入口仍返回工作台。原本指向狀態按鈕的其他回焦點改用設定或核准入口。

正常 360／400／480／720 CSS px 的主列高 53px，沒有空的連線列。待核准、執行中或恢復動作才增加操作列；340px 以下將專案與權限／設定分成兩行。200 CSS px 等效內容寬度的三列高度為 36／36／34px，未留下隱藏恢復列的空隙。執行清單由 ResizeObserver 取得實際頂列高度定位，400px 合成畫面中位於頂列下方 8px；核准閱讀頁沿用既有正常文件流。

Chrome 使用實際側欄協調器配 [純記憶體 fixture](../../tests/panel-flow-preview.ts) 與假 Chrome API，沒有真 Host、工作區、程序、帳號或核准。驗證設定→MCP→新增表單→取消→返回、Enter 開啟、回焦點、待核准→合成執行中、斷線後新增停用、401 後一般設定，以及未配對時的分類停用／按鈕隱藏。操作列 DOM 順序為權限、設定、恢復、核准及執行中，避免 Tab 從恢復入口跳回上一列。

| 畫面 | 支持範圍 |
| --- | --- |
| [720px 正常頂列](evidence/core-flow/settings-entry-720.jpg)，720×240 JPEG | 連線圓點與明確設定入口；沒有第二行狀態 |
| [400px 正常頂列](evidence/core-flow/settings-entry-400.jpg)，400×240 JPEG | 同一行的專案、權限與設定；沒有縮小必要字級 |

最新 `bun run check` 通過：372 項測試、0 失敗、3546 次斷言，包含 TypeScript、Biome 及 Widget／Extension 建置。本輪僅調整 Extension 與工程 fixture，沒有更動 Host／Desktop／sidecar；重載已建置的既有 Extension 即可，不需因本輪重啟 Host。分頁、viewport override 與合成服務已清理，未自動重載使用者側欄。實際 200% zoom、讀屏及這版原生 sidePanel 尚未另驗。
