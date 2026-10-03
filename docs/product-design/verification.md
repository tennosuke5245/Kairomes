# 第三輪：結果身份與連線驗證

日期：2026-10-02。研究基準仍是 `0.1.4`、`5edf3dcb61eb5021135ccf200f0aa7af97ddceb1`。以下是未提交、未發布的工作目錄變更，接續[第二輪紀錄](continuation.md)。使用者選擇**先不安裝 Extension**，本輪僅做程式碼、合成 transport 與瀏覽器分頁驗證。

## 修補的實際問題

| 問題 | 現在的行為 | 依據 |
| --- | --- | --- |
| 被取消的 SSE 還能交付排隊資料，舊實例可能使新配對失效 | 取消後不解析或交付；每個 frame 與實例檢查前確認目前 reader。正常 EOF 停用核准、授權及 MCP 控制 | [event-stream.ts](../../packages/protocol/src/event-stream.ts)、[sidepanel.ts](../../apps/extension/src/sidepanel.ts) |
| 同名 MCP 出現就被認為是剛才新增的設定 | 對帳核對同來源、新 ID、name、transport、enabled 及完整配置的 SHA-256；包括 argv 順序、cwd、宣告的 env 與 HTTP header_env。缺少或不同 fingerprint 仍未知 | [mcp-mutation.ts](../../apps/extension/src/mcp-mutation.ts)、[配置身份](../../packages/protocol/src/mcp-host.ts) |
| 自動解除掛載被當作人工導覽，固定閱讀被關閉 | Extension 清除失效篩選時不送導覽 null；widget 保留目前內容與來源身份，操作停用。新焦點或人工選擇才切換 | [workspace-selection.ts](../../apps/extension/src/workspace-selection.ts)、[main.tsx](../../apps/widget/src/main.tsx) |
| 重新讀取／搜尋失敗，舊內容卻改標成目前讀取 | 成功、仍是目前請求且 workspace／path／kind 對應後才替換；失敗與延遲回覆保留執行時內容 | [read-current-result.ts](../../apps/widget/src/read-current-result.ts)、[main.tsx](../../apps/widget/src/main.tsx) |
| 歷史圖片版本已更新，沒有恢復入口 | 單一「重新讀取」；成功後才標示目前預覽與新版本。圖片身份變更不顯示舊 URL，卸載後不提供操作 | [artifact-panel.tsx](../../apps/widget/src/artifact-panel.tsx) |
| 終端已卸載或歷史 ID 缺失，仍可提供操作 | 保留選擇與輸出；輸入、啟動、停止、resize 停用，不導向另一個 shell | [terminal-panel.tsx](../../apps/widget/src/terminal-panel.tsx) |
| 權限倒數在閒置時凍住 | 改顯示固定到期時間，不增加每分鐘公告 | [access-panel.ts](../../apps/extension/src/access-panel.ts) |
| Codex stdin 失效就丟失仍在執行的 reader child | 保留 child 所有權到 exit；取消有界清理。用真正 stdio 合成 peer 重現與驗證 | [codex-rpc.ts](../../apps/daemon/src/codex-rpc.ts)、[source transport 測試](../../apps/daemon/src/agent-sessions-transport.test.ts) |
| 公開 HTTPS 網址被誤認為 Windows 絕對路徑 | 分開判斷路徑與網址；公開文件可引用，正規化後的 loopback 等價寫法仍拒絕 | [handoff-sharing.ts](../../apps/daemon/src/handoff-sharing.ts) |

配置 fingerprint 僅存在可信 panel 管理回應；一般 MCP catalog／widget 不取得設定內容或 fingerprint。這個值是設定身份證據，不代表 resolved 環境值、程序成功或副作用恰好一次。原有伺服器預設開啟全部工具的政策、grant、MCP tool surface 與 `WIDGET_URI` 不變。

## 真正 HTTP／SSE 的合成驗收

以 `bun run scripts/preview-sidebar.ts` 開啟終端列出的隨機 port。`/panel-http` bundle 實際 sidepanel coordinator，只替換 Chrome API；fetch 與 SSE 經真正 loopback HTTP 傳輸。[fixture](../../tests/panel-http-fixture.ts) 僅修改記憶體，沒有掛載、核准真程序或連接真 MCP 的能力。

伺服器只接受精確 loopback Host。GET 提供合成頁與公開計數；POST 僅處理 `/synthetic-panel/control` 及有限的合成 `/api/panel/*`，要求同 origin、4096 bytes body 上限與 strict 欄位。公開零值 placeholder 不是真憑證；其他管理路由拒絕。SSE 有 heartbeat，reader／分頁取消會清理連線。[HTTP 測試](../../tests/panel-http-fixture.test.ts) 經 Bun server、fetch 與 shared reader 驗證傳輸及拒絕案例。

| 情境 | 觀察 |
| --- | --- |
| 核准已提交，HTTP 回傳 502，尚未發 SSE | coordinator 唯讀查狀態；對應 running，變更計數保持 1，沒有假失敗 alert；未重送核准 |
| SSE 正常 EOF／離線 | 核准、授權與 MCP 動作停用；本輪截圖的短提示仍被 catalog failure 覆寫成「結果待確認」，第四輪修正主狀態保護 |
| 恢復連線 | 取得新快照後恢復入口；變更計數仍 1 |
| 401 | 保留重新配對，操作停用，不自動換憑證或重送變更 |
| 跨 origin、錯 placeholder、額外欄位、未知管理路由 | HTTP 拒絕；沒有增加合成變更數 |

502 是**提交後的錯誤 HTTP 回應**，並未模擬 TCP 封包遺失。這些結果不證明原生 sidePanel、Chrome session storage／permission、真配對或 Host 程序。

閱讀驗收使用 `/reading`：讀取失敗保留版本與「執行時讀取」；即時／固定內容在解除掛載後保留、操作停用。`/reading?artifact=1` 用歷史圖片版本失效，重新讀取後換成目前版本；圖片 bytes 取自 repository 的 logo，沒有外部媒體或工作區檔案。測試控制不是產品 UI。畫面與尺寸見[證據索引](evidence/index.md#第三輪的傳輸與閱讀畫面)。

## 完成度與後續工作

這輪稽核當時未找到新的強制實作缺口。後續交叉稽核發現成果切換、核准未決與來源數量裁切仍有問題；修正與最新證據見[第四輪稽核](completion-audit.md)。本頁保留第三輪的檢查紀錄，不能據此把整體產品驗收標成完成。

| 範圍 | 目前證據 | 仍需完成 |
| --- | --- | --- |
| D01～D03 範圍與核准 | 真元件＋合成圖、版本／到期／完整差異與 HTTP 對帳測試 | 原生 Chrome／Edge sidePanel、真配對與實機未知結果 |
| D04～D06 閱讀與成果 | 固定內容、卸載、延遲回覆、結果身份、diff／exit／完整性測試 | 真 ChatGPT 宿主與來源關聯；原生無障礙 |
| D05 無障礙 | 鍵盤、尺寸與有限純色對比抽樣 | 真正 200%、讀屏公告順序、完整對比與 reduced motion 實機 |
| D07 工具檢索 | 百項合成工具、篩選與完整配置對帳 | 原生側欄的長清單與實際 MCP 生命週期 |
| D08～D09 H1 | strict 本機管理入口、來源 allowlist、真正合成 stdio、基準／取消／複製測試 | 原生 Tauri／Codex、真剪貼簿拒絕、ChatGPT 人工接收與對帳 |
| D10 | 尚未進行真人試用 | 五名測試者或五次受控接續，依開發計畫評估時間、理解與誤判 |
| H2／P2 | 條件式規格 | 先取得 H1 使用成效，再決定發布包、持久摘要或合作式 lease |

使用者目前不安裝 Extension，因此原生驗收保留待辦。本輪沒有部署、發布、建立 PR、自動發送 ChatGPT、讀取私人歷史或擴張權限。下一步按上述驗收條件進行，避免為了補合成證據而增設常駐卡片或說明文字。

## 檢查紀錄

最終 `bun run check` 通過：**199 tests、0 fail、1,343 assertions、58 個測試檔**，包括 release metadata、widget／Extension build、TypeScript 與 Biome。`bun run desktop:check` 通過：更新後的 widget、Desktop sidecar、Vite、Cargo check／fmt／clippy。沒有新增依賴或提升版本。

`bun run package:extension` 成功；ZIP 7 個檔案、CRC 與 `mcp-panel.css` 引用通過。`dist/releases/Kairomes-extension-v0.1.4.zip` 是未發布工作目錄的本機測試包，SHA-256 為 `7cc84399420cbd97c2cc9f430ec47b79e1ec8b393af5df33e1d1d0210bbe3387`；沒有安裝或發布。

新增回歸分別涵蓋：取消排隊 frame／EOF、完整配置 hash 與異體設定、真正 HTTP 提交後 502、錯 origin／額外欄位、歷史讀取身份、唯讀終端、有限歷史名稱、真正合成 stdio child／source adapter、公開 URL 與等價 loopback。Chrome 合成畫面 10 張經 metadata 檢查；兩份 repository skill 已同步本機副本並通過結構驗證。文件相對連結、繁體字與差異格式已檢查；分頁、viewport 與合成伺服器均已清理。
