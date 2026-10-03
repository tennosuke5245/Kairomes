# 第四輪：交叉稽核與缺口修補

日期：2026-10-02。接續[第三輪驗證](verification.md)，版本仍為 `0.1.4`，研究基準 revision 仍為 `5edf3dcb61eb5021135ccf200f0aa7af97ddceb1`。變更保留於未提交、未發布的工作目錄。使用者選擇先不安裝 Extension，本輪沒有原生安裝、真配對、私人來源讀取或 ChatGPT 發送。

三個範圍交叉稽核發現原先的完成度判斷仍漏了必要邊界。本輪修好已知缺口，並更正第三輪離線截圖的文字敘述；不能以檢查通過推定真人、原生或宿主驗收已完成。

本報告保留第四輪當次結果。後續字級／對比修補、隔離已安裝 CLI 握手與最新測試包見[可讀性與相容檢查](readability-audit.md)；該報告的包 hash 取代本報告同路徑的歷史測試 ZIP。

## 實際修補

| 缺口 | 現在的行為 | 程式碼與回歸 |
| --- | --- | --- |
| 概要切到 B，仍把 A 的已載入 diff 配在新目標下；讀取／取消 error 亦可能殘留 | render 即按原 ID／workspace 隔離內容與錯誤；晚回覆不能進新目標。取消的全域防重送仍在，但只有原目標標取消中 | [overview-panel](../../apps/widget/src/overview-panel.tsx)、[command-panel](../../apps/widget/src/command-panel.tsx)、[file-change-panel](../../apps/widget/src/file-change-panel.tsx) |
| 格式正確、ID 不符的 command page 能先改 cursor／輸出 | 驗 kind／ID 後才採用輸出及 cursor；diff 亦核對 workspace | [身份 helper](../../apps/widget/src/result-identity.ts)、[回歸](../../apps/widget/src/result-identity.test.ts) |
| MCP 圖片卸載後才取得 object URL，沒有回收 | 每個 effect 清理自身 URL，late success 亦回收；同時增加 media ID 的 render gate | [McpImagePreview](../../apps/widget/src/overview-panel.tsx) |
| 命令尚未取得結果，同時出現兩句載入提示；失敗也夾帶載入文字 | 載入只有一份短提示；無結果的失敗只呈現錯誤 | [CommandOutput](../../apps/widget/src/command-panel.tsx) |
| 核准回應未知，list 仍 pending 就重新允許；不相關 SSE 清掉未知提示 | 綁來源、request ID、fingerprint 的獨立鎖；同 pending 不解鎖，保留唯讀查詢。只有對應身份／狀態進展、pending 到期或移除等證據解決該鎖；running 的未知停止不靠原核准期限解除 | [tracker](../../apps/extension/src/approval-mutation.ts)、[回歸](../../apps/extension/src/approval-mutation.test.ts)、[coordinator](../../apps/extension/src/sidepanel.ts) |
| SSE EOF 後，晚到的核准 list 能把 available 改回 true；catalog failure 能覆寫 stale 提示 | 串流世代及已收到的新快照共同決定可用性；晚到 list 可對帳，不能恢復操作。離線維持單一「顯示上次快照」 | [stream guard](../../apps/extension/src/panel-stream-availability.ts)、[回歸](../../apps/extension/src/panel-stream-availability.test.ts)、[狀態優先順序](../../apps/extension/src/panel-error.test.ts) |
| 頂列的核心權限與核准入口仍 13px | 調成 14px，實際 computed style 已核對 | [sidepanel.css](../../apps/extension/sidepanel.css) |
| 32 則訊息／40 個命令的數量裁切沒反映到 coverage，匯出可能說截斷無 | 新增 `itemsTruncated`，與文字裁切、安全省略分開；來源沿用「範圍有限」，匯出正確寫截斷有。訊息滿額不消耗命令額度 | [來源 reader](../../apps/daemon/src/agent-sessions.ts)、[來源回歸](../../apps/daemon/src/agent-sessions.test.ts)、[H1 匯出回歸](../../apps/daemon/src/handoff-brief.test.ts)、[coverage 契約](../../packages/protocol/src/handoff.ts) |

MCP 產品列表原本已有 `media_id` key，不能把無 key fixture 的 props 重用寫成既有混圖事故；本輪確認的必要問題是 late URL 回收。diff、讀取 error 與取消 error 的跨目標問題則能發生於現行元件切換。

本輪沒有新增常駐介紹卡、接續摘要 sidebar 卡、聊天 composer 或另一份同義狀態。權限、工具 surface 與 `WIDGET_URI` 未擴張。

## 合成瀏覽器驗收

`bun run scripts/preview-sidebar.ts` 僅提供記憶體後端與固定材料，隨機 port 限 loopback。下列操作在 Chrome 分頁完成，並未載入 Extension。

| 路徑／情境 | 可觀察結果 |
| --- | --- |
| `/results-identity`：載入 A，再切 B 延遲 | B 只顯自身載入狀態，沒有 A 的 diff、命令或圖片；命令載入文字只出現一次 |
| B 載入失敗，再切 A | B error 不殘留；錯 ID 的 command／diff 回覆顯示身份不符且不採其 payload |
| A 未完成就切 B，再完成 A | B 不接收 A 內容；late 圖片計數為建立 1／回收 1；完成 B 才載入 B 內容 |
| `/results-identity?cancel=1`：A 取消中切 B，A 後來失敗 | B 仍保留全域防重送，文案不稱 B 取消中；失敗不出現在 B，回 A 才可見原錯誤。合成取消數 1／1 |
| `/panel-http`：502 後 list 仍 pending，再查詢／送另一件 SSE | 原「允許／拒絕」持續停用，一個未知提示與查詢入口；合成變更數保持 1 |
| 延遲 approval list → 實際 SSE EOF → 送回 captured 200 list | 先觀察 heldLists=1，再 EOF，再完成查詢；workspace／權限仍停用，主提示保留上次快照。只有新 SSE 快照能恢復可用狀態 |
| 新 SSE 恢復，再完成同件未決核准 | pending 未決鎖仍在；同 ID 變 running 後未知提示消失，變更數仍 1 |
| `/handoff?items-truncated=1` | 只有數量裁切、沒有文字裁切或較舊 turn，仍顯示原本的一個「範圍有限」短標記 |

畫面與尺寸見[證據索引](evidence/index.md#第四輪的身份與未決驗證)。fixture 控制與計數器不是產品 UI；MCP 圖片是固定透明 PNG，取消不啟動主機程序。`/panel-http` 使用實際 HTTP／SSE、合成記憶體後端與 Chrome API stub；502 不是 TCP 遺失，不代表真核准／真程序通過。

[HTTP fixture](../../tests/panel-http-fixture.ts) 新增有限的未決核准與 held list，最多四個延遲查詢，request abort／close 清理等待。新 [transport 回歸](../../tests/panel-http-fixture.test.ts) 確認 pending 保持未知、禁止重送，以及 HTTP 200 list 的確可晚於 SSE EOF 到達；可用性門禁另由產品 helper 與實際 coordinator 驗證。

## 文件、skills 與 D10

新增[真人試用規格](usability-test.md)：八個任務、主持腳本、協助判定、計時起訖、五人／五次的不同證據、人工整理對照、窄版與無障礙專項、匿名記錄範本及 H2 決策條件。規格已準備，**沒有招募、執行或填入虛構結果**。

兩份 repository skill 更新成果切換、同 pending 的未知鎖、離線主狀態及來源數量裁切判斷，並同步本機副本。開發計畫的全自主範例改固定到期時間；第三輪 V2 的錯誤描述已校正，歷史圖片保留。

## 最終檢查與剩餘門檻

`bun run check`：**216 pass、0 fail、1,476 assertions、62 個測試檔**；release metadata、widget／Extension build、TypeScript 與 Biome 通過。`bun run desktop:check` 通過 sidecar、Vite、Cargo check／fmt／clippy。沒有新增依賴、版本或 PR。

`bun run package:extension` 成功；本機測試 ZIP 為 `dist/releases/Kairomes-extension-v0.1.4.zip`，SHA-256：`67f8d746f0e201d094ed0327a74aa7a5b903550f131bf401b90bbed069fa2bbc`。這份未發布包取代第三輪同路徑的測試 ZIP，未安裝。

ZIP 七個檔案、CRC 與樣式引用通過；八張 PNG 已核對完整性與實際尺寸。334 個文件相對連結、繁體字形候選與差異格式檢查無問題；兩份 skill 結構 validator 通過，三個更新參考檔與本機副本相同。合成分頁、viewport override 與伺服器已清理。

| 範圍 | 本輪狀態 | 仍需的證據 |
| --- | --- | --- |
| D01～D03、D07 | 已知程式缺口修補；真正合成 HTTP／SSE 與元件證據 | 原生 Chrome／Edge sidePanel、真配對與 MCP 生命週期 |
| D04～D06 | 已知身份、保留與載入去重修補 | 真 ChatGPT 宿主與來源關聯；真 200%、讀屏與完整對比 |
| D08～D09 H1 | 數量裁切、來源／檔案核對、複製契約與失敗回歸 | 原生 Tauri／Codex、真剪貼簿拒絕與 ChatGPT 人工接收／對帳 |
| D10 | 主持腳本與記錄規格完成 | 真人試用尚未執行；A／B 分開計分 |
| H2／P2 | 條件式規格維持 | H1 成效與複製瓶頸證據，尚不實作發布包、持久摘要或 lease |

使用者的「先不安裝」仍有效；原生項目保留待辦，不把程式碼與合成證據當成全部產品驗收完成。下一步依試用規格與實際環境取得證據，避免為補測試增設產品文字或臆測功能。
