# MCP 新增、登入等待與通知修補

日期：2026-10-03。本文件記錄原生 OAuth 實作前的連線修補與當時驗證；後續已加入 [第一階段原生登入](mcp-oauth-implementation.md)。尚未更新使用者正在執行的 Desktop／Extension，也未完成 Layer 真實帳號登入驗證。

## 問題與判斷

使用者畫面顯示新增 MCP 已出現在目錄，但無法連線、零工具，且「結果待確認」使管理控制停用。這不足以證明設定保存失敗，也不能單靠通用錯誤認定 OAuth 是唯一原因。

[Layer 官方說明](https://layer.ai/mcp)要求首次 OAuth 登入，stdio 客戶端可使用 `mcp-remote`。當時 Kairomes 的直接 HTTP 掛載沒有 OAuth 登入流程；stdio 橋接可由外部程式處理 OAuth。原先 Host 初始化與側欄請求都只等 10 秒，可能先於 npm 啟動或使用者登入完成而逾時。[mcp-remote 說明](https://github.com/punkpeye/mcp-remote/blob/main/README.md)另有自己的登入回呼期限，可用 `--auth-timeout` 設定。可填入的公開參數見 [README](../../README.md#需要-oauth-登入的-mcp)。

## 已修正

| 範圍 | 現在行為 |
| --- | --- |
| 等待連線 | stdio 初始化上限 120 秒；HTTP 初始化與工具清單仍各 10 秒；側欄 MCP 管理請求上限 150 秒，目錄查詢仍 10 秒 |
| 等待中的 UI | 真正等待新增回覆時顯示「正在加入…」；不推測正在 OAuth 登入 |
| 未知新增結果 | 關閉表單後保留「查詢狀態」；只讀原目錄，不重送新增 |
| 核對成功 | 同來源、新 ID 與完整配置身份符合才解除鎖；即使 MCP 無法連線，也能重新探索或解除掛載 |
| 舊 Host | 唯一新增目標缺少配置指紋時提示更新 Kairomes；不同配置或身份缺失仍保留鎖 |
| 本機離線 | 查詢入口先走既有串流重連；只讀目錄不能替代有效的本機通道 |
| 通知布局 | 設定中的通知與查詢動作放在主內容寬度內；工作台復原動作留在連線狀態旁。通知消失後高度為零 |
| 保存失敗 | 原子保存成功後才加入記憶體目錄；失敗不留下新增配置殘影，並行掛載上限仍為 16 台 |
| 短診斷 | 僅分類已知的程式／工作目錄、權限與 SDK 逾時錯誤；其他維持通用訊息，不回傳原始錯誤或 stderr |

主要程式：[McpPanel](../../apps/extension/src/mcp-panel.ts)、[變更核對](../../apps/extension/src/mcp-mutation.ts)、[側欄協調](../../apps/extension/src/sidepanel.ts)、[Host](../../apps/daemon/src/mcp-host.ts)。

## 驗證

- `bun run check`：304 tests、0 fail、2444 assertions；包含建置、TypeScript 與 Biome。
- `bun run desktop:check`：Desktop sidecar、前端建置、Cargo check、fmt、clippy 通過。
- Host 針對性測試：12 tests、127 assertions。期限以 SDK stub 核對選項，不假稱真的等待 120 秒；不存在的合成程式確實經啟動失敗，HTTP 回傳已保存配置、unavailable、零工具及完整指紋。Bun／SDK 未保留啟動錯誤碼時仍為通用文案。
- MCP 核對測試：11 tests、75 assertions，包含缺少及不同指紋、原來源與只讀恢復。
- Chrome 合成頁使用實際側欄協調器與假 fetch／SSE：新增回覆遺失後關閉表單，離線、恢復網路再按查詢，串流由 2 增至 3，新增仍為 1 次；公布配置後按查詢，唯讀次數由 10 增至 11，串流仍為 3、新增仍為 1。
- 核對後新增／重新探索／解除掛載可操作，通知 `display:none`、高度 0；400px 的 scrollWidth 為 400。869px 的通知與標題左緣皆為 272.125px，scrollWidth 為 869。

| 畫面 | 證據 |
| --- | --- |
| [通知寬版](evidence/core-flow/mcp-notice-wide.jpg)，869×900 | 一則短通知與一個查詢入口，對齊設定內容 |
| [通知窄版](evidence/core-flow/mcp-notice-400.jpg)，400×900 | 窄版不溢出；未知結果保留變更鎖 |
| [核對後窄版](evidence/core-flow/mcp-recovered-400.jpg)，400×900 | 設定已確認但連線仍失敗；管理按鈕恢復，通知沒有空白色帶 |

合成頁沒有執行 `npx`、真實 MCP、登入、使用者資料夾或配對。畫面中的連線狀態不能當作 Layer 或 ChatGPT 的真實連線證據。

## 仍需分開處理

本文當時只修復既有 stdio 橋接的等待與恢復。後續直接 HTTP OAuth 已加入原始碼，但 Layer 首次登入是否開啟瀏覽器、登入完成後能否列出工具，仍需要在更新後由實際帳號使用者確認。失去「重新探索」回覆時，單憑目錄仍不能證明該次探索已完成，不解除這類未知結果鎖。

原生登入、取消、憑證與工具探索見 [開發規格](mcp-oauth-plan.md)與[實作紀錄](mcp-oauth-implementation.md)；其新增驗證不計入本文歷史測試結果。
