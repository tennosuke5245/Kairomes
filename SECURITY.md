# 安全回報

目前原始碼為 `0.3.0`，公開下載仍為 `0.1.4` 預覽版，尚無正式支援的穩定發佈版本。本文安全邊界依原始碼說明；0.2.0 起的精簡側欄、原生 MCP OAuth、Desktop H1 接續，以及 0.3.0 的新介面、唯讀 Git、批次讀檔與 ChatGPT 圖片匯入，都尚未包含於 `v0.1.4` 發佈檔案。主線包含 ChatGPT 網頁 MCP 工具、瀏覽器側欄、工作區檔案讀取與結構化變更、唯讀 Git、一次性命令、需本機批准的終端機、使用者掛載的下游 MCP，以及會向 OpenAI 檔案網域發出 HTTPS 下載的圖片匯入。不要把本工具當作能隔離本機惡意程序的 sandbox。

目前公開倉庫尚未啟用 GitHub 的 [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。若發現能讀取未掛載路徑、繞過核准或預覽權限、洩漏憑證等問題，請先開一則不含漏洞細節的 issue，請求私人聯絡方式。啟用並驗證 **Security → Report a vulnerability** 入口後，可從該處私密回報。絕對不要在公開 issue／PR 張貼密鑰、私人檔案或利用步驟。

回報請包含版本、Bun／OS 版本、最小重現方式與不含秘密的測試資料。維護者會先在私密管道確認影響及修補方式，再協調公開揭露；目前尚未承諾固定回應時限。

已知限制：

- 純 TypeScript 路徑檢查不能完全消除具有主機寫入權限的程序所製造的 TOCTOU 競態。
- 已知 token 格式遮罩無法取代完整的資料分類或秘密管理。
- preview token 只提供程序範圍的本機存取，不隔離已能操作同一個 OS 使用者的程式。
- stdio 的安全邊界是啟動它的呼叫端與該 OS 使用者；對外 Tunnel 權限由官方 client／Platform 管理。
- 共享模式 `serve --attach` 只代理 MCP 訊息到指定 loopback route，不代理審批頁或一般 HTTP URL。不要把整個 app port 暴露到公網。
- UI、MCP 與 admin token 分離；私人 state directory 的 `workbench-connection.json` 含本機連接秘密，不可提交或分享。Unix 建立 mode 0600；Windows 保護依 OS profile ACL，不是跨同一使用者程序的隔離。
- Extension 要求 `sidePanel`、`storage`，配對時另外由使用者允許可選的 `http://127.0.0.1/*` host permission；不要求 ChatGPT 網域存取，沒有聊天 DOM 注入、cookies 或 debugger 權限，打包檢查會拒絕其他權限。`Alt+Shift+K`（`_execute_action`）只等同按工具列圖示開啟側欄；圖示徽章只顯示待確認數，側欄離線、配對失效、解除配對或關閉時清除，不做決定，也不在背景輪詢。工作台 iframe 只多委派 `clipboard-write`，不能讀取剪貼簿。主頁僅允許明確指定的一個 Extension ID 嵌入，審批頁禁止嵌入；這不能保護已遭替換的本機擴充功能原始碼。
- `pair` 經本機 admin 權限產生兩分鐘一次性碼，交換獨立的側欄核准憑證。每分鐘最多 30 次交換嘗試、最多 8 個有效配對；憑證上限 12 小時，只存於 Extension `storage.session` 的可信上下文，解除配對或重啟 app 可撤銷。不把 admin token、配對碼或側欄憑證交給模型／iframe，也不接受 iframe 訊息代核准。
- 只有 `/api/panel/*` 對指定 Extension origin 提供精確 CORS；核准還需側欄 bearer token 及既有請求 fingerprint。UI／MCP／admin token 不能拿來冒充側欄憑證。核准控制由 Extension 原生 DOM 呈現，和 localhost iframe 分離；核准、拒絕與停止都要求使用者真實操作（`event.isTrusted`），每次開啟詳情後 0.7 秒內不能決定，避免連點誤決定下一件。自動前進只開啟下一件，不重送未確認的決定。
- 唯一不要求 Origin 的是讀取待審原圖的 `GET /api/panel/imports/:id/content`：Chromium 對持有本機 host permission 的 Extension 頁面發出 GET 時不帶 Origin，因此沒有 Origin 且 `Sec-Fetch-Site` 為 `none` 或缺少時接受。同源頁面（工作台）會送出 `same-origin` 而被拒；有 Origin 時仍須是指定 Extension，側欄 bearer token 照常必要，其他路由與方法不變。網頁不能在沒有 CORS 的情況下替 GET 加上 `Authorization`，而 CORS 請求一定帶 Origin；能取得側欄權杖的本機程序原本就能偽造 Origin，因此不擴大可存取範圍。
- 本機工作台的 HTTP 本文上限為 320 KiB，stdio relay 轉送前套用相同上限；超過回 413，chunked 本文回 411。只有圖片上傳路由接受最多 25 MiB 的串流本文，且先檢查 Origin 與權杖、讀完後再核對配對。
- 側欄專案選擇只影響瀏覽與核准佇列篩選，不限制某個聊天、不變更 grant，也不改變模型工具的 workspace 參數。工作台只接受可信父頁的精確 origin／window source 與限定格式的訊息：導覽（`workbench-ready`、`workbench-status`、`workspace-select`、`open-settings`）、不含資料的 `file-drag`／`file-paste` 提示（只能讓側欄顯示拖放提示或開啟匯入對話框），以及側欄送給工作台的 `open-artifact`（只含工作區 UUID 與相對路徑，工作台以自己的 `artifact_preview` 唯讀開啟）；其中不含權杖、圖片內容或核准能力。原生核准綁定開啟審閱時的完整內容與 fingerprint，內容改變須重新審閱；截斷 diff 不可核准。核准通道、工作台資料及 ChatGPT／安全通道狀態分開，保留的舊快照不能用來決策。
- 活動串流為驗證後的完整快照，最多 12 個觀察連線、有慢讀者背壓、心跳與清理；一般 UI 快照不含核准 fingerprint 或絕對 cwd。側欄快照只附待核准與套用中變更的審閱差異，命令與終端機輸出不觸發側欄快照。檔案／搜尋結果有記憶體保留上限及五分鐘期限，不是永久審計紀錄。
- 關閉 relay 不回收 app 的終端機。解除側欄配對會撤銷該配對的完整主機存取及其終端機；未受完整存取接管、原先手動核准的 session 仍存活至原期限，需另行停止。app 重啟更換 token，relay 不自動切換實例。
- 自主模式僅可由指定 Extension origin + 有效 panel token 啟用，不能透過 workbench iframe／MCP／admin token 啟用。檔案自主只授權結構化工作區變更；全自主才授權命令與終端機。期限可為 15／60／240 分鐘或持續至手動收回；持續授權仍不持久保存，配對失效、解除掛載或 app 關閉都會回收。以起始 workspace 選擇適用 session，不代表 sandbox；同一實例其他聊天也能使用。個別命令沿用自己的 timeout，持續授權建立的單一終端機最多存活 4 小時；收回會停止該工作區受 grant 管理的程序。任何 grant 都不核准圖片匯入。模型只看得到每個工作區的核准模式（`per_request`／`files`／`full`）與到期時間，看不到 grant ID、擁有者、配對權杖或收據；模型與工作台都不能啟用、延長或收回 grant。
- 本機核准頁（舊式審批頁）使用獨立權杖，不能由 MCP 工具或工作台權杖直接批准，也不列出或核准圖片匯入；admin 路由對所有匯入核准回 `IMPORT_APPROVAL_PANEL_ONLY`，拒絕與停止仍可用。截斷的 diff 在此頁也不能套用。終端機核准會給予整個 shell 工作階段 15 分鐘的主機使用者權限，包括任意指令、檔案修改、工作區外存取與連網。
- 拒絕原因只能由配對側欄（`/api/panel/approvals`）或 admin 通道（`/api/approvals`）隨拒絕送出；MCP、工作台與 `/api/tools` 的輸入沒有此欄位，核准或停止帶原因會被拒。原因須為單行 1～200 字且含可見文字，拒收控制、零寬、雙向標記、BOM、TAG 與變體選擇字元（只在 emoji 序列保留 ZWJ 與 VS15／VS16）。儲存前遮蔽已知金鑰格式、本機網址（核准頁、配對連結）與 64 位十六進位權杖，再以 `denial_reason` 交給模型；使用者自己輸入的其他私人文字不會被過濾。原因只存在記憶體，不寫入日誌，也不屬於 fingerprint。
- 終端機輸出不保證秘密遮罩。主機 shell 能透過 OS 權限讀取其他資料，即使起始 cwd 通過工作區檢查也不構成隔離。
- Windows Job Object 只管理已加入群組的程序；POSIX process group 無法約束自行脫離群組的後代。Bun FFI 仍屬實驗性功能。
- 結構化檔案變更與第三方 MCP 掛載已實作，但沒有持久、完整的安全審計紀錄，也沒有 OS sandbox。
- 一次性命令具有獨立 argv／cwd／timeout／request UUID 與本機核准指紋；不提供 MCP 自行核准。受控 helper 在私人 state 目錄等待 IPC，先納入 Windows Job／POSIX 群組才啟動目標，且 stdout／stderr 不能冒充控制 IPC。主機執行仍可超出工作區、讀取主機憑證或連網；指紋不會凍結腳本或依賴檔案。
- 完整主機 grant 同時涵蓋一次性命令與互動終端機。取消、逾時、授權到期及正常完成都回收命令受管理後代；取消無法復原檔案或遠端副作用。配對撤銷不停止原本個別核准、未由 grant 接管的命令，仍受自己的 timeout 約束。
- 命令各輸出流有記憶體上限及截斷標記，不保證秘密遮罩。去重 request ID／結果只在同一服務實例有效；結果不明或 app 重啟後不能自行換 ID 重跑。記憶體清單不是持久審計紀錄。
- `command_poll`／`terminal_poll` 的 `wait_ms` 最多 20 秒，每個服務同時最多 2 個等待者；等待中佔用 relay 與 `/api/mcp` 各一個並行名額，用戶端斷線不會提早釋放，只在有變化、逾時或服務關閉時結束。
- `mcp_tool_call`／`mcp_read_call` 在 Host 執行期間記住最近 4096 個 `request_id`（最多 24 小時，只存路由、tool_ref 與參數的雜湊，不存參數值），同一 ID 至多送到下游一次；可能已送達後才失敗時回 `MCP_CALL_UNKNOWN`，不重送。下游要求登入（401）也視為可能已執行，登入後以同一 ID 重試仍回 `MCP_CALL_UNKNOWN`。紀錄只在記憶體；Host 或 Desktop 重啟、或超出保存範圍後，相同 ID 會被當成新呼叫，因此 `mcp_tool_call` 不標示為 idempotent。
- `handoff` 為明確選用的本機 CLI：官方 App Server 只呼叫 list／read／分頁 turns，不 resume 或 start 推論；與舊聊天 ownership mapping 分離。來源資料夾必須已存在，只匯入明確專案的已列出紀錄，排除推理、附件、原始工具結果。已知秘密遮罩不保證排除所有私人資料；預覽不自動發布到 MCP。具有完整主機 shell 權限的 Agent 仍能自行呼叫 CLI，不能將此限制視為主機隔離。
- 交接不轉移權限，也不證明來源 Agent 已停止或歷史測試仍有效。不同 Agent 同時寫入同一工作樹的 lease 尚未實作；正式接力前須人工停止來源並確認內容與目前版本。

## 唯讀 Git 與檔案搜尋

- `git_status`／`git_diff`／`git_log` 只在工作區根目錄正好是 Git 工作樹根目錄，且儲存庫資料屬於此工作區時執行：`.git` 資料夾本身，或能回指此工作區的連結工作樹與子模組。指向他處的 gitfile、`commondir`、`.git` 連結、替代物件庫（`objects/info/alternates`）、`.git` 內的符號連結或 junction，以及 partial clone 與 promisor remote，一律回 `unsupported_config`，不讀取其他儲存庫。
- 每次呼叫使用固定 argv、不經 shell，5 秒逾時、輸出上限 256 KiB，stderr 丟棄。停用 hooks、fsmonitor、外部 diff、textconv、簽章驗證、子模組遞迴與 pager；`GIT_ALLOW_PROTOCOL` 封鎖所有傳輸並設定 `GIT_NO_LAZY_FETCH`。環境變數只保留最小集合，不繼承 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 或 `GIT_CONFIG_*`。`git status` 使用 `--no-optional-locks`，工作樹差異使用 `diff-files`，讀取不改寫 `.git/index`。
- 儲存庫、工作樹或命令列範圍定義的 filter 會停用，依賴它們的檔案（例如 git-crypt）可能顯示為已修改。只定義在系統或全域設定的 filter（例如 Git LFS）照常執行，與一般 `git` 相同，也就是讀取 Git 狀態時會啟動使用者自己安裝的 filter 程式；儲存庫設定 `lfs.extension.*` 時停用全部 filter。系統與全域設定（例如 `safe.directory`、include）仍會被讀取。
- 私有路徑（`.git`、`.env*`、金鑰、`node_modules`、`dist` 等）、符號連結、子模組，以及檔名含雙引號或「 b/」而無法安全比對的檔案不輸出內容，只計入 `omitted_private`；超過 1024 字元的路徑略過並計數。舊或新內容含 `PRIVATE KEY-----` 標記的檔案，所有 hunk 改為 `[PRIVATE KEY REDACTED]`；其他格式的金鑰只靠既有遮蔽規則，不是保證。commit 標題、作者名稱、分支與 upstream 名稱會遮蔽、截斷後提供給模型，電子郵件不提供。
- `file_search` 與 `file_find` 共用走訪器：每個資料夾先經路徑檢查再列出，列出後以 dev／ino 重新核對；檔案以 `O_NOFOLLOW` 開啟，讀取後核對所在資料夾與 inode；略過私有名稱、符號連結、junction 與多重硬連結檔案。每次最多走訪 4000 個項目、3 秒、讀取 8 MiB。glob 只比對工作區相對字串、不用來開啟路徑，並拒絕 `..`、開頭的 `/` 或 `!` 與反斜線；查詢一律逐字比對，不接受正規表示式。`file_find` 只回名稱與類型，硬連結檔案的名稱仍可能出現，但內容不會被讀取。`file_read_many` 一次最多 8 個檔案，共用 48 KiB 輸出。
- Node 沒有 `openat`／`O_BENEATH`，逐層核對只能縮小 TOCTOU 視窗；能在正確時機反覆交換路徑的本機程序，本來就以同一使用者身分執行。

## ChatGPT 圖片匯入

- `image_import_request`／`image_import_poll`／`image_import_cancel` 讓模型請求把對話圖片存成專案內的新檔。請求可帶 ChatGPT 依 `_meta["openai/fileParams"]` 填入的頂層 `file`，或省略 `file` 進入 `awaiting_file`，由使用者在側欄提供圖片。模型看得到狀態、格式、大小、尺寸與 SHA-256，看不到下載網址、檔案 ID、檔名、fingerprint 或上傳 ID。**宿主交付檔案的途徑已實作，尚未以真實 ChatGPT 驗證。**
- 下載只接受 HTTPS、443 埠、沒有帳密或 fragment 的 OpenAI 網域（`oaiusercontent.com`、`chatgpt.com`、`openai.com`、`oaistatic.com` 及其子網域，另加一個固定的 OpenAI 圖片儲存主機）；拒絕 IP 字面值、結尾點、`/mnt/data` 等沙箱路徑、Base64 與其他網址。全部 DNS 結果須為公開單播位址（IPv4-mapped 與 NAT64 以內含的 IPv4 判斷），連線固定到已核對的位址，並保留原網域的 TLS 驗證；不送 Cookie、憑證或 Referer，不使用 proxy。最多 2 次重新導向（每次重新核對），總時間 20 秒，串流計數 25 MiB；內容開頭須為 PNG／JPEG／WebP 簽章，HTML 或 JSON 會立即停止。錯誤只回固定分類，不含網址、主機或 IP；下載網址只在下載期間存在記憶體，不進入畫面、活動、快照或日誌。
- 圖片須為靜態 PNG／JPEG／WebP、最大 25 MiB、16 MP、每邊最多 16,384 px，副檔名須符合實際格式；這是容器與檔頭的結構檢查，不是完整解碼或惡意內容掃描。記憶體中最多同時保留 3 張圖片（ChatGPT 下載最多佔 2 張），匯入結束即清零並釋放。未完成的匯入名額由模型（4）與側欄（2）分開計算，模型不能佔滿使用者的名額；等待圖片與等待核准各 10 分鐘到期，接收與驗證最多 60 秒。紀錄、收據與 `request_id` 只存記憶體，Host 重啟後不保留，也不保證跨重啟恰好一次。
- 側欄路由：`POST /api/panel/imports`（自行匯入）、`POST /api/panel/imports/:id/file`（上傳原圖，以 `X-Kairomes-Upload-Id` 冪等，60 秒接收期限）、`GET /api/panel/imports/:id/content`（讀回待審原圖，`no-store`、`nosniff`）。三者都需要側欄權杖，Origin 規則見上。結果不明時，同一份 bytes 只沿用同一個上傳 ID 重試。
- 每張圖片只能在配對側欄個別核准，不參考檔案自主或全自主 grant。核准前，同一配對須先經內容路由讀取目前版本的原圖，否則回 `IMPORT_PREVIEW_REQUIRED`；fingerprint 綁定匯入 ID、工作區、路徑、SHA-256 與大小，bytes 改變即失效。側欄比對完整 SHA-256、大小、格式與尺寸並解碼後才啟用「匯入圖片」；預覽畫在 canvas 上，不建立圖片網址，Extension CSP 與權限不變。服務端只能證明 bytes 已交給該側欄，不能證明側欄已核對。
- 寫入只建立新檔：以 exclusive link 建立，連結前再核對，父資料夾須已存在；寫入後在暫存連結仍持有 inode 時讀回並核對。失敗只清理自己的暫存檔；結果不明時標為「結果待確認」並鎖定，只能查詢狀態，不自動重試。
- 工作台與 MCP 結果卡拿不到側欄權杖，也沒有上傳或核准控制。「從 ChatGPT 選擇圖片」只在 ChatGPT 宿主提供選檔功能時出現，只接受 https 網址並直接放進工具參數。發起者（ChatGPT 或側欄）由本機服務記錄，模型提供的說明標示為未經驗證。
- 剩餘風險：DNS 固定連線只在 Linux 上以 Bun 1.4.2 手動確認，Windows 未驗證；需要 proxy 才能連外的環境無法下載，請改用側欄貼上。網域清單涵蓋 OpenAI 主要網域，模型可指向任何公開的 OpenAI 託管圖片，但仍需預覽與使用者核准。

## Desktop 與 Companion

- Desktop webview 不取得權杖、Runtime API Key 或私人網址，也沒有核准、拒絕或收回控制。總覽只顯示待確認的數量、種類與最早到期，grant 的工作區與到期時間（不含 grant ID、擁有者或名稱），以及最近呼叫時間；Companion 每次狀態輪詢讀取 admin 核准清單，只回傳這些摘要。外部工作台的 grant 顯示為「權限待確認」。
- `desktop-status` 事件內容與 `get_desktop_status` 相同，不含權杖；系統匣提示只有固定文字與數量，紅點圖示不含文字。
- 絕對路徑只經 `get_workspace_paths` 顯示在 Desktop 專案卡。Companion 的 `workspace_details` 只回給持有控制權杖的呼叫端（Desktop 與 Companion 頁），不進入快照、事件、系統匣、MCP、工作台或 Extension。`reveal_workspace` 只接受 opaque ID，由 Companion 解析根目錄，拒絕連結、檔案與不存在的資料夾。改名沿用新增時的名稱規則，不改變根目錄身分或讀取權限。
- `open_external` 是固定允許清單（API keys、ChatGPT Connectors、Tunnel 指南、tunnel-client releases、Platform Tunnels 與 Kairomes releases），webview 不能傳入網址；`perform_action` 碰不到結束、工作區變更、Extension 設定、詳情與診斷。Desktop 到 Companion 的 loopback 連線不使用系統 proxy，也不跟隨重新導向。重新啟動本機服務、移除金鑰、解除掛載與更換 Extension ID 都先確認，文案不聲稱可以復原。配對連結只存在 Desktop 記憶體，以遮蔽方式顯示，到期、離開頁面或配對完成即清除。
- Tunnel 意外結束後依 2／10／30 秒退避自動重啟，5 分鐘內最多 3 次；使用者停止或結束，或原因是金鑰、profile、找不到 tunnel-client 時不重啟，啟動失敗也不重試。`CONTROL_PLANE_API_KEY` 只傳給 tunnel-client，與手動啟動相同。使用者停止的狀態只在記憶體，重新啟動整個 runtime 會再自動啟動 Tunnel。Tunnel 原因是列舉值，不含原始日誌；Companion 頁「最近訊息」的日誌尾端已去除控制字元並遮蔽已知金鑰，Desktop 不顯示原始日誌或 sidecar 錯誤輸出。
- 診斷摘要只含固定的檢查 ID、狀態、代碼、Tunnel 原因、修正建議、數量與版本，其他欄位一律捨棄；診斷不連線或啟動 MCP，讀取 MCP 設定上限 1 MiB。`/healthz`（loopback、精確 Host、免驗證）會回傳版本；`/api/connection`（UI 權杖，工作台也持有）回傳已配對側欄數量。外部回傳的版本字串只接受純 semver。

## 原始碼 H1 接續邊界

可信側欄的未知核准結果以原 ID、fingerprint 與對應狀態核對。MCP 管理回應遺失後不自動重送；catalog list 僅代表可讀的現況，須符合原目標與預期結果才解除變更鎖，關閉表單不能跳過核對。新增設定還須核對同來源、新 ID、name／transport／enabled 與完整配置 SHA-256；`config_fingerprint` 只在可信 panel 回應，不將啟動設定或 fingerprint 提供給一般 MCP catalog／widget。它不驗證實際程序、resolved 環境值或副作用恰好一次。串流 EOF 與取消後的資料不能恢復操作資格。

待確認的 MCP 管理操作依工作台來源保留；切換來源後，舊回覆不能更新新來源或解除其變更鎖。目錄快照同步核對配置、工具及登入身份，避免跨配置混用。

新增 MCP 配置須完成原子保存後才出現在記憶體目錄；失敗會清理暫存檔，並行新增仍受 16 台上限約束。連線失敗只提供已知錯誤碼的短分類，不回傳原始錯誤、啟動路徑或 stderr。stdio 橋接程式可自行處理 OAuth，Kairomes 不取得其登入權杖。原始碼的直接 HTTP OAuth 使用獨立本機登入管理器，邊界如下。

- 只有精確 Extension Origin、有效 panel bearer、當次 instance 與配置身份可操作 `/api/panel/mcp-auth`。模型、iframe、UI／MCP／admin token 不能開始登入或取得憑證。登入頁只在明確操作後由 Host 的受控 opener 開啟；背景探索及工具呼叫不開頁或註冊新 client。
- 首版為公開 HTTPS 的 DCR public client、PKCE S256；token、registration、discovery、state 與 verifier 僅存 Host 記憶體，不保存明文或傳回側欄。重啟後需重新登入。清除登入只清除本機憑證，不承諾服務端撤銷或復原遠端工作。
- 每台服務最多一件活動登入、每個 Host 最多四件；回呼 listener 僅綁 loopback，期限五分鐘，核對 path、Host、method、state、issuer 與原配置。取消、停用、移除、owner 解除配對及關閉使在途登入失效。已完成登入屬於 Host 的服務配置；解除配對不假稱撤銷已完成的第三方授權。
- Provider 寫入受認證世代與配置身份約束；清除登入及配置生命週期變化先使舊世代失效，晚到的 token 更新或回呼不能恢復工具。原 `tools/call` 回 401 或有效 Bearer `insufficient_scope` 403 時，在 SDK 自動認證與重送前截斷；到期更新在原工具發送前進行，登入完成不重播工具。已送出的下游工作仍可能是未知結果，request ID 不能保證第三方恰好執行一次。
- OAuth 請求隔離 MCP headers，拒絕非 HTTPS、帳密／fragment、redirect、私有與保留 IP。HTTP MCP 連線同樣不跟隨重新導向：MCP SDK 1.31 起預設自行跟隨同源重新導向，Kairomes 明確設定 `redirectPolicy: "follow"`，把重新導向交回不跟隨的 fetch 處理。查核全部 DNS 結果後直接連接固定 IP，保留原網站的 Host、TLS SNI 與憑證驗證；metadata／token 的大小及期限有上限。內網 OAuth 不在首版支援範圍，loopback callback 例外不適用於遠端 endpoints。
- OAuth 操作以 owner、原 UUID、完整輸入與首次接受期限核對。完整收據十分鐘／最多 64 件；已見 ID 的有界紀錄在當次 Host 中不重用，上限 1024。容量滿時拒絕新動作；查詢與已登錄登入的取消仍可用。收據 expired／missing 保留未知，只有已確認的新清除操作可重設本機登入。未完成身份存於可信 `storage.session`，不含 OAuth 秘密，也不授予新權限。
- 初始化與工具清單失敗以安全分類分開，錯誤碼只接受已知分類與 HTTP 狀態，不傳回遠端 body、私人 URL 或原始錯誤。每工具 input／output schema 的序列化合計上限為 64 KiB，超限時整份清單不可用，舊工具不能繼續呼叫；128 項工具與 32 KiB 呼叫參數上限保持不變。
- 回呼頁區分「已連線」、「授權已完成」與「登入未完成」；只有重新連線及工具清單成功才稱已連線。HTML 不插入請求或 OAuth 資料，不含 script、表單或外部資源，使用固定 CSS hash CSP、`no-store` 與 `no-referrer`。

新版側欄的自主模式變更綁定原請求 ID、完整輸入、期限及配對身份。操作收據只在可信 `/api/panel/access` 查詢；同 ID 不重新執行，收據遺失或到期不能解除未知鎖。啟用結果不明時，收回先阻止原啟用晚到，再使用既有撤銷流程；重新連線或相同 grant 不代表處理完成。未完成身份只保存在可信 `storage.session`，不含歷史或新增權限，不交給 iframe／模型。收據與去重身份只存本機記憶體、容量有限；必要時使用既有解除配對流程收回該配對所有 grant，不能說成只收回單一專案。舊式無請求 ID 的 client 保持相容，但沒有新收據的對帳保證。

- Desktop 經可信本機 Companion 管理通道呼叫 `/api/handoff`；要求 loopback host、精確 Origin、獨立控制 bearer token 與 JSON body，body 上限 64 KiB。此路由沒有提供給 MCP、工作台 iframe 或模型，也不是任意 Codex RPC 代理。
- 每個 Companion 實例最多保留 4 份記憶體草稿，閒置 10 分鐘失效；取消、到期或關閉服務會清理來源 reader。初始化中的 UUID 保留至原請求結束，逾時只取消，不讓晚回覆清理相同 UUID 的新草稿。草稿不發布到 MCP、不持久保存。來源讀取只容許初始化及 `thread/list`、`thread/read`、`thread/turns/list`，不啟動、恢復或代送推論。來源紀錄須與已掛載工作區相同 realpath，不能用此流程跨 worktree 接續。
- 人工必填目標及下一步。已知密鑰、私人本機網址與常見絕對路徑會阻擋預覽，但格式檢查不能保證排除全部敏感資料；仍需人工審閱。預覽不附整份逐字稿、推理、附件或原始工具輸出。
- 版本核對最多 20 個相對路徑、合計 8 MiB；單檔沿用 1 MiB、一般 UTF-8 文字檔與既有連結安全檢查。缺檔、二進位、超限或無法確認的檔案保留 unknown，基準不完整不能完成複製準備。複製前再次核對來源、掛載身份、檔案版本及可用的 Git 基準；HEAD 相同不能單獨證明工作樹相同。
- 「已停止來源」與「已核對權限」是使用者聲明。複製準備只接受受支援的閒置來源；未知、異常或仍進行中都不能取得準備資格。檢查不能證明外部 Codex 程序已停止，也沒有強制 writer lock。H1 不操作 grant；需要限制自動執行時，使用者須在可信原生側欄收回相應授權，會影響同實例其他工作。接續內容是待核對資料，不是執行指令或權限；複製不等於 ChatGPT 已收到或開始接手。
