# MCP OAuth 第一階段實作紀錄

日期：2026-10-03。**第一階段原始碼與合成驗證完成，尚未發布。** 對應 [開發規格](mcp-oauth-plan.md) O01～O03；O00 公開相容性已確認、帳號流程待驗，O04 核心檢查與建置完成、實機與發布待驗。O05 系統憑證儲存另行開發。本文件保留初次實作的檢查；使用者回報授權後仍無清單的修正與最新 372 項檢查見 [Layer 相容性修補](mcp-oauth-recovery.md)。

## 已實作的產品流程

HTTP 名稱與網址保存後，在對應卡片按「登入」，由 Host 開啟系統瀏覽器。收到有效回呼後建立新 MCP 連線並探索工具；只有初始化與最新工具清單都成功，才顯示「已連線」。卡片保留一行狀態與一個主要動作，登入網站／重啟限制收在連線詳情，清除登入收在管理選單。

等待登入可取消而保留掛載。啟動、取消或清除回覆遺失時，只查原操作；未知狀態只鎖該卡片。若原收據已遺失，使用者可明確清除本機登入，以新清除收據核對後重新開始。其他 MCP 的管理與工具不因登入等待而被全域鎖住。

登入與 client registration 僅保留於當次 Host 記憶體，重啟需再登入。既有 stdio、靜態 Authorization 與無需認證的 HTTP 保留原連線方式，舊 stdio 掛載不自動轉換。原已支援的私人 HTTP 連線仍走 legacy；內網 OAuth 尚未支援。

## 程式與信任邊界

| 層 | 實作與責任 |
| --- | --- |
| [登入管理器](../../apps/daemon/src/mcp-oauth.ts) | SDK v1 provider、公開 metadata、DCR public client、PKCE S256、一次性 loopback callback、五分鐘期限、世代隔離及共享更新 |
| [網路 adapter](../../apps/daemon/src/mcp-oauth-network.ts) | OAuth headers 隔離、公開 HTTPS、全部 DNS 查核、實際連到核准 IP、原 Host／SNI／TLS identity、大小與期限限制；阻止 SDK 重送工具呼叫 |
| [MCP Host](../../apps/daemon/src/mcp-host.ts) | 接入 auth provider，重建連線與最新清單；清理前後核對原世代，舊連線／工具回覆不能覆寫新結果 |
| [共享契約](../../packages/protocol/src/mcp-auth.ts)／[可信路由](../../apps/daemon/src/preview.ts) | 精確 Extension Origin＋panel bearer、當次 instance＋配置身份；start／status／cancel／forget 的原 UUID 與收據，回應只有安全短分類 |
| [受控 opener](../../apps/cli/src/browser.ts)／[Companion](../../apps/cli/src/companion.ts)／[CLI](../../apps/cli/src/main.ts) | 只由明確本機登入流程開啟已驗證目的地；沒有新增任意 URL 的 Desktop 管理 API |
| [卡片](../../apps/extension/src/mcp-panel.ts)／[tracker](../../apps/extension/src/mcp-auth-tracker.ts)／[協調器](../../apps/extension/src/sidepanel.ts) | 原身份存於可信 storage.session、WebLock 比對保存、階段單調、只讀恢復、焦點保留；UI 不取得第三方權杖 |

每台服務一個活動登入，Host 最多四件；完整操作收據十分鐘／64 件，已見 UUID 的簡要身份上限 1024、Host 當次生命週期不重用。清除、取消及配置生命週期使原認證世代失效，晚回覆不能再寫入憑證。解除配對取消該 owner 尚未完成的登入，不假稱撤銷已完成的第三方帳號授權。

原 `tools/call` 回 401 或有效 Bearer `insufficient_scope` 403 後，adapter 在 SDK 自動認證／重送前終止；登入成功也不重播舊呼叫。到期更新先於新的工具發送，並行或延後抵達的相同舊 refresh token 只發一次更新請求。已送出的遠端工作仍可能是未知結果。

配置檔格式、依賴與版本未更動；public MCP catalog 不增加認證資料，widget 契約與 `WIDGET_URI` 未更動。完整邊界見 [SECURITY](../../SECURITY.md)。

## 自動檢查與合成互動

| 檢查 | 最後結果與證據 |
| --- | --- |
| `bun run check` | 364 tests、0 fail、3316 assertions；release metadata、Widget／Extension 建置、TypeScript、Biome 通過 |
| `bun run desktop:check` | 最新 source 的 sidecar、Desktop 前端、Cargo check、fmt、clippy 通過 |
| 登入管理器＋Host | 31 tests／224 assertions；callback、錯 state／issuer、取消、逾時、忘記、世代、容量、刷新，以及重連清理晚到 |
| [網路失敗案例](../../apps/daemon/src/mcp-oauth-network.test.ts) | 21 tests／173 assertions；私有／保留 IP、DNS rebinding、redirect、headers、TLS identity、串流期限及工具 401／403 發送計數 |
| [跨層旅程](../../apps/daemon/src/mcp-oauth-flow.test.ts) | 5 tests／455 assertions；真 Workbench HTTP＋真 SDK auth＋真 loopback listener，HTTPS OAuth／工具回應全部為合成資料 |
| [可信 HTTP](../../apps/daemon/src/mcp-auth-http.test.ts)＋[protocol](../../packages/protocol/src/mcp-auth.test.ts) | 3 tests／37 assertions；Origin、owner／token、instance、strict schema 與公開回應邊界 |
| [UI tracker](../../apps/extension/src/mcp-auth-tracker.test.ts) | 10 tests／79 assertions；同一操作核對、舊回覆、未知狀態與保留原身份 |

以上針對性計數是完整套件的子集，不相加成額外總測試數。跨層旅程完成成功登入→探索→public broker 唯讀工具→清除，也驗證取消後新世代登入、解除配對、停用與配置指紋改變，舊 token 回覆均不得復活。

Chrome 使用 [純記憶體 fixture](../../tests/panel-flow-preview.ts) 與實際側欄程式，沒有註冊真 client、執行 MCP 程序或連接帳號。Enter 可開始／取消；合成登入完成後工具自動更新；原收據遺失保持未知，新清除回覆遺失後查詢可解鎖。登入回覆遺失只查原 ID，新增登入計數不因查詢增加。360／400／480 CSS px 無橫向溢出，80 字名稱及長公開網域可換行；另抽查 200 CSS px（400px 於 200% 的等效內容寬度），不宣稱真瀏覽器縮放、讀屏或原生 Extension 已驗收。

| 合成畫面 | 支持的觀察 |
| --- | --- |
| [等待登入](evidence/core-flow/oauth-waiting-400.jpg)，400×900 | 短狀態、取消入口、其他 MCP 可操作；尚無工具清單時不顯示假 0 |
| [取得清單](evidence/core-flow/oauth-connected-400.jpg)，400×900 | 合成成功後兩個工具、管理選單收合；不是 Layer 帳號證據 |
| [長名稱／網域](evidence/core-flow/oauth-long-360.jpg)，360×675 JPEG | 名稱與展開網域換行；DOM 另核對卡片 scrollWidth 為 316、CSS viewport 寬 360 |

工程預覽及測試分頁於驗收後關閉；沒有安裝／重載使用者 Extension、重啟正在執行的 Host 或更改其 MCP 配置。

## 公開相容性資料

初次 metadata 查核只以無憑證 GET 讀取 Layer 的公開資料，沒有建立 OAuth client、登入帳號或呼叫 Layer 工具。後續公開 `initialize`／`tools/list` 及真 Host 相容性結果另記於 [修補紀錄](mcp-oauth-recovery.md)。

| 查核項目 | 2026-10-03 的公開回應 |
| --- | --- |
| [Protected Resource Metadata](https://mcp.app.layer.ai/.well-known/oauth-protected-resource/mcp) | HTTP 200；resource 為 `https://mcp.app.layer.ai/mcp`，authorization server 為 `https://auth.app.layer.ai` |
| [Authorization Server Metadata](https://auth.app.layer.ai/.well-known/oauth-authorization-server) | HTTP 200；issuer 為 `https://auth.app.layer.ai/` |
| 登入／交換／註冊端點 | 同一 issuer 下的 `/authorize`、`/oauth/token`、`/oidc/register` |
| PKCE／public client | 宣告 S256 與 `token_endpoint_auth_method=none` |
| scope／更新 | resource 宣告 openid、profile、email、offline_access；issuer 宣告 authorization_code、refresh_token |
| 註冊能力 | 同時宣告 DCR endpoint 與 CIMD；本次採 SDK v1 的 DCR 路徑 |
| 回呼 issuer | 未宣告 `authorization_response_iss_parameter_supported`；有 `iss` 時仍須核對，缺少時依固定 issuer、state、resource 與 PKCE 綁定 |

以上證明服務有宣告對應能力，尚不能證明任意動態 loopback port 能完成註冊、帳號授權、權杖交換、更新或取得工具。Layer 官方將 Streamable HTTP 與首次 OAuth 登入列為一般連線方式；Auth0 官方將 `none` 列為 public client 的註冊方式。[Layer 設定](https://layer.ai/docs/mcp/setup)、[Auth0 DCR](https://auth0.com/docs/get-started/applications/dynamic-client-registration)

## 尚待真實使用者驗證

使用者已回報收到 OAuth 完成頁，但清單與重試失敗；後續查到 schema 大小上限並修正，這不是完整帳號流程通過的證據。使用修補後重新建置的 Host 與側欄完成本人授權，取得最新工具清單後，再選擇一個已確認不修改外部狀態的工具驗證可用性。不要以產圖、付費工作或寫入作預設測試。

目前沒有安裝或重載使用者的 Extension，也沒有改動使用者現有 MCP 配置與帳號。一般使用者不需要操作合成預覽、招募測試者或執行工程檢查。
