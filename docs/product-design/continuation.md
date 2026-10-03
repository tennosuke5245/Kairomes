# 側欄與接續的第二輪修補

日期：2026-10-02。基準仍為 `0.1.4`、`5edf3dcb61eb5021135ccf200f0aa7af97ddceb1`；內容是未發布的工作目錄變更。第一批行為見 [實作紀錄](implementation.md)。

## 本輪行為

| 問題 | 修補後行為 | 主要落點 |
| --- | --- | --- |
| 已完成操作的回應遺失，被顯示為失敗並可能再次操作 | 核准先唯讀查詢；同 ID、fingerprint 與對應狀態才能確認結果，其他情況只顯示「結果待確認。」。不重送副作用 | [approval-state.ts](../../apps/extension/src/approval-state.ts)、[sidepanel.ts](../../apps/extension/src/sidepanel.ts) |
| MCP 加入後回應遺失，舊目錄及表單允許再次送出 | 不確定時重新查目錄；dialog 內保留單行結果及復原動作，先查看目錄再決定。查不到狀態時停用變更 | [mcp-mutation.ts](../../apps/extension/src/mcp-mutation.ts)、[mcp-panel.ts](../../apps/extension/src/mcp-panel.ts) |
| 待核准公告被連線文字覆寫 | 連線與核准使用獨立 live region；同件數但不同請求仍更新，重複快照不重複公告 | [panel-announcements.ts](../../apps/extension/src/panel-announcements.ts) |
| 權限展開後遮住工作台，鍵盤離開仍保持展開 | 外部點擊、Tab 離開、iframe 焦點與 Escape 關閉；正常查看不增加說明文字 | [access-panel.ts](../../apps/extension/src/access-panel.ts) |
| 次要字色在部分底色低於正文對比目標 | Extension 次要字色微調，維持原有配色；三個固定底色的比值為 4.75／5.31／4.55 | [sidepanel.css](../../apps/extension/sidepanel.css) |
| 摘要寬度的 CSS、鍵盤和 ARIA 上限不同 | 以目前容器計算共同上下限；縮窄時同步修正寬度，localStorage 不可用仍可操作 | [inspector-size.ts](../../apps/widget/src/inspector-size.ts)、[main.tsx](../../apps/widget/src/main.tsx) |
| 歷史終端消失後自動換另一個 shell；舊 poll 推翻新終態 | 保留選擇 ID，缺失顯示短狀態；live 終態優先於遲到的 pending／running，不把輸入導向另一個 shell | [terminal-state.ts](../../apps/widget/src/terminal-state.ts)、[terminal-panel.tsx](../../apps/widget/src/terminal-panel.tsx) |
| 終端預覽裁切未明示，游標動畫不遵從偏好 | 伺服器遺漏與本機裁切都有短標記；裁切保留完整 Unicode 字元。xterm 啟用讀屏模式，依 reduced motion 停止游標閃爍 | [terminal-output.tsx](../../apps/widget/src/terminal-output.tsx) |
| 未知或異常來源仍可取得交接複製資格 | 來源只有受支援的閒置狀態加人工停止聲明才可複製；其他來源可看草稿，顯示一句原因。prepare 斷線清除核對資格 | [handoff-brief.ts](../../apps/daemon/src/handoff-brief.ts)、[handoff-flow.tsx](../../apps/desktop/src/handoff-flow.tsx) |
| 重新選來源後 reader 未立即清理，延遲回應污染新狀態 | 先取消既有草稿與 reader，清除人工聲明；request、專案或取消之後的舊回應失效，包括延遲剪貼簿完成 | [handoff-session.ts](../../apps/desktop/src/handoff-session.ts) |
| dirty／rename 與 Git 狀態未能充分辨識 | 詳情折疊顯示有限路徑；區分 Git 不可用與尚無 commit，摘要一行註明未選內容未核對 | [handoff-working-tree.ts](../../apps/daemon/src/handoff-working-tree.ts)、[handoff-flow.tsx](../../apps/desktop/src/handoff-flow.tsx) |
| 解除掛載或工作台失效後，舊核對畫面仍可停留；取消依賴失效的工作台 | App 依最新本機狀態卸載接續畫面、清資格、取消並返回焦點；cancel 先驗 strict input，再清既有草稿，不重啟工作台。Tunnel 未連線不阻擋本機 H1 | [App.tsx](../../apps/desktop/src/App.tsx)、[companion.ts](../../apps/cli/src/companion.ts) |

沿用使用者的必要約束：UI 同一決策位置的事實只說一次。失敗與未知結果使用一行狀態和對應動作；來源摘錄、版本和 dirty 路徑按需展開。核准所需的 argv、cwd、範圍、期限及完整差異仍可核對。

## 可重跑的驗證

執行 `bun run scripts/preview-sidebar.ts`，開啟終端印出的隨機 port。這一輪以 GET 合成頁搭配記憶體 fetch／SSE 替換驗證。後續伺服器已加有限記憶體 POST 與真正合成 HTTP／SSE，邊界及最新對帳身份見[第三輪驗證](verification.md)；不使用真配對、Codex reader、Tauri、Host、Tunnel 或 ChatGPT。

| 路由 | 替換邊界與可驗證範圍 |
| --- | --- |
| `/panel-flow` | 執行實際 sidepanel coordinator；僅替換 Chrome API、fetch 與 SSE。控制可產生待核准、離線、恢復、401，以及「記憶體變更完成，但一次回應遺失」。DOM 計數器可確認未重送；不代表真 HTTP／原生 sidePanel E2E |
| `/panel-flow?pending=1` | 第一次 MCP 新增回應遺失，目錄暫不顯示變更；重查與關閉表單仍保持鎖。現在須核對同來源、新 ID、name／transport／enabled 與完整配置 fingerprint 才解除。DOM 變更數保持 1 |
| `/widget` | 實際 widget、合成 bridge；可檢查寬容器的摘要鍵盤操作與 ARIA |
| `/terminal?terminal=1` | 合成兩個終端、長輸出與遲到 poll；不啟動程序或送入真實終端輸入 |
| `/handoff?blocked=1` | 實際 HandoffFlow、合成未知來源及不可複製預覽；不能代表來源 reader 已實機驗證 |
| `/desktop-handoff` | 實際 App 與 API wrapper，只替換 Tauri invoke。取得核對草稿後，以合成外部解除掛載或離線觸發正常狀態輪詢；草稿取消、入口停用與返回焦點可在 DOM 核對 |

固定色票的相對亮度與對比計算依 [W3C G18](https://www.w3.org/WAI/WCAG22/Techniques/general/G18)；數值不能代替整個產品的無障礙驗收。瀏覽器抽樣只涵蓋可判定前景及不透明純色背景，漸層、透明疊層與原生介面需另驗。

`bun run check` 通過：172 tests、0 fail、1,192 assertions，48 個測試檔。`bun run desktop:check` 通過：widget／Extension、Desktop sidecar／Vite、Cargo check／fmt／clippy。新增 fixture 後另通過全域 TypeScript 與 Biome；沒有新增依賴或提升版本。

另修正 Extension 打包的 allowlist，納入並驗證 `mcp-panel.css` 引用。`bun run package:extension` 成功；ZIP 的 7 個檔案、CRC 與樣式引用已檢查。`dist/releases/Kairomes-extension-v0.1.4.zip` 是目前工作目錄的本機測試包，版本號尚未提升，不是公開的 `v0.1.4` 發布檔案；未安裝或發布。

本輪依使用者選擇先不安裝 Extension；原生驗收保留待辦，未因合成證據或打包成功而標為已完成。測試分頁、viewport override 與合成伺服器已清理。

Chrome 中的純合成互動已確認：

- 核准變更先提交而回應遺失後，只查目前狀態；變更計數保持 1，對應 running 狀態沒有假失敗 alert。
- MCP 新增尚未出現在目錄時，重查及關閉表單都保持變更鎖；延遲變更完成且出現匹配的新 ID 後才解除，變更計數仍為 1。401 保留重新配對與停用入口。
- 權限展開可由 Escape、Tab 離開及工作台 iframe 焦點關閉；核准公告與連線公告互不覆寫。
- 摘要 Home 實際寬 320px；1200／1050／820px 的 End 與 ARIA 上限分別為 760／706／476px，無文件橫向溢出。
- 合成終端的 5,652 字輸出預覽裁成 4,000 字並標示部分保留；late reply 計數 1 時仍維持 stopped。移除後保留原 ID、另一個 shell 未被選取、停止停用且矛盾頁尾移除；缺失狀態只在選擇器顯示一次。讀屏輸入標籤為繁體中文。
- 未知來源勾完三項人工確認仍不能複製；重新選來源後焦點返回標題。實際 App 的合成解除掛載／離線分別讓取消計數增至 1／2，草稿歸零並返回專案標題。

純色文字抽樣：Extension 6 個合格樣本最低 5.31、Desktop 選來源 4 個最低 5.29、Desktop 離線專案頁 17 個最低 5.29，均無低於目標的樣本；widget 1 個可判定樣本為 5.14，另 5 個背景無法由此方法判定。這是有限抽樣，不是完整 WCAG 符合聲明。真正 Chrome zoom 操作未能確認尺寸改變，因此仍列未驗。

新增截圖與每張的限制見 [證據索引](evidence/index.md#第二輪修補的合成畫面)。兩份 repository skill 已吸收不確定結果、公告與取消的判斷規則，並同步本機副本、通過 validator。

## 發布前仍必要的驗收

| 項目 | 驗收範圍 |
| --- | --- |
| 原生 Chrome／Edge sidePanel | 真配對、精確 origin、SSE 斷線重連、401、未知副作用結果；只使用獲允許的隔離測試專案 |
| 新版 Desktop | 實際來源 reader、取消／重選、外部解除掛載、工作台失效、剪貼簿拒絕與返回焦點 |
| ChatGPT／Tunnel | 真宿主能力、結果關聯、跨層錯誤與人工接續；不保存私人聊天 |
| 無障礙 | 實際 200% zoom、讀屏公告順序及不重複、完整文字對比、reduced motion 實機 |
| D10 | 五名測試者或五次受控接續；量測時間、理解與誤判，不以合成測試代替真人 |

H2 發布包、持久摘要、合作式 lease 與 worktree 仍依 [P2 啟動條件](development-plan.md#7-p2-啟動條件) 決策。本輪不新增常駐摘要卡、聊天 composer、全部允許或自動發送，不改 grant 語意與 `WIDGET_URI`。
