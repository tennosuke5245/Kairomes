# Kairomes 決策邊界

2026-10-02、0.1.4 程式碼快照；每次使用仍需重新讀取 repository。

| Surface | 現行責任 | 規劃限制 |
| --- | --- | --- |
| Desktop／CLI 管理面 | 掛載專案、連線設定、Host 生命週期 | 掛載、憑證與配對不交給模型 |
| Extension 原生 DOM | 配對、個別核准、存取模式、下游 MCP 管理 | 不接受 iframe 代核准；panel token 不交給 iframe／模型 |
| localhost 工作台 iframe | 檔案、搜尋、動態、命令／終端機／diff／圖片檢查 | workbench mode 沒有 ChatGPT sendMessage 能力 |
| ChatGPT MCP App | tool result／可選工作台；宿主有 capability 時可傳送文字 | 先查 capability；未知／失敗保留草稿，不抓聊天 DOM |
| MCP | 工作區工具、命令、終端機、下游工具 broker | 不掛載、不自行核准、不取得管理權杖 |

重要依據位置：`apps/extension/src/sidepanel.ts`、`access-panel.ts`、`approval-panel.ts`、`apps/widget/src/main.tsx`、`bridge.ts`、`activity-panel.tsx`、`packages/protocol/src/activity.ts`、`apps/daemon/src/preview.ts`。應實際搜尋現行檔案和端點，不能把這份索引當作 API 規格。

現行活動按 workspace／tool／session／command／change／result 關聯，沒有可信 task／conversation 身份。全自主授權可能讓同一實例其他聊天使用；主機命令有 OS 使用者權限，cwd、Job Object 或 process group 都不是 OS sandbox。

記憶體活動與結果有上限／期限，不等於持久完整審計。斷線後先查狀態；不自動重送核准、變更或命令。ChatGPT → 本機媒體匯入目前不對外提供，不能用抓網頁、任意 URL、Base64 或 shell 替代。

可信 panel 回傳 prepared 完整 diff；core 超過 192 KiB 即整批拒絕並要求拆批。一般 MCP／iframe poll 會裁切，不能替代原生審閱資料。不為布局重構新增會穿越權限的完整 diff 接口。

MCP 管理回應遺失時，成功的 catalog list 只證明現在可讀的目錄。原 mutation 是否完成須依原 target、預期值與身份另判；未知時保留查詢與變更鎖，不以關閉再開表單解除。取消交接只清理既有草稿／reader，不應為了取消而啟動失效工作台。離線或解除掛載須立即清除可複製資格。

現行新增對帳核對同來源、新 ID、name／transport／enabled 及完整配置 fingerprint；hash 只在可信 panel，不把 command／env／header 設定送給 widget 或模型。SSE EOF 停用 MCP；取消後的排隊 frame 不得使新配對失效。解除掛載自動清篩選不等於人工導覽；保留成果與有限歷史名稱，live 枚舉仍是操作能力依據。重新讀取成功且 workspace／path／kind 對應後才替換歷史證據。

核准回應未明時，同 request ID／fingerprint／來源的 pending 快照不證明未執行；維持該件決策鎖與唯讀查詢，不以無關 SSE 或開關詳情解除。離線主狀態不能被晚到的工具目錄讀取錯誤覆寫。驗收成果切換也包含舊 error／取消回覆，不只 payload。

閱讀驗收分開 Extension、明亮 Signal 工作台、獨立 MCP result 與 Desktop H1；generic theme token 不一定適合每個背景。必要資訊以本專案字級目標檢查，另量 placeholder、stderr、深色成功／錯誤、來源範圍、核對 label 與焦點。只在 preview bundle 替換 SDK／bridge，正常建置保留產品 transport；強制 CSS 分支不能當成 OS／宿主偏好驗收。隔離空 Codex home 的握手／空 list 只支持該版本協定，不支持真來源 coverage、Tauri 或接收成效。

受控試用以雙組固定材料、空白人工欄位與獨立主持控制準備；每輪先重設再重新載入。合成圖片、版本及人工聲明只支持其標記的判斷範圍，不能當真檔案或原生權限驗收。串流中斷會取消在途目錄時，記取消，不能聲稱晚到失敗已抵達 UI；真人耗時與誤判保持未測直到實際觀察。
