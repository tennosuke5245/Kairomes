# 更新紀錄

## 0.3.0（2026-10-09）

0.2.0 沒有單獨發佈，這版一併包含其後的修補。介面改用共用設計系統並支援深色模式，模型新增唯讀 Git、批次讀檔、檔名尋找與 ChatGPT 圖片匯入工具；從 0.1.4 更新時，請一併閱讀 0.2.0 一節。

### 新增

- **模型工具**（25 → 33 個）：唯讀 `git_status`／`git_diff`／`git_log`；`file_read_many` 一次讀 1～8 個檔案；`file_find` 依名稱或 glob 找檔；`file_search` 新增資料夾範圍、`include` glob、大小寫與前後文；`image_import_request`／`image_import_poll`／`image_import_cancel`。
- **核准模式與長輪詢**：`workspace_list`、`workbench_open` 回報各專案的核准模式與到期時間；`command_poll`、`terminal_poll` 可帶 `wait_ms`（最多 20 秒）。
- **圖片匯入**：ChatGPT 交出圖片時由 Kairomes 下載並在側欄預覽；沒有交出時顯示「等待圖片」，可在側欄貼上、選擇檔案或拖放。也能不經 ChatGPT 自行匯入。每張都需在側欄個別核准，只建立新檔。
- **拒絕附原因**：側欄「拒絕並說明原因…」（單行、最多 200 字），模型從 poll／list 讀到 `denial_reason`。
- **設計系統**：`packages/ui-tokens` 提供 token 與 `.k-*` 元件；Desktop、側欄、工作台、MCP 結果卡、Companion 頁、OAuth 回呼頁與本機核准頁共用，並跟隨淺色／深色主題。
- **Desktop**：總覽儀表板（需注意卡片與專案卡）、六步首次設定清單、疑難排解檢查項目與「複製診斷摘要」；專案可改名、在檔案總管中顯示、多選或拖入資料夾；系統匣顯示狀態，有待確認時加紅點並提醒視窗。
- **側欄**：單列工具列（需確認、執行中、操作模式倒數）、`Alt+Shift+K` 快捷鍵與圖示徽章；核准頁分「需確認／執行中／最近」，決定後自動開啟下一件；MCP 設定有篩選晶片、`/` 搜尋與加入範本。
- **工作台**：動態時間軸有篩選晶片、分組、相對時間、倒數與失敗原因；跟隨可暫停並以「回到最新」恢復；命令、變更、終端機改為紀錄清單，可複製輸出、指令與路徑；檔案瀏覽有路徑導覽與篩選。ChatGPT 宿主檢視改用同一外殼。
- **Companion**：Tunnel 失敗原因分類，意外結束後自動重啟；工作台、Companion 與 Desktop 版本握手；`kairomes doctor` 輸出可分享的診斷摘要。

### 改善與修正

- `mcp_tool_call`／`mcp_read_call` 在 Host 執行期間，同一 `request_id` 至多送出一次；結果不明回 `MCP_CALL_UNKNOWN`，不再重送。
- 本機 stdio MCP 不再繼承 Host 的工作目錄：未指定時在資料目錄的 `mcp-runtime` 啟動，內含最小 `package.json`，讓 npm／npx／bunx 不會向上採用 Host 所在專案或 Kairomes 原始碼目錄的依賴（修正 Host 位於專案子目錄時 `npx -y chrome-devtools-mcp@latest` 因 npm 崩潰而無法啟動）。由 `bun run` 或 npm script 啟動 Host 時，子程序的 PATH 移除這些啟動器加入的 `node_modules/.bin`；Bun 暫時 node shim 一律移除，使用者自己加入的項目保留。
- 工作目錄須為絕對路徑，啟動程式寫成相對路徑（如 `./start.sh`）時也須指定：側欄當場在「工作目錄」欄提示，貼上帶引號的 Windows 路徑會自動去除引號；`kairomes mcp add-stdio` 同樣不接受相對路徑。舊設定的相對工作目錄或相對啟動程式不再依 Host 位置解析也不啟動，`doctor` 會計數；資料夾不存在時回報「工作目錄不存在或不是資料夾」，不再誤報找不到程式。
- stdio relay 請求上限由 32 KiB 改為 320 KiB，過大、逾時、忙碌與離線各自回報。
- 側欄快照只附待核准與套用中的差異，保留大量變更時核准串流不再反覆重連；命令與終端機輸出不再觸發側欄快照。
- 審閱差異的後置上下文改取變更旁的行；換行差異在側欄、本機核准頁與工作台顯示一致。
- 圖片匯入的需確認數、衝突原因、到期用語、圖片大小（KiB／MiB）與專案色塊在各介面一致；匯入結束立即釋放影像記憶體。
- 工作台與 MCP 結果卡的載入、錯誤畫面跟隨主題；移除淺色工作台上對比僅 1.18:1 的 hover 色；次要文字對比提高到 4.5:1。MCP 結果卡錯誤優先，JSON 可收合。
- ChatGPT 宿主檢視移除重複的聊天輸入框，改用 ChatGPT 本身的輸入框。
- Desktop 狀態改為推送；重新啟動本機服務、移除金鑰、解除掛載與更換 Extension ID 都先確認；配對連結遮蔽並倒數，到期或離開頁面即清除；第一次關閉視窗會提示縮到系統匣；從 Codex 接續改為三步驟。
- Desktop 錯誤訊息含中日韓文字時截斷不再當機；使用者停止 Tunnel 後，接管工作台、重試工作台或設定 Extension 都不會自動重新啟動。
- 開發用合成預覽恢復可建置，每頁支援 `?theme=light|dark` 與 `?motion=reduce`；`bun run desktop:check` 加入 `cargo test`。
- README 改寫為較短的入門說明，並提供三種語言：英文版 `README.md`（GitHub 預設顯示）、繁中版 `README.zh-TW.md` 與日文版 `README.ja.md`；日常操作移到[操作指南](docs/usage.md)。
- MCP 登入卡在「登入狀態待確認」：Host 已不記得那次登入（超過 10 分鐘或已重啟）時，查詢後改依 Host 目前的登入狀態顯示，不再永遠停在待確認；這個畫面也一律提供「清除登入」。

### 安全

- 升級 `@modelcontextprotocol/sdk` 1.30.1 → 1.32.1（GHSA-6qxp-vccf-f47h）；鎖檔更新 `proxy-addr` 2.0.8（GHSA-jqcg-44mw-7w3h）與 `source-map-js` 1.2.2（GHSA-68fv-2mgg-jv7q）。HTTP MCP 仍不跟隨重新導向。
- Git 工具停用 hooks、fsmonitor、外部 diff、textconv、儲存庫 filter 與所有傳輸；拒絕外部 gitfile、`commondir`、替代物件庫與 partial clone；私有路徑不輸出，含私鑰標記的檔案整段遮蔽。
- 圖片下載只接受 OpenAI 網域的 HTTPS，DNS 結果須為公開位址並固定連線；核准須由同一配對側欄先讀取並核對原圖；本機核准頁與 admin 權杖不能核准匯入。
- 拒絕原因拒收不可見與雙向控制字元，並遮蔽已知金鑰、本機網址與 64 位十六進位權杖。
- Desktop 外部連結維持固定允許清單，絕對路徑只顯示在 Desktop 專案卡；本機控制連線不經系統 proxy，webview 仍不取得權杖。

### 更新與限制

- 需同步更新 Desktop 與 Extension；`WIDGET_URI` 改為 v8、`MCP_RESULT_URI` 改為 v4。ChatGPT 仍顯示舊工作台或舊工具清單時，到 Connector 設定按「重新整理」。
- 未指定工作目錄的本機 MCP 改在 `mcp-runtime` 啟動，參數中的相對路徑（如 `node dist/index.js`）也以此為準；請改成絕對路徑或補上絕對工作目錄。使用相對工作目錄或相對啟動程式的設定不會再啟動，請移除後以絕對路徑重新加入。
- 圖片匯入已在原始碼實作，**由 ChatGPT 交出檔案的途徑尚未以真實 ChatGPT 驗證**；側欄貼上、選擇檔案與拖放隨時可用。匯入紀錄與 `request_id` 只存在記憶體，Host 重啟後不保留。
- 命令／終端機仍使用主機使用者權限，不是 OS sandbox。發佈前已由維護者在 Windows 實機試用；macOS／Linux 的 Desktop 仍未實機驗證。
- Windows 安裝程式與側欄 ZIP 見 [v0.3.0 Release](https://github.com/tennosuke5245/Kairomes/releases/tag/v0.3.0)。安裝程式尚未簽章。

提交前已通過 `bun run check`（972 個測試）與 `bun run desktop:check`（23 個 Rust 測試），並檢查文件相對連結。

## 0.2.0（未單獨發佈，內容併入 0.3.0）

相較 0.1.4，這版新增 MCP 原生登入與 Codex 接續，並整理側欄的設定、核准和成果閱讀流程。

### 新增

- 遠端 HTTP MCP 的 OAuth 登入、取消、清除及未知結果查詢。憑證只保留於當次 Host。
- Desktop「從 Codex 接續」：同專案唯讀來源或手動摘要、檔案版本核對、人工審閱後複製到 ChatGPT。
- Agent app 設計 skills、產品設計規格與可重跑的內部合成驗收。

### 改善與修正

- 頂列有明確設定入口；連線圓點、專案與權限布局更精簡，MCP 工具可搜尋／篩選。
- 核准採短佇列與單件詳情，內容更動後須重新審閱；回覆未知、離線及晚回覆保留來源與變更鎖。
- 成果固定閱讀、保留執行時版本及來源，不讓新成果、重新整理失敗或舊回覆覆蓋正在檢查的內容。
- MCP 工具定義的合計上限調整為每工具 64 KiB；授權與工具可用分開顯示，管理按鈕維持一致高度。
- 切換工作台時保留各來源的待確認操作；MCP 配置、登入與工具清單共同核對，避免混用舊狀態。
- 取消 Codex 接續後，不再啟動延遲完成路徑檢查的紀錄讀取程序。

### 更新與限制

- 更新時需同步 Desktop 與 Extension；Extension ID 變更時重新配對。Host 重啟後，使用 Kairomes 原生 OAuth 的服務需再登入。
- 接續不自動傳送訊息或授權。命令／終端機仍使用主機使用者權限，不是 OS sandbox。
- Layer 修補後已有使用者回報連線成功；特定工具、長期登入、ChatGPT／Tunnel 及跨平台實機流程未全部驗收。
- 這版沒有單獨的下載檔案，內容包含在 0.3.0。詳細證據見[產品設計文件](docs/product-design/README.md)。

提交前已通過 `bun run check`（381 個測試）與 `bun run desktop:check`，並檢查文件相對連結。
