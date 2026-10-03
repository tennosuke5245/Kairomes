# Kairomes 現況盤點與交接能力

盤點日期：2026-10-02（Asia/Taipei）。程式碼基準：`5edf3dcb61eb5021135ccf200f0aa7af97ddceb1`，manifest 版本 `0.1.4`。

本文件以目前程式碼、[README](../../README.md)、[CONTRIBUTING](../../CONTRIBUTING.md) 與 [SECURITY](../../SECURITY.md) 為依據。以下「已實作」表示能在原始碼中確認；不代表此次使用真實 ChatGPT 帳號、Tunnel、Desktop sidecar 或使用者的 Codex 歷史完成端到端驗證。UI 尺寸與遮擋問題標為待視覺驗證，不能直接當成已重現的缺陷。

## 1. 產品定位與表面分工

Kairomes 是 ChatGPT 使用本機專案的工具橋接與管理介面。目前側欄負責觀察、檔案檢視、核准與操作控制；對話與模型推論發生在 ChatGPT。它尚未具備 agent app 常見的持久任務、任務清單、計畫追蹤或多 Agent 編排資料模型。

| 表面 | 目前責任 | 程式碼依據 |
| --- | --- | --- |
| Desktop | 背景 Host 與 Tunnel 生命週期、Credential Manager 金鑰設定、專案掛載、Extension 配對、疑難排解 | [App.tsx](../../apps/desktop/src/App.tsx#L490)、[api.ts](../../apps/desktop/src/api.ts#L70) |
| Extension 原生 DOM | 本機配對、核准／拒絕、停止命令／終端機、逐步確認／自主模式、下游 MCP 管理 | [sidepanel.html](../../apps/extension/sidepanel.html#L10)、[sidepanel.ts](../../apps/extension/src/sidepanel.ts#L218) |
| Extension 內 localhost iframe | 動態、專案檔案、搜尋、操作結果、圖片、變更／命令／終端機詳情 | [main.tsx workbench 分支](../../apps/widget/src/main.tsx#L681) |
| 聊天內 MCP App | 選用嵌入工作台、工具結果卡；宿主具備能力時才可送文字或更新模型上下文 | [bridge.ts](../../apps/widget/src/bridge.ts#L134)、[tools.ts](../../apps/daemon/src/tools.ts#L214) |
| Daemon 與共享 protocol | 授權分離、工具 schema、工作區操作與程序管理、活動快照 | [preview.ts](../../apps/daemon/src/preview.ts#L175)、[activity.ts](../../packages/protocol/src/activity.ts#L1) |
| 選用本機 handoff CLI | Codex 工作階段清單與有限歷史快照，僅輸出本機預覽 | [handoff.ts](../../apps/cli/src/handoff.ts#L9) |

`workbench_open` 的公開描述明確要求使用者想在聊天中嵌入工作台時才呼叫。日常工作已有 Extension，因此設計不應把嵌入工作台當成配對或工具連線的前提。

## 2. 當前資訊架構與互動

### 2.1 首次使用與配對

1. 使用者在 Desktop 掛載資料夾，設定官方 Tunnel profile 與 Runtime API Key，再將 Extension ID 貼到 Desktop。
2. 側欄顯示 Extension ID、配對連結的密碼輸入框與「連接工作台」；命令列與疑難排解位於可展開區域。
3. 使用者送出時要求 loopback host permission；配對結果存放在 Extension `storage.session` 的可信上下文。
4. 已過期但符合續發條件的配對連結可換新；服務重啟或實例不符則需要重新配對。
5. 舊式工作台網址可進入瀏覽模式，但沒有側欄核准憑證。應區分「可看工作台」與「可核准」。

依據：[配對 HTML](../../apps/extension/sidepanel.html#L32)、[配對流程](../../apps/extension/src/sidepanel.ts#L501)、[URL 驗證](../../apps/extension/src/pairing.ts)、[manifest](../../apps/extension/manifest.json)。

### 2.2 日常側欄

側欄由兩個權限層組成。Extension 頂列有品牌、核准連線狀態、操作權限選單、待核准件數、執行中工作數量、解除配對；下方以 localhost iframe 顯示工作台。原生核准卡與執行中面板會浮在 iframe 上方。

iframe 的 `workbench` 模式有：

- 左側專案縮寫導覽列；選專案會開啟檔案詳情並暫停即時跟隨。專案完整名稱由 tooltip 與 accessible name 提供。
- 中央「動態」串流；僅顯示 `source === "mcp"` 的最近 30 筆，提供即時跟隨／回到最新與「查看」。
- 右側詳情檢視：即時摘要、檔案、圖片、變更、命令、終端機。寬畫面可拖曳或使用鍵盤調整 inspector。
- 小於或等於 760 px 時，專案列維持 58 px；詳情覆蓋中央畫面，開啟時動態設為不可見，使用「返回動態」回到串流。
- 底列顯示工作台連線狀態與版本。設定入口位於專案列底部，傳送限定類型的訊息讓 Extension 開啟設定。

依據：[主要布局](../../apps/widget/src/main.tsx#L720)、[詳情](../../apps/widget/src/main.tsx#L846)、[窄版 CSS](../../apps/widget/src/styles.css#L2162)、[ActivityPanel](../../apps/widget/src/activity-panel.tsx#L126)、[設定訊息檢查](../../apps/extension/src/sidepanel.ts#L489)。

### 2.3 核准、權限與停止

| 功能 | 目前行為 | 依據 |
| --- | --- | --- |
| 檔案變更核准 | 顯示摘要、操作與相對路徑、到期時間；以同一批次再檢查版本並套用。原生核准通道提供完整 diff；超過 192 KiB 則準備階段拒絕整批，要求拆小 | [approval-panel.ts](../../apps/extension/src/approval-panel.ts#L88)、[file-changes.ts](../../apps/daemon/src/file-changes.ts#L170)、[changes.ts](../../packages/workspace-core/src/changes.ts#L310) |
| 一次性命令核准 | 顯示 argv、執行檔、起始絕對位置、timeout 與主機權限說明；只核准這次請求 | [approval-panel.ts](../../apps/extension/src/approval-panel.ts#L98)、[command.ts](../../packages/protocol/src/command.ts) |
| 終端機核准 | 核准整個主機 shell 工作階段 15 分鐘；並非逐條命令核准或 OS sandbox | [approval-panel.ts](../../apps/extension/src/approval-panel.ts#L105)、[terminal.ts](../../apps/daemon/src/terminal.ts) |
| 逐步確認 | 每批檔案變更、命令與終端機等待本機使用者決定 | [access-panel.ts](../../apps/extension/src/access-panel.ts#L51) |
| 檔案自主 | 工作區內具版本檢查的結構化變更可自動套用；不授予 shell | [access-panel.ts](../../apps/extension/src/access-panel.ts#L53)、[access.test.ts](../../apps/daemon/src/access.test.ts#L102) |
| 全自主 | 授權指定起始專案的命令與終端機，15／60／240 分鐘或直到手動收回；程序仍有自身期限 | [access-panel.ts](../../apps/extension/src/access-panel.ts#L82)、[SECURITY](../../SECURITY.md) |
| 執行中工作 | 待核准與正在執行分開；只有合適狀態的命令／終端機有取消或停止按鈕 | [active-work-panel.ts](../../apps/extension/src/active-work-panel.ts#L20)、[approval-state.ts](../../apps/extension/src/approval-state.ts) |
| 未確認的核准結果 | 重新讀取狀態，不自動重送核准；連線未恢復時停用操作 | [sidepanel.ts](../../apps/extension/src/sidepanel.ts#L234) |

自主模式作用於同一服務實例的專案，沒有聊天級歸屬隔離；其他聊天也可能使用。UI 不能以「只允許這個聊天」描述目前的 grant。全自主可以存取工作區外和網路；起始專案選擇不等於安全隔離。

### 2.4 設定與下游 MCP

側欄設定有「一般」與「MCP 整合」。一般說明操作權限與 Tunnel；MCP 整合可新增 stdio 或 Streamable HTTP server、重新整理 catalog、啟停 server 與個別工具、移除整合。新增後目前所有工具立即開啟，介面明示只加入信任的 MCP；風險標示來自下游 server，屬參考資訊。

模型經固定 broker 搜尋 catalog、讀取工具 schema、以當前 catalog revision 呼叫工具；不能掛載或啟停 server，也不能讀取啟動設定與憑證。依據：[mcp-panel.ts](../../apps/extension/src/mcp-panel.ts#L70)、[MCP 管理端點](../../apps/daemon/src/preview.ts#L329)、[broker tools](../../apps/daemon/src/tools.ts#L174)。

## 3. 現有能力與不能當成已實作的功能

| 領域 | 可以依現況使用 | 尚未有現行證據／限制 |
| --- | --- | --- |
| 專案檔案 | 列出、分頁讀取、文字搜尋、圖片預覽、具版本檢查的結構化變更 | 沒有通用 IDE、任意檔案編輯器、Git commit／PR 審查中心 |
| 圖片 | 工作區已有 PNG／JPEG／WebP；下游 MCP 圖片結果卡與本機預覽 | ChatGPT → 本機媒體匯入已退出公開 MCP tool/schema 路徑；不能因內部 manager、UI 與測試仍存在而宣稱可用 |
| 程序 | 一次性 argv 命令、各別 stdout／stderr cursor、退出碼、互動 shell、取消／停止 | 沒有 OS sandbox；取消不能復原檔案或遠端副作用 |
| 觀察 | 同實例活動、即時快照、精確操作結果、命令／變更／終端機狀態 | 沒有持久完整稽核、跨重啟任務歷史或聊天逐字稿 |
| 對話 | 聊天內 MCP App 在宿主支援時可送文字與更新模型上下文 | Extension／本機 workbench 沒有 ChatGPT 聊天後端；不能自動讀／寫網頁聊天 |
| 任務 | 操作與專案歸屬、待使用者處理與進行中狀態 | 沒有 task ID、conversation ID、計畫、阻塞原因或多步任務完成模型 |
| 接力 | Codex 同專案歷史的明確選用本機快照 | 沒有 sidebar 精修／發布／取用交接包，也沒有執行權轉移或來源停止保證 |

公開工具名稱依 [tools.ts](../../apps/daemon/src/tools.ts#L53)；共享 schema 與 UI resource 版本依 [protocol/index.ts](../../packages/protocol/src/index.ts#L20)。目前 `WIDGET_URI` 為 `ui://kairomes/workbench/v6.html`，不相容的 UI resource 變更需依專案規則升版。

圖片匯入的停用敘述在 [MCP server instructions](../../apps/daemon/src/server.ts#L52)。本機媒體上限與模型回傳上限不是同一概念，設計文件與 UI 不應混用這兩種數字。

## 4. 狀態、資料與安全邊界

### 4.1 目前可重用資料

- `ActivityEntry`：`id`、序號與 focus 序號、來源、操作種類、狀態、時間、workspace／file／command／session／change／result ID；**沒有聊天或任務 ID**。見 [activity.ts](../../packages/protocol/src/activity.ts#L6)。
- `ActivitySnapshot`：一般 UI 的活動、掛載專案、命令、變更與終端機狀態；不含核准 fingerprint 或絕對 cwd。
- `PanelSnapshot`：僅可信 Extension 取得核准 fingerprint、絕對 cwd、workspace 名稱與 access grants。見 [PanelSnapshot](../../packages/protocol/src/activity.ts#L48)。
- `ActivityStore`：最多 200 筆記憶體活動；每筆保留結果最多 256 KiB，五分鐘到期，最多 40 筆與總計 4 MiB。視覺上的完成列不代表詳情仍可讀取，更不代表永久稽核紀錄。見 [activity store](../../apps/daemon/src/activity.ts#L37)。
- 命令與檔案變更已具有 request UUID 與 fingerprint；不確定結果要讀取同 ID 的狀態，不可換 ID 自動重跑。

diff 的兩種通道不同：原生 `FileChangeApproval.diff` 直接使用已準備的完整 diff，最多 192 KiB；一般工具 `file_change_poll` 的結果再裁至 48 KiB。單件核准頁可重用現有原生資料，不應以截斷的 MCP／iframe poll 結果替代，亦不需要為目前受限完整 diff 新增模型端接口。

### 4.2 目前連線層級

Extension 的「核准連線」由 `/api/panel/stream` 的授權快照決定；iframe 的「工作台已連線」表示本機 workbench 可用；Desktop 另有本機、Tunnel 與最近 ChatGPT MCP 請求的狀態。這些是不同證據，不能合併成「ChatGPT 正在執行此任務」。`kairomes_status` 的公開描述也明確不驗證 ChatGPT 或 Tunnel 連線。

Extension 串流失敗會以 1 秒起始、最多 15 秒的退避重連；401／403 使配對失效並停用控制。重連只接收快照，不能把最後資料當成最新狀態。見 [串流](../../apps/extension/src/sidepanel.ts#L382)、[status tool](../../apps/daemon/src/tools.ts#L206)。

### 4.3 可重用端點與不可穿越的責任

| 路徑／機制 | 目前責任 | 新 UI 的限制 |
| --- | --- | --- |
| `/api/panel/pair`、`pair/renew` | Extension origin 限定的短期配對交換 | 只能由明確本機使用者流程啟動；不得把配對碼交給模型 |
| `/api/panel/stream` | 可信側欄核准與 grant 快照 | 可以提供 Inbox／執行中清單資料；不可將完整 panel snapshot 放進 iframe 或 MCP |
| `/api/panel/approvals` | 檔案／命令／終端機核准、拒絕、停止 | 核准仍留原生 Extension DOM；需既有請求 fingerprint |
| `/api/panel/access` | 使用者授權與收回 | 不接受 iframe 訊息代核准或代開自主模式 |
| `/api/panel/mcp` | 信任本機使用者管理整合 | 不向模型提供掛載、啟停或憑證管理能力 |
| `/api/activity/stream`、`result` | 一般工作台活動快照與有限結果 | 可重構資訊架構；不得當成持久任務或來源聊天歷史 |
| `/api/tools`、`/api/mcp` | 工具呼叫與共享 MCP relay | 現行沒有 handoff tool；不能把泛用 Codex RPC 接口直接開給模型 |

端點與 origin／token 分離見 [preview.ts](../../apps/daemon/src/preview.ts#L175)、[一般 UI/MCP/admin 檢查](../../apps/daemon/src/preview.ts#L430)。Extension 接收 iframe 訊息時同時檢查來源 window、精確 origin 與訊息類型；目前僅允許開設定。瀏覽器沒有 ChatGPT 網域 permission、content script、cookies 或 debugger 權限。

## 5. Codex → ChatGPT + Kairomes 交接現況

### 5.1 已經存在的基礎

目前正式拼法為 `handoff`。CLI 支援 `handoff list --workspace <folder>` 與 `handoff snapshot <id> --workspace <folder>`，並可明確指定來源 home。此指令會透過官方 Codex `app-server --stdio` 讀取選定的本機來源；不自行讀取 `auth.json`。

`CodexSessionSource` 只請求 `thread/list`、`thread/read`、`thread/turns/list`：

- 只列精確相同、經 realpath 驗證的專案，不含子專案與其他 history。
- snapshot ID 必須先出現在此來源的清單；讀取前重新核對 workspace。
- 一頁最多 50 筆；snapshot 預設最近 3 turns，可接受 1～10。
- completed turns 與 failed／interrupted partial turns 分開；in-progress turn 只保留狀態，不匯入活動中的文字。
- 保留公開 user／agent 文字與命令的有限狀態／退出碼；排除推理、原始工具結果、圖片 URL、附件、未知 item。
- 文字總預算 24,000 字元、單段預設 6,000；每 turn 訊息／命令動作也有數量上限。使用已知格式遮罩不保證排除所有私人資料。

依據：[CLI](../../apps/cli/src/handoff.ts#L10)、[來源讀取](../../apps/daemon/src/agent-sessions.ts#L83)、[snapshot](../../apps/daemon/src/agent-sessions.ts#L121)、[摘要組裝](../../apps/daemon/src/agent-sessions.ts#L155)、[RPC child](../../apps/daemon/src/codex-rpc.ts#L16)。

快照具有 `schemaVersion: 1`、來源、capture timestamp、workspace cwd、完成／partial／pending turns、coverage 與 warnings；`scope` 是 `local-preview`，`permissions` 是 `not-transferred`，`taskState.goal/plan/decisions` 刻意維持 `null`。它是有限證據摘錄，尚未產生能讓另一個 Agent 可靠接手的目標、決策與下一步。

CLI 產物只有 stdout 的格式化 JSON，**沒有檔案產物路徑、資料庫寫入或持久交接包**。`list` 回傳 `{ sessions, nextCursor, note }`；每筆 session 為 `{ id, provider: "codex", title, updatedAt, sourceStatus }`。`snapshot` 回傳上列 `HandoffSnapshot`，另外加上 `workingTree`。其 `workingTree.state` 可能為 `available`（`capturedAt/branch/head/files/truncated/note`）或 `unavailable`（`capturedAt/reason`）。檔案列為 `{ status, path, previousPath? }`；沒有 diff 或內容 digest。完整型別見 [HandoffSnapshot](../../apps/daemon/src/agent-sessions.ts#L28)，stdout 組裝見 [handoff.ts](../../apps/cli/src/handoff.ts#L43)。

Git 觀察只讀取確定屬於交接工作區根目錄的目前 branch、HEAD 與 porcelain 狀態，最多 200 筆。不讀 diff、不自動保存工作、不把目前 dirty files 宣稱為來源 Agent 的改動；無 commit 的 unborn HEAD 是有效狀態。見 [handoff-working-tree.ts](../../apps/daemon/src/handoff-working-tree.ts#L22)。

### 5.2 明確缺口

1. 沒有 trusted Desktop／Extension 的工作階段挑選 UI；現在只能操作 CLI。
2. 沒有使用者可編輯的目標、完成事項、決策、待驗證內容、下一步與接收者閱讀卡。
3. 沒有交接包儲存、失效、撤回、發布與 MCP 取用契約。
4. 快照含絕對 cwd，不能原樣暴露給模型；須映射為目前掛載的 opaque workspace ID 與相對路徑。
5. 獨立 app-server 的 idle／notLoaded 不證明原本 Codex Desktop 已停止；不能以此顯示「可以安全接手」。
6. 沒有跨 Agent 的寫入 lease。交接不轉移核准，也不證明測試仍適用目前檔案。
7. 沒有一般側欄發訊功能。現行 embedded widget 的 `app.sendMessage` 受宿主 capability 控制，不能拿來推定 Extension 也能自動將內容送入 ChatGPT。

目前倉庫可追溯的相關實作始於 `dbef01f`；現存追蹤 Markdown 未包含一份獨立的舊交接開發提案。因此本盤點以現行 CLI／安全敘述為基礎，不把先前對話中可能討論過的自動 handoff 當成已落地能力。

### 5.3 產品判斷與建議 MVP

交接值得規劃，作為使用者明確選用的「工作接續包」。它能處理來源工具配額／連線中斷、從 coding app 切回 ChatGPT 討論與繼續驗證、另一位 Agent 接手同一個本機專案等情境。但前置優先級應低於側欄狀態／核准可讀性、任務與操作歸屬，避免加入一個無法可靠辨識任務的切換按鈕。

第一階段建議流程：

1. 使用者從 Desktop 或可信 Extension 的專案選「從 Codex 接續」，明確選來源工作階段。
2. 顯示來源與 capture timestamp、涵蓋範圍、partial／pending 警示；建立草稿，**不自動發布**。
3. 使用者檢視並編輯目標、目前狀態、已做事項、決策、尚未驗證事項與下一步。歷史文字保持來源資料身份，不當作新的使用者授權。
4. 使用者停止來源後，記錄「使用者確認已停止」與時間；系統仍顯示這不是技術性互斥保證。若有 pending turn 或正在執行程序，預設阻擋宣稱已完成接力。
5. 重新讀目前工作樹與相關檔案版本；不同 HEAD、檔案 digest、未掛載／卸載或來源變更均讓草稿失效或要求重新核對。
6. MVP 輸出精簡可複製的接續文字，由使用者貼到 ChatGPT 原生輸入框。此版本不需要新增聊天 DOM permission，也不需要源聊天全文暴露。
7. 接收 Agent 先核對現在檔案、工作樹與測試證據，再以當前 Kairomes 權限請求操作。既有自主 grant 不由交接帶入或偷偷擴大。

若使用情境驗證需要更短的交接流程，再增加「使用者發布過的交接包」只讀 MCP 取用：可信本機面建立／編輯／發布／撤回，模型端僅能讀 opaque pack ID 與 workspace ID。此時應建立獨立共享 schema、內容 digest、版本、到期／撤回狀態、來源／使用者編輯來源標記、長度上限，並讓接收者看見摘要覆蓋不足。不要加入任意 thread read、來源路徑、來源 credential 或任意 Codex RPC endpoint。

跨 Agent lease 可作後續研究：Kairomes 能約束自己處理的寫入與 grant，不能約束仍可自由寫主機的外部 Codex 程序。合作式 lease 只能宣稱避免相容客戶端同時操作，不能包裝為 OS 隔離。

## 6. 設計審查時需驗證的具體風險

以下是原始碼導出的假設，應在純 fixture 的 320／360／400／480／760 px、鍵盤與縮放條件驗證。

| 觀察 | 對產品的可能影響 | 對應驗證 |
| --- | --- | --- |
| 小於或等於 720 px 隱藏頂列 `connection-status`；底列僅說工作台連線 | 看得到工作台但不能核准，或 Tunnel 未連線時，使用者可能誤認全功能正常 | 斷線、過期配對、工作台可用但核准無法使用的 fixture |
| 小於或等於 620 px 頂列改為兩行；核准卡浮層從固定 top 開始 | 多卡、長專案名與自主模式標籤可能佔滿狹窄側欄 | 同時 3／10 件待核准、1／5 件執行中、縮放 200% |
| 核准詳情與 action text 多處使用 10 px；diff 使用 10 px monospace | 主機存取與 argv 的判斷資料可能難讀 | 文字可讀性、觸控目標、長路徑與 multiline argv |
| 核准動作在 diff 前，diff 預設折疊 | 使用者可能未閱讀實際變更就點擊；需清楚提供完整差異與截斷範圍 | 同一批多檔、長 diff、未知結果，優先級與查看動線 |
| 專案導覽以 initials 與 tooltip 呈現 | 同名縮寫與多專案時辨識成本上升 | 1／5／20 專案、相同縮寫、鍵盤 tooltip |
| 動態看的是同實例所有 MCP 操作，沒有聊天 ID | 多聊天交錯時容易誤認為目前聊天的進度 | 兩個合成來源交錯；明示目前歸屬能力，不靠時間猜測 |
| 詳情五分鐘過期但活動列仍可能存在 | 「完成 → 查看」可能失敗，使用者不知道是已過期 | 結果過期、重啟、記憶體上限淘汰，顯示可恢復與不可恢復狀態 |
| 開啟詳情會隱藏動態；核准又在外層浮層 | 需要跨層保持焦點、理解目前位置 | Tab／Shift+Tab／Escape、卡片消失、重連、返回觸發器 |
| 同一筆操作可同時出現於原生核准卡、動態列、待確認 notice、右側摘要；其中有重複名稱／狀態／檔案 | 窄版側欄可能為同一件事重複閱讀多段文字 | 核准卡保留判斷所需資料；其他位置採件數與一行狀態；以 fixture 確認哪些資訊會同時可見 |
| setup 前言、表單說明、進階區重複解釋配對與連線；一般設定再說明頂列權限 | 首次流程的操作步驟被解釋文字拉長 | 先呈現一個主要動作，操作說明縮成一行，細節移入一次性的說明入口 |

CSS 依據：[窄版頂列](../../apps/extension/sidepanel.css#L1382)、[核准浮層](../../apps/extension/sidepanel.css#L1083)、[核准字級](../../apps/extension/sidepanel.css#L1116)、[widget 窄版詳情](../../apps/widget/src/styles.css#L2162)。已有焦點恢復與 reduced motion 程式碼，重構應保留並以互動測試確認。

文字密度依據：[setup 與一般設定](../../apps/extension/sidepanel.html#L35)、[待確認 notice 與動態卡](../../apps/widget/src/activity-panel.tsx#L171)、[摘要重複操作狀態](../../apps/widget/src/overview-panel.tsx#L282)、[核准卡詳情](../../apps/extension/src/approval-panel.ts#L88)。使用者要求 UI 嚴禁大量文字與重複敘述，因此後續設計須明確分配同一資訊的主顯示位置；詳細工程文件可以完整，介面應只顯示當下決策需要的短句。這裡是程式碼推論，實際同時顯示的情境與密度由視覺審查文件判定。

## 7. 可重用測試與安全視覺入口

### 7.1 現存測試

| 測試 | 可以支撐的新設計驗收 |
| --- | --- |
| [agent-sessions.test.ts](../../apps/daemon/src/agent-sessions.test.ts) | 先列出才能讀、精確專案限制、不可 resume、partial／active 區分、排除推理／工具結果、文字與遮罩上限、unborn HEAD |
| [codex-rpc.test.ts](../../apps/daemon/src/codex-rpc.test.ts) | 合成 stdio child 的回覆配對、等待上限、斷線拒絕；不是實際帳號歷史驗證 |
| [live-workbench.test.ts](../../apps/daemon/src/live-workbench.test.ts) | 精確結果、活動上限、配對綁定／撤銷／續發、focus 與 output 分離、快照清理 |
| [workbench.test.ts](../../apps/daemon/src/workbench.test.ts) | MCP／UI／admin 權限分離、iframe 邊界、沒有聊天後端、共享 relay 與側欄生命週期 |
| [command-http.test.ts](../../apps/daemon/src/command-http.test.ts)、[file-change-http.test.ts](../../apps/daemon/src/file-change-http.test.ts) | MCP 或 iframe token 不能代核准；review data 僅限 trusted panel |
| [access.test.ts](../../apps/daemon/src/access.test.ts) | grant 撤銷、到期、配對失效、解除掛載、程序期限、檔案自主不能獲得 shell |
| [pairing.test.ts](../../apps/extension/src/pairing.test.ts)、[approval-state.test.ts](../../apps/extension/src/approval-state.test.ts) | 只接受 literal loopback／一次性碼、沒有 ChatGPT 注入／Cookie、只有待核准卡浮層、停止狀態 |
| [activity-panel.test.ts](../../apps/widget/src/activity-panel.test.ts) | 即時跟隨選擇 meaningful MCP focus，不被到達順序、output 或本機瀏覽取代 |

新增交接包時必須補：未經發布不可供 MCP 讀取、pack 與 workspace 不匹配、撤回／到期、來源內容注入、版本過期、內容 budget、權限不轉移、不能任意讀其他來源、來源仍活動與 lease 限制。不能僅驗證成功流程。

此次安全 fixture 驗證執行五個測試檔：`agent-sessions`、`codex-rpc`、`approval-state`、`pairing`、`activity-panel`，結果 **11 pass／0 fail，75 assertions**。這些測試使用合成來源或暫存工作區，沒有讀取真實 Codex 歷史。

### 7.2 不接觸使用者資料的視覺入口

- Desktop 可用 `bun run desktop:web` 啟動前端；[api.ts](../../apps/desktop/src/api.ts#L15) 在非 Tauri 環境提供合成資料。`?demo=setup`、`ready`、`error`、`runtime-error` 可看設定、已準備、Tunnel 錯誤與 runtime 錯誤。不要以這個 mock 宣稱真實流程驗證。
- [tests/approval-preview.ts](../../tests/approval-preview.ts#L7) 只建立合成的 ApprovalPanel／AccessPanel，沒有 credential、bridge 或主機執行能力；適合以靜態 HTML＋browser bundle 顯示。
- [tests/settings-preview.ts](../../tests/settings-preview.ts) 提供合成 Chrome DevTools MCP catalog 與整合管理畫面；設定 mutation 只更新 fixture 狀態。
- [tests/fixtures.ts](../../tests/fixtures.ts) 建立暫存專案與 state，僅有合成 README 與程式碼。
- [preview-live.ts](../../apps/daemon/src/preview-live.ts#L22) 是隔離 fixture 工作台，但會啟動測試 daemon／MCP child 並包含命令／終端機測試控制，**不是純靜態入口**；其輸出含私人工作台權杖 URL，不可放進公開文件、截圖或聊天。純設計盤點優先使用前兩種 mock fixture。

本盤點沒有啟動真實 daemon／sidecar，沒有讀取實際 Codex 聊天、配對資訊或本機工作台權杖。
