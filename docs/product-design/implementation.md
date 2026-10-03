# 側欄與 H1 接續實作紀錄

日期：2026-10-02。基準版本 `0.1.4`，基準 revision `5edf3dcb61eb5021135ccf200f0aa7af97ddceb1`。本文件描述目前工作目錄的原始碼變更；尚未建立新版 release，也未修改已安裝的應用程式。

以下保留第一批驗證紀錄；最新修補、檢查數量與未完成驗收見 [第二輪續作](continuation.md)。

## 已落地的行為

第一批完成 P0／P1 的主要程式：精簡側欄、可信核准、閱讀鎖定、成果證據、工具搜尋，以及 Desktop 的人工接續。畫面遵守「同一事實只說一次」：正常畫面只留狀態與操作；來源、權限說明、工具描述與診斷按需展開。必要的 argv、cwd、範圍、期限與完整 diff 不以精簡為理由隱藏。

| 位置 | 目前行為 | 使用者影響 |
| --- | --- | --- |
| 側欄頂列 | 完整專案選擇、權限入口、待確認總數；連線細節另開 | 長名稱可讀；瀏覽篩選不改 ChatGPT 工具目標或 grant |
| 原生核准 | 短佇列，點入單件頁面，保留返回與焦點 | 十件請求不再自動堆成浮層；精確操作可逐件核對 |
| 核准失效 | 不可變審閱內容；內容改變須重看，到期／斷線停用 | 舊內容不能直接允許；不完整差異可拒絕、不能套用 |
| widget | 移除常駐 initials rail；獨立開啟有專案選擇，可信嵌入才隱藏重複頂列 | 360～480px 回收閱讀寬度；不靠聊天頁推定來源 |
| 動態與詳情 | seq／result 去重、暫停概要、歷史詳情固定、未讀件數與返回位置 | 新操作不搶舊內容或焦點；延遲結果不能重開已離開的詳情 |
| 成果 | 顯示 exit code、輸出完整性、版本、差異與到期；區分執行時／目前讀取 | 不把 exit 0 或曾成功誤當成目前檔案已通過 |
| MCP 設定 | 名稱／描述搜尋、伺服器／設定篩選、預設折疊描述、單主捲動區 | 一百項仍可找回；開啟設定與實際可用分開呈現 |
| Desktop 接續 | 專案動作「從 Codex 接續」，兩階段選來源／編輯 | 在較寬介面整理；核對後複製，使用者自行貼到 ChatGPT |

本批 H1 的來源、摘要與複製都在 Desktop。側欄負責原有有效權限核對，尚未新增接續摘要卡；這是第一版的落地取捨，沒有聲稱原提案的每個畫面都已完成。

## H1 的實際契約

1. 選同一已掛載專案的 Codex 紀錄，或使用手動摘要。來源 reader 只允許讀取／列出紀錄，不啟動、恢復或停止 Agent。
2. 人填「目標」「下一步」，其他欄位選填；歷史摘錄只供展開參考，不自動灌入分享內容。預設最近 3 turns，最多 10 turns；覆蓋範圍與中斷資料明示。
3. 填最多 20 個相關相對文字檔，核對 UTF-8 原始位元組版本、Git HEAD／branch／dirty。單檔最多 1 MiB，合計最多 8 MiB；不支援或缺失標 unknown，不能當成完整基準。
4. 人確認來源已停止，並到原生側欄核對有效權限。這是人工聲明，沒有外部 writer lock；既有 grant 不自動收回或轉移。
5. 看完整預覽並確認分享內容。複製前重新讀來源、核對檔案、掛載身份及內容 digest；失效清除原核對與預覽。剪貼簿失敗保留完整內容並選取，不顯示已複製。
6. 自行貼到 ChatGPT。摘要要求先 `workspace_list`、讀檔比對版本，再依現有規則操作。純文字不是接收端權限限制，也不提供操作去重或排他寫入保證。

草稿只在 Companion 記憶體中，最多 4 份，閒置 10 分鐘失效；取消、關閉或實例重綁會清理。管理路由 `/api/handoff` 使用 Companion 的精確本機 Host／Origin 與控制憑證，body 上限 64 KiB；不向 workbench、panel、widget 或 MCP 開放管理權。摘要最多 6,000 字元，超限拒絕，不靜默截斷；已知憑證、私人 loopback URL 與絕對路徑拒絕加入人工欄位。使用者仍須審閱未知敏感內容。

詳細設計與後續 H2 條件見 [handoff-spec.md](handoff-spec.md)；目前能力以 [README](../../README.md) 與 [SECURITY](../../SECURITY.md) 為準。

## 技術落點

| 範圍 | 主要檔案 |
| --- | --- |
| 側欄與可信核准 | [sidepanel.ts](../../apps/extension/src/sidepanel.ts)、[approval-panel.ts](../../apps/extension/src/approval-panel.ts)、[approval-state.ts](../../apps/extension/src/approval-state.ts)、[access-panel.ts](../../apps/extension/src/access-panel.ts) |
| 工具搜尋 | [mcp-panel.ts](../../apps/extension/src/mcp-panel.ts)、[mcp-filter.ts](../../apps/extension/src/mcp-filter.ts)、[mcp-panel.css](../../apps/extension/mcp-panel.css) |
| 動態與成果 | [main.tsx](../../apps/widget/src/main.tsx)、[activity-model.ts](../../apps/widget/src/activity-model.ts)、[result-evidence.ts](../../apps/widget/src/result-evidence.ts) |
| 嵌入來源 | [preview.ts](../../apps/daemon/src/preview.ts)、[workbench.test.ts](../../apps/daemon/src/workbench.test.ts) |
| 接續 UI／IPC | [handoff-flow.tsx](../../apps/desktop/src/handoff-flow.tsx)、[handoff-copy.ts](../../apps/desktop/src/handoff-copy.ts)、[api.ts](../../apps/desktop/src/api.ts)、[lib.rs](../../apps/desktop/src-tauri/src/lib.rs) |
| 接續管理與來源 | [companion.ts](../../apps/cli/src/companion.ts)、[handoff-brief.ts](../../apps/daemon/src/handoff-brief.ts)、[handoff-source.ts](../../apps/daemon/src/handoff-source.ts)、[agent-sessions.ts](../../apps/daemon/src/agent-sessions.ts) |
| 契約與檔案版本 | [handoff.ts](../../packages/protocol/src/handoff.ts)、[files.ts](../../packages/workspace-core/src/files.ts) |

`kairomes-parent-origin` 是由本機服務注入、經驗證的公開 Extension origin；不含管理憑證。widget 僅接受精確父視窗、origin、版本與列舉訊息，且 payload 不得有額外欄位。沒有合法握手時保留獨立導覽，舊版 Extension 仍能開啟工作台；沒有新 MCP tool 或不相容 resource schema，因此 `WIDGET_URI` 保持 `ui://kairomes/workbench/v6.html`。

沿用「加入 MCP 後開啟全部工具」政策，沒有新增全部允許或自動擴權。專案瀏覽、停止跟隨、來源停止聲明及 grant 四者各自有原本語意。

## 驗證與證據

`bun run check` 通過：147 tests、0 fail、983 assertions，跨 42 個測試檔；包含 release metadata、widget／Extension build、TypeScript、Biome。`bun run desktop:check` 通過：sidecar、Vite、Cargo check／fmt／clippy。未新增套件依賴，未提升版本號。

針對新增邊界的測試涵蓋：內容變更後舊核准失效、結果完整性與 seq、舊 SSE／poll 狀態不倒退、來源 allowlist／取消／期限／並行容量、原始檔案 hash 與路徑安全、HEAD 相同而檔案變更、來源繼續工作、管理通道拒絕及 grant 不變、複製失效與剪貼簿拒絕。這些是受控自動化測試，不是私人帳號的使用結果。

可重跑的純合成畫面：

```powershell
bun run scripts/preview-sidebar.ts
```

使用終端機印出的隨機 port 開啟路由；這一批以 loopback GET 合成頁驗證。後續已加入有限記憶體 POST 與真正合成 HTTP／SSE，最新邊界見[第三輪驗證](verification.md)。不啟動真實 Host、Tunnel、shell、Codex reader 或 Tauri。原批路由如下：

| 路由 | 測試目的 |
| --- | --- |
| `/setup` | 首次配對畫面；不執行配對 |
| `/approvals?count=10` | 十件短佇列與單件詳情 |
| `/approvals?count=3&controls=1` | 內容變更／斷線／差異截斷／到期；只改記憶體 |
| `/settings?count=100` | 一百個工具、搜尋、篩選、切換焦點 |
| `/settings?count=100&unavailable=1` | 開啟但不可用的工具短標示 |
| `/settings?add-failed=1` | 同名加入失敗後保留表單 |
| `/reading?delay=1`、`/reading?expired=1` | 暫停概要、延遲回應、歷史固定、到期 |
| `/embedded` | 合成 MessageEvent 來源／視窗／版本 gate；並非真 Extension E2E |
| `/handoff`、`/handoff?stale=1` | 真實 HandoffFlow、合成來源與核對回應；摘要文字是 mock |
| `/zoom?view=approvals&width=400` | 200px CSS viewport 以兩倍呈現；不是實際瀏覽器 200% zoom |

新版截圖、尺寸與每張支持的觀察見 [畫面證據索引](evidence/index.md)。已在 in-app browser 檢查 360／400／480px 的主閱讀區、核准 argv／shell／diff、鍵盤返回與焦點、核准失效、工具搜尋與設定更新、暫停概要及檔案內容保留、過期結果、可信握手 gate，以及人工摘要／複製成功／版本失效。測試文字、檔案與來源都是合成資料。

## 尚待驗收與下一步

| 項目 | 目前狀態 | 完成方式 |
| --- | --- | --- |
| 真 Chrome／Edge Extension | 未驗證 | 在明確允許的測試專案配對，確認 sidePanel、精確 origin、真 SSE 重連與未知核准結果 |
| 真 ChatGPT／Tunnel | 未驗證 | 使用獲允許的測試帳號與資料，核對宿主 capability、工具／結果與跨層錯誤，不保存聊天逐字稿 |
| Desktop 實機 | build／IPC 合成測試通過；未操作新版原生 UI | 啟動開發版，驗證來源 reader 生命週期、返回焦點、複製與取消 |
| 200%／讀屏／對比 | 有等效窄 viewport、鍵盤與後續有限純色對比抽樣；實機與完整對比未驗 | 真瀏覽器 zoom、螢幕閱讀器 status／alert、正文對比、reduced motion 分別驗收 |
| D10 接續試用 | 未進行 | 五名測試者或五次受控接續，比較人工重述與 H1 的時間、版本誤判及閱讀負擔 |
| H2／持久摘要／lease／worktree | 未實作 | 依 [P2 啟動條件](development-plan.md#7-p2-啟動條件) 的證據再決策 |

試用只記錄耗時、是否找到下一步、是否理解命令與 shell 差異、是否辨識失效／未知、是否有重複操作；不匯入私人內容或增加預設遙測。首次連接、十件核准、歷史結果、版本變更與接續各做一項任務。以計畫中的四／五成功目標評估，不把主持人的示範當成功。

本批沒有發布新版、建立 PR、自動發送聊天、轉移 Agent 執行狀態或修改既有 grant。下一步是受控實機與 D10 使用驗收，通過後再決定發布與 H2。
