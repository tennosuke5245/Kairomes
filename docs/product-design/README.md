# Kairomes 產品設計研究與後續開發

日期：2026-10-03。原研究基準為 0.1.4、revision `5edf3dcb61eb5021135ccf200f0aa7af97ddceb1`；後續程式碼已加入側欄改善與 H1 接續。這套文件保留研究依據與後續規格，最新範圍與修補見[核心流程修補](core-flow-fixes.md)。程式碼落地不代表已發布或真實帳號流程已通過。

主要決策：先讓窄側欄清楚呈現範圍、待核准與成果；Codex 到 ChatGPT 的人工交接是選配試點。**UI 只放短狀態、必要資訊與下一個動作，同一事實不重複說明。** 基本可讀性與鍵盤操作由開發端負責，多人試用另行安排，免安裝預覽只供內部開發。完整桌面 IDE、另一套聊天介面、虛構任務狀態與 context 百分比不列為本輪方向。各項必要性見[開發計畫](development-plan.md#功能與驗證的必要性)。

## 閱讀順序

| 文件 | 內容 |
| --- | --- |
| [ChatGPT 圖片匯入規劃與設計稿](image-import-plan.md) | 直接公開檔案匯入工具、宿主傳檔驗證閘門、原生圖片審閱及可操作合成設計稿；尚未實作或驗證真實傳檔 |
| [Layer MCP 相容性修補](mcp-oauth-recovery.md) | 清單 schema 上限、卡片按鈕與回呼頁修正；新版 Host 可讀 41 個公開工具，帳號工具使用待驗 |
| [MCP OAuth 實作紀錄](mcp-oauth-implementation.md) | 第一階段原生登入、初次合成驗收與公開 metadata |
| [MCP OAuth 開發規格](mcp-oauth-plan.md) | 已落地的當次登入契約與後續系統憑證儲存規格 |
| [MCP 連線與恢復](mcp-connection-recovery.md) | OAuth 橋接等待、未知新增結果、通知布局與本次驗證 |
| [核心流程修補](core-flow-fixes.md) | 必要性決策、晚回覆、過期來源、H1 取消與當次驗證 |
| [實作報告](implementation.md) | 本輪程式碼、檢查與合成畫面證據、未驗證事項 |
| [第二輪續作](continuation.md) | 未知結果、來源取消、終端狀態及有限無障礙抽樣 |
| [第三輪驗證](verification.md) | 完整配置身份、成果保留、真正合成 HTTP／SSE 與當次檢查 |
| [第四輪稽核](completion-audit.md) | 成果切換、核准未決與離線競態、來源數量裁切、當次檢查與剩餘門檻 |
| [可讀性與相容檢查](readability-audit.md) | 文字／焦點對比、必要字級、窄版、減少動態分支、隔離已安裝 CLI 握手與最新檢查 |
| [D10 後續使用研究](usability-test.md) | 選用的主持腳本、對照與 H2 決策；不要求一般使用者完成，真人尚未執行 |
| [後續開發計畫](development-plan.md) | 產品決策、P0／P1／P2、精簡 UI、技術責任、D01～D10、驗收與發布 |
| [交接規格](handoff-spec.md) | 必要性決策、H1 人工複製、程式碼身份、權限、H2 條件式發布與失敗案例 |
| [側欄 UI／UX 檢視](sidebar-audit.md) | 原研究的九個合成畫面、有限互動、問題與可保留的部分 |
| [現況盤點](kairomes-current-state.md) | 原研究基準的程式碼、資料／權限層、CLI handoff 與當時缺口 |
| [Agent app 模式](agent-app-patterns.md) | Codex／Claude 模式比較與 Kairomes 採用決策 |
| [Codex 研究](codex-app-research.md) | 現行官方文件與示意，surface／版本限制、工作流程與原生 Hand off |
| [Claude 研究](claude-code-research.md) | Desktop Code／CLI／cloud／Cowork，公開影片、現行文件與 rollout 差異 |
| [畫面證據索引](evidence/index.md) | 研究與各輪開發畫面的來源、尺寸與證據限制 |

## Skills 與使用

兩份 skill 的版本來源保存在 repository，並複製到本機 Codex skills 目錄供後續工作使用。

- [agent-app-design](../../.agents/skills/agent-app-design/SKILL.md)：以可見畫面與官方／程式碼證據研究 Agent app，辨識可移用的模式。
- [kairomes-sidebar-planning](../../.agents/skills/kairomes-sidebar-planning/SKILL.md)：先查 Kairomes 現況，再規劃精簡側欄、功能與上下文交接。

可用提示：`使用 $agent-app-design 重新查驗指定 Agent app 的核准與成果流程。` 或 `使用 $kairomes-sidebar-planning 依目前程式碼檢查尚未驗證的旅程。` skill 不依賴這個研究日期永遠有效；涉及現行功能仍重新讀官方來源、程式碼與根目錄公開文件。修改 repository skill 後，要同步本機副本。

## 目前實作狀態

| 範圍 | 目前狀態 |
| --- | --- |
| D01～D05：側欄、核准與閱讀 | 已有程式碼與合成畫面／互動檢查：全名專案選擇、短核准佇列、單件詳情、狀態去重、閱讀鎖定與返回焦點 |
| D06～D07：成果與工具 | 已顯示執行時版本、exit code、輸出完整性與到期狀態；工具可搜尋及篩選，描述按需展開 |
| MCP 原生 OAuth | O01～O03 第一階段與清單相容性修補已落地；新版 Host 可無憑證讀到 Layer 41 個公開工具，本人授權後工具使用待驗；O04 合成與建置通過、發布未完成，O05 系統儲存未實作 |
| D08～D09：H1 | 已有 Desktop「選來源／接續內容」兩階段、唯讀 Codex 來源或手動摘要、複製前核對與人工確認；有效權限仍由原生側欄管理 |
| 實機相容檢查 | 合成 HTTP／SSE、stdio、可讀性及空 home CLI 握手已補；原生／宿主實際路徑仍待驗證 |
| D10 後續使用研究 | 材料與主持腳本已準備，正式多人研究另行安排；免安裝預覽只供內部工程檢查 |
| H2／P2 | 保留條件式方案，尚未實作發布包、持久摘要或合作式 lease |

D01～D09 的狀態指程式碼與合成證據，不代表所有產品驗收目標已達成；最新逐項限制與檢查結果以[可讀性與相容檢查](readability-audit.md)及[第四輪稽核](completion-audit.md)為準。原先九張 Kairomes 圖是改版前基準，不應當成改版後畫面。

## 交接決策

已落地 **P1 的 H1 選配試點程式碼**。Desktop 重用唯讀來源，讓人補足目標／下一步，審閱內容、停止來源並核對相關檔案後，手動複製到 ChatGPT。H1 來源與目的維持同一 realpath，不搬 worktree、程序、原對話或權限。一般側欄操作不需使用交接；實際接續成效待日常回饋或後續研究，未有真人量測。

第一批將接續摘要、預覽與複製集中於可信 Desktop；側欄只有既有的有效 grant 核對，沒有接續摘要卡。這項取捨保留精簡側欄，也避免把來源讀取與核准權限混在 iframe。

接收 Agent 先讀取與對帳是流程要求，不是純文字能強制的後端限制；已有全自主不因交接自動收回。要限制接收端自動執行，由人到原生側欄主動收回。H2 發布包、持久儲存與合作式 lease 依試點成效另評估。

## 原研究證據與限制

- Codex 官方文件與兩張公開示意、Claude 官方文件與兩張較早影片畫面，均區分文件、可見畫面與推論。未擷取私人 app 或宣稱公開影片是十月安裝版。
- Kairomes 九個畫面以現行元件＋合成 bridge 擷取；觀察核准／diff／權限／工具展開，以及詳情返回焦點。未接真實配對、Host、Tunnel、ChatGPT 宿主或主機執行。
- 兩份 skill 通過結構 validator，並由獨立代理用核准與跨 app 接續情境試跑。依結果補強請求版本綁定、交接資料的不可信屬性，以及 H1／H2 不同範圍。
- 現有來源／RPC／配對／核准狀態／活動五檔合成測試為 11 pass、0 fail、75 assertions。文件相對連結、來源行號範圍、UTF-8、UI 用詞與圖像尺寸已檢查；不將這些結果寫成真實帳號 E2E。

以上是研究階段的證據。後續開發已修改產品程式，驗證紀錄與新增畫面另見[實作報告](implementation.md)。依 [CONTRIBUTING](../../CONTRIBUTING.md) 執行 `bun run check`，涉及 Desktop／Tauri／sidecar 加 `bun run desktop:check`；實際宿主相容、日常使用回饋及正式多人研究分開記錄，再依接續成效決定 H2。
