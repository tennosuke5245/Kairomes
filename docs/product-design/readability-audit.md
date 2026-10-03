# 可讀性修補與隔離 Codex 相容檢查

日期：2026-10-02，Kairomes 仍為 `0.1.4`。接續[第四輪稽核](completion-audit.md)，本次補 D05 的實際樣式量測與 D08 的已安裝 CLI 握手證據。使用者選擇先不安裝 Extension；程式碼、測試包與文件仍未發布。

## 已修的可讀性缺口

沒有新增產品文案或介紹卡；修正文字顏色、必要字級、換行、點選區與焦點。

| 實際情境 | 修正前 | 修正後 |
| --- | --- | --- |
| Setup 配對輸入提示 | 4.2026:1 | 既有 `--muted`、明確 opacity 1，4.9195:1 |
| 工具「可執行動作」標籤 | 4.4063:1 | 既有 `--ink`，13.1971:1；其他風險顏色保留 |
| 設定導覽、狀態與新增操作 | 9～11px | 14px；既有標題及工具按需展開保留 |
| Signal 命令 stderr | 深紅配深色 console，2.0084:1 | 使用原本淺紅 console 色，9.3901:1 |
| 命令位置／輸出截斷提示 | 繼承 generic 深色主題 muted，在明亮 inspector 約 2.3380～2.3585:1 | 使用 Signal muted，背景界限約 6.1929～6.2470:1 |
| 深色 MCP「呼叫完成」 | 2.5470:1、9px | 深色成功色 8.7263:1、14px |
| 深色 MCP 錯誤正文／省略通知 | 1.7101／2.1159:1 | 深色 `--red-dark`，均 8.0672:1 |
| 深色 MCP 描述／呼叫內容入口 | 3.2241／2.0799:1 | 共用 `--red-dark`，均 9.8118:1 |
| H1 來源、範圍、停止／權限核對、預覽與必要操作 | 部分 10～13px；核對 label 高 21px | 必要文字至少 14px；可點選 label 至少 32px |
| H1 勾選框鍵盤焦點 | 22% 紅色，對 canvas 1.3528:1 | 實色 2px／offset 3px，4.7853:1 |
| Desktop「ChatGPT · 待完成」 | 整節點 opacity .48；文字合成 3.1240／2.2058:1 | 移除整節點淡化、14px，文字 16.0939／7.0824:1 |

實作位置：[Extension 樣式](../../apps/extension/sidepanel.css)、[Desktop 樣式](../../apps/desktop/src/styles.css)、[工作台樣式](../../apps/widget/src/styles.css)、[MCP 成果樣式](../../apps/widget/src/mcp-result.css)。MCP 成果的來源、尺寸、正文、狀態與操作入口均提升至 14px，header／metadata 可換行；淺色成功標籤仍為 **4.5044:1**，以未四捨五入值判斷通過。

## 量測與證據限制

文字以 4.5:1 為門檻，placeholder 也計入；停用控制與標誌依規範分開判斷。焦點圈另檢查與相鄰背景的非文字對比。依據：[WCAG 2.2 文字對比](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)、[非文字對比](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)。14px 是本專案必要資訊的閱讀目標，不是 WCAG 對比條款訂定的最小字級。

Chrome 中取得可見元素與 placeholder 的 computed style，排除 hidden、關閉 details 內文、視窗外元素及 disabled；純色背景由底至上做 alpha 合成，再依 sRGB 相對亮度計算。無法直接解出的 gradient、filter、blend 與祖先 opacity 標為未解，不把白色 body 當成背景。命令 muted 另依已確認的兩個 gradient 色端點及 inspector 92% paper 算界限；pending 節點則確認祖先均透明、無 gradient 與其他 opacity 後另算。

[量測資料](evidence/readability-audit/measurements.json) 保留 14 組狀態、197 個文字元素紀錄、15 個窄版尺寸檢查、焦點與動態分支值；不是 197 個獨立測試或完整頁面的 WCAG 認證。Setup、工具設定、命令成果、H1 編輯與深色 MCP 錯誤成果在固定內容的 360／400／480px 下，document scrollWidth 均等於 viewport。H1 合成預覽的全文 textarea 亦確認 14px；沒有呼叫複製或發送。

圖片見[證據索引](evidence/index.md#可讀性修補畫面)。所有資料與 ID 均為合成材料；MCP 圖片是固定 1×1 透明 PNG，只測 renderer 與樣式，不測真圖片品質。

### 主題與減少動態

本次 Chrome 的 `prefers-color-scheme: dark` 確實為 true，深色成功／錯誤驗證走原本 CSS media query；淺色由 fixture 明確選取 CSS 分支。這不證明 ChatGPT 宿主主題傳遞或真 MCP App 接收。新增的[記憶體 SDK adapter](../../tests/mcp-result-preview-app.ts) 只替換 preview bundle 的 App 邊界，固定結果送入原 [MCP renderer](../../apps/widget/src/mcp-result.ts)；產品 SDK 與 transport 未替換。

Extension 原 reduced-motion 的 `*` 不足以覆蓋高 specificity 的開關，也漏了箭頭偽元素。修正為元素與偽元素、duration／iteration／scroll 的 `!important` 規則。`motion=reduce` fixture 選取真 CSS 分支後，開關與箭頭 transition 均為 **0.01ms**。瀏覽器實際 reduce preference 為 false；沒有變更 OS 設定，不能稱為真偏好／讀屏驗收，也沒有用 CSS 分支替代 xterm 的 media-query 事件測試。

## 已安裝 Codex CLI 的隔離 smoke

已安裝版本為 `0.159.0-alpha.12.1`。既有 resolver 找到 regular PE executable，沒有使用 shell／wrapper。沿用 production [CodexRpc](../../apps/daemon/src/codex-rpc.ts) 的環境白名單與 app-server argv，強制新建空 `CODEX_HOME` 與 cwd；request guard 僅允許 initialize、thread/list。

初始化握手成功；[CodexSessionSource](../../apps/daemon/src/agent-sessions.ts) 的受限 `thread/list`（`useStateDbOnly:true`、精確暫存 cwd）通過現行 schema，回傳零筆來源與 `nextCursor:null`。沒有請求登入、推論或 thread/read；自建 child 已退出，暫存資料在核對路徑、非連結與 ownership 後清理，未保存原 stderr 或主機路徑。

這證明該已安裝 CLI 能接受目前的初始化與空清單契約。空清單不能證明真來源的 status、coverage、itemsTruncated、Tauri IPC、原生剪貼簿或 ChatGPT 接收；D08／D09 保留這些門檻。

## 檢查與下一個門檻

`bun run check` 最終為 **216 pass、0 fail、1,476 assertions、62 個測試檔**，release metadata、build、TypeScript 與 Biome 202 檔通過。新量測 JSON 起初未符合 Biome 格式，格式化後重跑整套成功。`bun run desktop:check` 通過 widget／Extension、sidecar、Vite、Cargo check／fmt／clippy；後續只改 Extension 導覽字級。獨立代理唯讀複核本次四份 CSS、兩份 fixture 與 preview，未找到必要回歸或權限擴張。

`bun run package:extension` 成功；本機未發布、未安裝的 `dist/releases/Kairomes-extension-v0.1.4.zip` SHA-256 為 `532b4996f6f38aa263ef3cf5d01b82d3ed5e7d7aceeb38cd84dd7dd9912e7055`，取代第四輪同路徑的歷史測試包。未新增依賴、版本、權限、MCP 工具或不相容 resource 契約。

兩份 skill 補上 placeholder／深色錯誤／opacity／CSS cascade 與隔離 CLI 證據判斷，已同步本機副本並通過結構 validator。圖片、ZIP、相對連結與差異格式另經本機檢查。

仍待：原生 Chrome／Edge sidePanel、真配對與生命週期；Tauri／剪貼簿；ChatGPT／Tunnel 接收與版本對帳；真 200%、讀屏、完整各狀態對比及真 reduce preference；[D10 真人試用](usability-test.md)。合成分頁、viewport override 與伺服器已清理。「先不安裝」仍有效；H2 等待 H1 成效與複製瓶頸證據。
