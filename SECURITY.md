# 安全回報

目前原始碼為 `0.2.0`，公開下載仍為 `0.1.4` 預覽版，尚無正式支援的穩定發佈版本。本文安全邊界依原始碼說明；精簡側欄、原生 MCP OAuth 與 Desktop H1 接續尚未包含於 `v0.1.4` 發佈檔案。主線包含 ChatGPT 網頁 MCP 工具、瀏覽器側欄、工作區檔案讀取與結構化變更、一次性命令、需本機批准的終端機及使用者掛載的下游 MCP。不要把本工具當作能隔離本機惡意程序的 sandbox。

目前公開倉庫尚未啟用 GitHub 的 [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。若發現能讀取未掛載路徑、繞過核准或預覽權限、洩漏憑證等問題，請先開一則不含漏洞細節的 issue，請求私人聯絡方式。啟用並驗證 **Security → Report a vulnerability** 入口後，可從該處私密回報。絕對不要在公開 issue／PR 張貼密鑰、私人檔案或利用步驟。

回報請包含版本、Bun／OS 版本、最小重現方式與不含秘密的測試資料。維護者會先在私密管道確認影響及修補方式，再協調公開揭露；目前尚未承諾固定回應時限。

已知限制：

- 純 TypeScript 路徑檢查不能完全消除具有主機寫入權限的程序所製造的 TOCTOU 競態。
- 已知 token 格式遮罩無法取代完整的資料分類或秘密管理。
- preview token 只提供程序範圍的本機存取，不隔離已能操作同一個 OS 使用者的程式。
- stdio 的安全邊界是啟動它的呼叫端與該 OS 使用者；對外 Tunnel 權限由官方 client／Platform 管理。
- 共享模式 `serve --attach` 只代理 MCP 訊息到指定 loopback route，不代理審批頁或一般 HTTP URL。不要把整個 app port 暴露到公網。
- UI、MCP 與 admin token 分離；私人 state directory 的 `workbench-connection.json` 含本機連接秘密，不可提交或分享。Unix 建立 mode 0600；Windows 保護依 OS profile ACL，不是跨同一使用者程序的隔離。
- Extension 要求 `sidePanel`、`storage`，配對時另外由使用者允許可選的 `http://127.0.0.1/*` host permission；不要求 ChatGPT 網域存取，沒有聊天 DOM 注入、cookies 或 debugger 權限。主頁僅允許明確指定的一個 Extension ID 嵌入，審批頁禁止嵌入；這不能保護已遭替換的本機擴充功能原始碼。
- `pair` 經本機 admin 權限產生兩分鐘一次性碼，交換獨立的側欄核准憑證。每分鐘最多 30 次交換嘗試、最多 8 個有效配對；憑證上限 12 小時，只存於 Extension `storage.session` 的可信上下文，解除配對或重啟 app 可撤銷。不把 admin token、配對碼或側欄憑證交給模型／iframe，也不接受 iframe 訊息代核准。
- 只有 `/api/panel/*` 對指定 Extension origin 提供精確 CORS；核准還需側欄 bearer token 及既有請求 fingerprint。UI／MCP／admin token 不能拿來冒充側欄憑證。核准控制由 Extension 原生 DOM 呈現，和 localhost iframe 分離。
- 側欄專案選擇只影響瀏覽與核准佇列篩選，不限制某個聊天、不變更 grant，也不改變模型工具的 workspace 參數。工作台只接受可信父頁的精確 origin／window source 與限定格式的導覽訊息；其中不含權杖或核准能力。原生核准綁定開啟審閱時的完整內容與 fingerprint，內容改變須重新審閱；截斷 diff 不可核准。核准通道、工作台資料及 ChatGPT／Tunnel 狀態分開，保留的舊快照不能用來決策。
- 活動串流為驗證後的完整快照，最多 12 個觀察連線、有慢讀者背壓、心跳與清理；一般 UI 快照不含核准 fingerprint 或絕對 cwd。檔案／搜尋結果有記憶體保留上限及五分鐘期限，不是永久審計紀錄。
- 關閉 relay 不回收 app 的終端機。解除側欄配對會撤銷該配對的完整主機存取及其終端機；未受完整存取接管、原先手動核准的 session 仍存活至原期限，需另行停止。app 重啟更換 token，relay 不自動切換實例。
- 自主模式僅可由指定 Extension origin + 有效 panel token 啟用，不能透過 workbench iframe／MCP／admin token 啟用。檔案自主只授權結構化工作區變更；全自主才授權命令與終端機。期限可為 15／60／240 分鐘或持續至手動收回；持續授權仍不持久保存，配對失效、解除掛載或 app 關閉都會回收。以起始 workspace 選擇適用 session，不代表 sandbox；同一實例其他聊天也能使用。個別命令沿用自己的 timeout，持續授權建立的單一終端機最多存活 4 小時；收回會停止該工作區受 grant 管理的程序。
- 本機審批頁使用獨立權杖，不能由 MCP 工具或工作台權杖直接批准。核准會給予整個 shell 工作階段 15 分鐘的主機使用者權限，包括任意指令、檔案修改、工作區外存取與連網。
- 終端機輸出不保證秘密遮罩。主機 shell 能透過 OS 權限讀取其他資料，即使起始 cwd 通過工作區檢查也不構成隔離。
- Windows Job Object 只管理已加入群組的程序；POSIX process group 無法約束自行脫離群組的後代。Bun FFI 仍屬實驗性功能。
- 結構化檔案變更與第三方 MCP 掛載已實作，但沒有持久、完整的安全審計紀錄，也沒有 OS sandbox。
- 一次性命令具有獨立 argv／cwd／timeout／request UUID 與本機核准指紋；不提供 MCP 自行核准。受控 helper 在私人 state 目錄等待 IPC，先納入 Windows Job／POSIX 群組才啟動目標，且 stdout／stderr 不能冒充控制 IPC。主機執行仍可超出工作區、讀取主機憑證或連網；指紋不會凍結腳本或依賴檔案。
- 完整主機 grant 同時涵蓋一次性命令與互動終端機。取消、逾時、授權到期及正常完成都回收命令受管理後代；取消無法復原檔案或遠端副作用。配對撤銷不停止原本個別核准、未由 grant 接管的命令，仍受自己的 timeout 約束。
- 命令各輸出流有記憶體上限及截斷標記，不保證秘密遮罩。去重 request ID／結果只在同一服務實例有效；結果不明或 app 重啟後不能自行換 ID 重跑。記憶體清單不是持久審計紀錄。
- `handoff` 為明確選用的本機 CLI：官方 App Server 只呼叫 list／read／分頁 turns，不 resume 或 start 推論；與舊聊天 ownership mapping 分離。來源資料夾必須已存在，只匯入明確專案的已列出紀錄，排除推理、附件、原始工具結果。已知秘密遮罩不保證排除所有私人資料；預覽不自動發布到 MCP。具有完整主機 shell 權限的 Agent 仍能自行呼叫 CLI，不能將此限制視為主機隔離。
- 交接不轉移權限，也不證明來源 Agent 已停止或歷史測試仍有效。不同 Agent 同時寫入同一工作樹的 lease 尚未實作；正式接力前須人工停止來源並確認內容與目前版本。

## 原始碼 H1 接續邊界

可信側欄的未知核准結果以原 ID、fingerprint 與對應狀態核對。MCP 管理回應遺失後不自動重送；catalog list 僅代表可讀的現況，須符合原目標與預期結果才解除變更鎖，關閉表單不能跳過核對。新增設定還須核對同來源、新 ID、name／transport／enabled 與完整配置 SHA-256；`config_fingerprint` 只在可信 panel 回應，不將啟動設定或 fingerprint 提供給一般 MCP catalog／widget。它不驗證實際程序、resolved 環境值或副作用恰好一次。串流 EOF 與取消後的資料不能恢復操作資格。

待確認的 MCP 管理操作依工作台來源保留；切換來源後，舊回覆不能更新新來源或解除其變更鎖。目錄快照同步核對配置、工具及登入身份，避免跨配置混用。

新增 MCP 配置須完成原子保存後才出現在記憶體目錄；失敗會清理暫存檔，並行新增仍受 16 台上限約束。連線失敗只提供已知錯誤碼的短分類，不回傳原始錯誤、啟動路徑或 stderr。stdio 橋接程式可自行處理 OAuth，Kairomes 不取得其登入權杖。原始碼的直接 HTTP OAuth 使用獨立本機登入管理器，邊界如下。

- 只有精確 Extension Origin、有效 panel bearer、當次 instance 與配置身份可操作 `/api/panel/mcp-auth`。模型、iframe、UI／MCP／admin token 不能開始登入或取得憑證。登入頁只在明確操作後由 Host 的受控 opener 開啟；背景探索及工具呼叫不開頁或註冊新 client。
- 首版為公開 HTTPS 的 DCR public client、PKCE S256；token、registration、discovery、state 與 verifier 僅存 Host 記憶體，不保存明文或傳回側欄。重啟後需重新登入。清除登入只清除本機憑證，不承諾服務端撤銷或復原遠端工作。
- 每台服務最多一件活動登入、每個 Host 最多四件；回呼 listener 僅綁 loopback，期限五分鐘，核對 path、Host、method、state、issuer 與原配置。取消、停用、移除、owner 解除配對及關閉使在途登入失效。已完成登入屬於 Host 的服務配置；解除配對不假稱撤銷已完成的第三方授權。
- Provider 寫入受認證世代與配置身份約束；清除登入及配置生命週期變化先使舊世代失效，晚到的 token 更新或回呼不能恢復工具。原 `tools/call` 回 401 或有效 Bearer `insufficient_scope` 403 時，在 SDK 自動認證與重送前截斷；到期更新在原工具發送前進行，登入完成不重播工具。已送出的下游工作仍可能是未知結果，request ID 不能保證第三方恰好執行一次。
- OAuth 請求隔離 MCP headers，拒絕非 HTTPS、帳密／fragment、redirect、私有與保留 IP。查核全部 DNS 結果後直接連接固定 IP，保留原網站的 Host、TLS SNI 與憑證驗證；metadata／token 的大小及期限有上限。內網 OAuth 不在首版支援範圍，loopback callback 例外不適用於遠端 endpoints。
- OAuth 操作以 owner、原 UUID、完整輸入與首次接受期限核對。完整收據十分鐘／最多 64 件；已見 ID 的有界紀錄在當次 Host 中不重用，上限 1024。容量滿時拒絕新動作；查詢與已登錄登入的取消仍可用。收據 expired／missing 保留未知，只有已確認的新清除操作可重設本機登入。未完成身份存於可信 `storage.session`，不含 OAuth 秘密，也不授予新權限。
- 初始化與工具清單失敗以安全分類分開，錯誤碼只接受已知分類與 HTTP 狀態，不傳回遠端 body、私人 URL 或原始錯誤。每工具 input／output schema 的序列化合計上限為 64 KiB，超限時整份清單不可用，舊工具不能繼續呼叫；128 項工具與 32 KiB 呼叫參數上限保持不變。
- 回呼頁區分「已連線」、「授權已完成」與「登入未完成」；只有重新連線及工具清單成功才稱已連線。HTML 不插入請求或 OAuth 資料，不含 script、表單或外部資源，使用固定 CSS hash CSP、`no-store` 與 `no-referrer`。

新版側欄的自主模式變更綁定原請求 ID、完整輸入、期限及配對身份。操作收據只在可信 `/api/panel/access` 查詢；同 ID 不重新執行，收據遺失或到期不能解除未知鎖。啟用結果不明時，收回先阻止原啟用晚到，再使用既有撤銷流程；重新連線或相同 grant 不代表處理完成。未完成身份只保存在可信 `storage.session`，不含歷史或新增權限，不交給 iframe／模型。收據與去重身份只存本機記憶體、容量有限；必要時使用既有解除配對流程收回該配對所有 grant，不能說成只收回單一專案。舊式無請求 ID 的 client 保持相容，但沒有新收據的對帳保證。

- Desktop 經可信本機 Companion 管理通道呼叫 `/api/handoff`；要求 loopback host、精確 Origin、獨立控制 bearer token 與 JSON body，body 上限 64 KiB。此路由沒有提供給 MCP、工作台 iframe 或模型，也不是任意 Codex RPC 代理。
- 每個 Companion 實例最多保留 4 份記憶體草稿，閒置 10 分鐘失效；取消、到期或關閉服務會清理來源 reader。初始化中的 UUID 保留至原請求結束，逾時只取消，不讓晚回覆清理相同 UUID 的新草稿。草稿不發布到 MCP、不持久保存。來源讀取只容許初始化及 `thread/list`、`thread/read`、`thread/turns/list`，不啟動、恢復或代送推論。來源紀錄須與已掛載工作區相同 realpath，不能用此流程跨 worktree 接續。
- 人工必填目標及下一步。已知密鑰、私人本機網址與常見絕對路徑會阻擋預覽，但格式檢查不能保證排除全部敏感資料；仍需人工審閱。預覽不附整份逐字稿、推理、附件或原始工具輸出。
- 版本核對最多 20 個相對路徑、合計 8 MiB；單檔沿用 1 MiB、一般 UTF-8 文字檔與既有連結安全檢查。缺檔、二進位、超限或無法確認的檔案保留 unknown，基準不完整不能完成複製準備。複製前再次核對來源、掛載身份、檔案版本及可用的 Git 基準；HEAD 相同不能單獨證明工作樹相同。
- 「已停止來源」與「已核對權限」是使用者聲明。複製準備只接受受支援的閒置來源；未知、異常或仍進行中都不能取得準備資格。檢查不能證明外部 Codex 程序已停止，也沒有強制 writer lock。H1 不操作 grant；需要限制自動執行時，使用者須在可信原生側欄收回相應授權，會影響同實例其他工作。接續內容是待核對資料，不是執行指令或權限；複製不等於 ChatGPT 已收到或開始接手。
