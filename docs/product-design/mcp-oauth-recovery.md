# Layer MCP 相容性與登入介面修補

日期：2026-10-03。**原始碼、合成驗收與建置完成；使用者後續已回報連線成功。** 接續 [OAuth 第一階段](mcp-oauth-implementation.md)。

後續本人已回報修補後成功，連線問題不再阻擋使用；未提供特定工具呼叫或更新權杖結果，因此不將此回報擴大為所有工具／長期登入驗收。接續發現的頂列布局與設定入口已於 [核心流程紀錄](core-flow-fixes.md#頂列與設定入口修補) 修正。

## 問題與原因

使用者完成 OAuth 回呼後，卡片仍顯示工具清單讀取失敗，重試也失敗。舊回呼頁的「已完成」未區分授權與工具可用；展開管理時，footer 的預設 stretch 又把重試按鈕拉成高條。

以真 SDK v1 及產品的安全網路 adapter，對 [Layer 公開 MCP](https://mcp.app.layer.ai/mcp) 進行無憑證 `initialize`／`tools/list`：服務回傳 41 個工具，最大的 input／output schema 序列化合計為 34,711 bytes，超過 Kairomes 原本每工具 24 KiB 上限。任一工具超限即拒絕整份清單，因此重試相同回應也無法恢復。這是已確認的清單相容性缺陷；公開清單不能證明使用者帳號權杖或實際工具呼叫成功。

## 修正後的行為

| 範圍 | 修正 |
| --- | --- |
| [MCP Host](../../apps/daemon/src/mcp-host.ts) | 每工具 input／output schema 合計上限改為 64 KiB，接受約 34 KiB 的完整定義；描述仍傳回完整 schema，不裁切成無法使用的內容 |
| 清單失敗 | 分開初始化與 `tools/list` 的安全錯誤分類；超限、逾時、已知 HTTP 狀態及網路拒絕可辨識，UI 不讀取遠端錯誤正文 |
| [側欄卡片](../../apps/extension/src/mcp-panel.ts)／[CSS](../../apps/extension/mcp-panel.css) | 重試與管理按鈕維持 36px 高度；展開的管理動作自行換行，詳情採中性色，原因只在展開處說明一次 |
| [OAuth 回呼頁](../../apps/daemon/src/mcp-oauth-page.ts)／[管理器](../../apps/daemon/src/mcp-oauth.ts) | 授權與工具驗證分開，使用精簡品牌卡片及淺／深色樣式，只有一個標題與一句下一步 |

回呼結果契約：

| 實際結果 | 顯示 |
| --- | --- |
| 權杖交換、MCP 重連與最新工具清單均成功 | 已連線；可返回 Kairomes 使用工具 |
| 權杖交換成功，後續 MCP 連線或清單失敗 | 授權已完成；請返回 Kairomes 重試連線 |
| 回呼驗證或權杖交換失敗 | 登入未完成；請返回 Kairomes 重新登入 |

64 KiB 是通用且有界的相容性調整；不是 Layer 特例。工具數量 128、呼叫參數 32 KiB、工具輸出及網路大小／期限限制均維持既有政策。64 KiB 超限仍拒絕清單並停用舊工具。回呼頁不含 script、表單、外部資源或任何 OAuth／請求資料；詳細邊界見 [SECURITY](../../SECURITY.md)。

## 本輪驗證

| 檢查 | 結果與限制 |
| --- | --- |
| 公開 SDK 相容性 | `initialize` 為 200 SSE、initialized notification 為 202、`tools/list` 為 200 SSE，41 個工具；GET SSE 仍回 401。未註冊 client、登入或呼叫工具 |
| 新版真 Host | 隔離的暫存配置，使用產品 adapter，讀到 41 個 current／ready 工具；無憑證的認證摘要仍為 required，不能稱帳號登入完成。暫存 Host 與資料已清理 |
| Schema 回歸 | 約 34 KiB 與精確 64 KiB 可讀完整描述；64 KiB＋1 拒絕，舊工具不可呼叫 |
| 傳輸回歸 | 真 SDK 配產品 Node bridge，合成分段 gzip SSE、session／protocol headers、HTTP 202／204／405 與 GET 清理；未發現須修改的網路產品程式 |
| 卡片畫面 | 360／400／480 CSS px，以及 200 CSS px 等效內容寬度均無橫向溢出；展開管理後主要／管理按鈕皆為 36px。不是實際 200% zoom 或原生 sidePanel 驗收 |
| 回呼畫面與資料隔離 | 深色 720×480 畫面及 360 CSS px 無橫向溢出；三種固定結果、自動 CSP hash 與不包含 OAuth 資料由測試覆蓋 |
| `bun run check` | **372 pass、0 fail、3546 assertions**；release metadata、Widget／Extension 建置、TypeScript、Biome 通過 |
| `bun run desktop:check` | 最新 sidecar 與 Desktop 前端建置、Cargo check／fmt／clippy 通過；不代表已替換使用者安裝版本 |

合成 UI 使用真側欄元件及純記憶體 fixture，沒有帳號或真登入；回呼預覽直接使用產品的靜態頁產生器。分頁、viewport override 與工程預覽服務已清理，未安裝／重載使用者 Extension，也未重啟其 Host。

| 畫面 | 支持的觀察 |
| --- | --- |
| [工具清單失敗與管理展開](evidence/core-flow/oauth-tools-error-fixed-400.jpg)，400×900 JPEG | 合成 schema 超限狀態；重試不被管理選單拉高，詳情只在卡片內說明 |
| [授權完成但需重試](evidence/core-flow/oauth-result-authorized.jpg)，720×480 JPEG | 產品靜態回呼頁的精簡深色布局；不宣稱工具已連線 |

## 更新與剩餘驗證

目前已建置 Extension、Desktop 前端與 sidecar。開發模式須重新啟動 Host，並由使用者重載既有 Extension；安裝版 Desktop 須執行 `bun run build:desktop` 後更新安裝，`desktop:check` 不會改寫已安裝程式。兩端都使用新版，才能取得相容性修補與介面更新。

第一階段登入僅存 Host 記憶體，更新後重啟會需要重新登入。本人完成授權後應先看到最新工具清單；若仍失敗，展開連線詳情可辨識安全分類，不需貼權杖或日誌。真帳號的工具使用、更新權杖與原生側欄仍待驗證；工具驗證應另選已確認不修改外部狀態的操作，不以產圖、付費或寫入作預設測試。
