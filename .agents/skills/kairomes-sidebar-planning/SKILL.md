---
name: kairomes-sidebar-planning
description: "根據 Kairomes 現行程式碼與側欄畫面規劃 Chrome／Edge 輔助側欄的 UI／UX、功能優先順序和 Codex 到 ChatGPT 的上下文交接，產出具狀態、技術依賴與驗收條件的開發文件。"
---

# Kairomes 側欄規劃

Kairomes 是 ChatGPT 使用本機工作區的輔助側欄。改善目標是讓人快速看懂當前操作、需要處理的事項與可檢查的結果；不要為它再做一套重複的聊天宿主。

## 現況先行

讀取目前 repository 的 `AGENTS.md`、`README.md`、`CONTRIBUTING.md`、`SECURITY.md` 和 manifests，再讀涉及的 extension／widget／daemon／protocol。本機 revision 及依據優先於歷史計畫與這份 skill 的快照。

用公開或合成資料擷取窄版畫面，並標明 fixture 替換了哪些能力。沒有真實 Tunnel／宿主驗證就不能宣稱帳號端到端流程已通過。不能為此啟動真實 shell、取得秘密或讀取私人對話。

## 不可混淆的邊界

規劃時讀 [Kairomes 決策邊界](references/boundaries.md)。可信 Extension 原生核准層、localhost 工作台 iframe、ChatGPT 內 MCP App、Desktop 管理面是不同 surface。

顯示選中的專案不等於目前聊天的任務歸屬。若沒有 task／conversation ID，使用「本機操作」或「此實例活動」；不要承諾只授權某個聊天。模型使用 opaque ID 和相對路徑。

## 文字與布局

預設畫面只有一個主要閱讀區、短狀態、必要欄位和下一個動作。同一狀態、風險、路徑或進度在同一決策位置只說一次。技術細節按需展開；不新增歡迎介紹卡、重複提示或說明段落。有效授權、結果不明與核准所需的操作範圍必須可見。

沿用現有品牌、色彩與元件。先排除資訊重複和操作遮擋，再做視覺潤飾。以 360／400／480px 和 200% zoom 驗收，保留焦點、返回位置、閱讀鎖定及適當的 live announcement。

## 開發文件

每個提案要區分「已實作」「待改善」「新增」「待驗證」。連回畫面與程式碼，寫明使用者問題、預期互動、狀態、優先順序、涉及檔案、依賴與驗收條件。對 schema、MCP、權限或資源的變更列出失敗案例與公開文件更新；不相容 widget resource 需更新 `WIDGET_URI`。

分清核心功能、基本介面品質、內部工程工具與選用研究。可讀性、鍵盤及狀態正確由開發端負責；合成預覽不加入產品導覽。未經需求證明，不把多人試用、計時或跨 App 交接列為一般使用者的必要步驟。

程式碼變更需 `bun run check`；涉及 Desktop／Tauri／sidecar 加 `bun run desktop:check`。文件和 skill 變更先檢查連結、內容一致性與 skill validator。

## 交接評估

使用 [上下文交接判斷](references/handoff.md) 評估收益及成本。先改善現有唯讀 `kairomes handoff`，不要把 handoff 當成權限／程序／對話搬移。MVP 可採人工審閱後複製上下文到 ChatGPT；一鍵發送與多 writer lease 必須由各自能力驗證支持。
