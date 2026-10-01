# 安全回報

目前為 `0.1.3` 預覽版，尚無正式支援的穩定發佈版本。主線包含 ChatGPT 網頁 MCP 工具、瀏覽器側欄、工作區檔案讀取與結構化變更、一次性命令、需本機批准的終端機及使用者掛載的下游 MCP。不要把本工具當作能隔離本機惡意程序的 sandbox。

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
