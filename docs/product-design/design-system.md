# Kairomes 設計系統

日期：2026-10-07。狀態：**0.3.0 原始碼已實作於 `packages/ui-tokens`，Desktop、側欄、工作台、MCP 結果卡、Companion 頁、OAuth 回呼頁與本機核准頁共用**。設計稿與檢查都是合成證據，尚未在 WebView2、真實 Extension、ChatGPT 宿主、200% 實際縮放或螢幕閱讀器驗收。

方向名稱為「Paper & Ink」：暖色紙底、墨色主要按鈕；深紅只用於 K 標誌、導覽標記與「需確認」。

- [可操作設計稿](prototypes/design-system/mockup.html)：14 個畫面，各有淺色與深色版本。設計稿使用當時的 token 快照；實際數值以 `packages/ui-tokens` 為準。
- 開發規則、樣式守門與預覽方式見[貢獻指南](../../CONTRIBUTING.md#設計系統)。

## 1. Token

淺色定義於 `:root, [data-theme="light"]`；深色定義在 `prefers-color-scheme: dark`（未強制淺色時）與 `[data-theme="dark"]` 兩處，內容必須一致。任何元素都能帶 `data-theme`，ChatGPT 內的工作台依宿主主題設定。字級、間距等尺寸 token 只放在 `:root`。只用系統字型，不載入網路字型。

| 群組 | Token | 用途 |
| --- | --- | --- |
| 表面 | `--k-bg`、`--k-surface`、`--k-surface-2`、`--k-surface-3` | 底色、卡片、hover 與選取、按下 |
| 線 | `--k-line`、`--k-line-strong`、`--k-line-control` | 前兩者為裝飾線；輸入框、開關等只靠邊框辨識的控制用 `line-control` |
| 文字 | `--k-ink-1`～`--k-ink-3`、`--k-ink-disabled` | 內文、次要、meta；disabled 色只作裝飾，不承載必要文字 |
| 品牌 | `--k-brand`、`-soft`、`-on`、`-line`、`-ink`、`--k-brand-mark` | 需確認徽章、導覽標記、K 標誌 |
| 主要動作 | `--k-primary-bg`、`--k-primary-ink` | 墨色主要按鈕、開啟的開關 |
| 色調 | `--k-{running,success,warning,danger,neutral}` 與 `-soft`、`-on`、`-line` | 圖示與點、淡底、文字、邊框 |
| 程式碼 | `--k-code-*`、`--k-diff-*`、`--k-mark-*`、`--k-selection` | 輸出、差異、搜尋標示、選取 |
| 專案色 | `--k-ws-1`～`--k-ws-5`、`--k-ws-ink` | 依工作區 ID 的 FNV-1a 雜湊選 1～5；名稱永遠並列，色塊只作裝飾 |
| 字級 | `--k-text-meta` 13、`base` 14、`md` 16、`lg` 18、`xl` 22、`2xl` 28 | 13px 只用於時間、數量、欄位標籤與狀態標籤，決策文字至少 14px |
| 間距、圓角、尺寸 | `--k-space-1…9`（4～48）、`--k-radius-xs／sm／md／lg／pill`、`--k-control-sm／control／control-lg`（28／32／40）、`--k-toolbar` 48 | 點擊目標至少 24px |
| 動態與層級 | `--k-dur-1`、`--k-dur-2`、`--k-ease`、`--k-z-*` | 減少動態時全部動畫歸零，圖示與文字仍表達狀態 |

對比門檻：文字 4.5:1；焦點框、控制邊界、狀態圖示與點 3:1；品牌與危險色色相至少相差 20°，讓「失敗」不會看成「需確認」。不使用 `color-mix()`，因 Desktop WebView 以 chrome105 為目標。這些規則由 `tests/ui-style-guard.test.ts` 檢查。

## 2. 狀態色調

`@kairomes/protocol` 的 `toneFor(kind, state)` 回傳色調、Phosphor 圖示與繁中標籤；每個狀態都同時顯示圖示與文字，顏色不是唯一線索。`data-tone` 設定 `--tone`、`--tone-soft`、`--tone-on`、`--tone-line`，元件以 `:where()` 預設為中性。

| 色調 | 意義 | 例 |
| --- | --- | --- |
| brand | 等使用者決定 | 需確認、等待圖片 |
| running | 自動進行中 | 啟動中、執行中、套用中、可接收輸入、準備中 |
| success | 執行結果 | 已完成（結束碼 0，不代表已驗證）、已套用、已匯入、已連線 |
| danger | 失敗 | 失敗、逾時、版本衝突、錯誤、啟動失敗 |
| warning | 待確認或風險 | 結果待確認、內容可能已過時、檔案自主、全自主、主機權限、需要登入 |
| neutral | 已結束或中性 | 已拒絕、已取消、已停止、已到期、逐步確認 |

無法辨識的狀態一律為 warning「結果待確認」，不自動重試。圖片匯入的衝突依錯誤碼顯示「目的檔案已存在」「找不到資料夾」或「儲存位置已變更」。

## 3. 元件

`components.css` 的 `.k-*` 元件只從 token 或 `--tone*` 取色。共同狀態：焦點為 2px `--k-focus` 實線外框；hover 用 `surface-2`，按下或展開用 `surface-3`；停用為 `surface-2` 底與 `ink-3` 文字。

| 類別 | 元件 |
| --- | --- |
| 基礎 | `k-app`、`k-icon`（Phosphor regular，選取時才用 fill）、`k-logo`、`k-logo-status`、`k-btn`（每個畫面只有一個 primary）、`k-pill`、`k-badge`、`k-dot` |
| 版面 | `k-toolbar`、`k-card`、`k-list` 與整列可點的 `k-row`、`k-tabs`、`k-chips`、`k-seg`、`k-popover`、`k-dialog`、`k-actionbar`、`k-empty`、`k-skeleton` |
| 決策 | `k-risk`（風險條，永遠在最前、不可收合，事實不做成按鈕）、`k-quote`（ChatGPT 的說明，標示未經驗證）、`k-diff`（新舊行號、預設換行、路徑不截斷）、`k-dl`、`k-argv`、`k-codebox`、`k-countdown` |
| 狀態與輸出 | `k-notice`（每個介面一個通知槽）、`k-statusline`、`k-pathway`（只用於疑難排解與錯誤）、`k-steps`、`k-stepper`、`k-progress`、`k-output`、`k-facts`、`k-live`、`k-newpill` |
| 輸入 | `k-input`、`k-textarea`、`k-field`、`k-switch`（40×24）、`k-check`、`k-option`、`k-switcher`、`k-access`、`k-need`、`k-avatar`、`k-tag`、`k-crumbs`、`k-snippet`、`k-kbd` |

## 4. 各介面原則

- **Desktop**（1080×720，最小 820）：216px 側邊導覽加一張紙面主區。連線狀態只在側邊狀態晶片說一次。總覽依序是狀態列、需注意卡片（需確認只顯示數量、種類與最早到期，不含 argv 或差異）、專案卡；首次設定改為六步清單，只有目前步驟有動作。疑難排解只把失敗的項目上色，每列最多一個修正動作。會中斷工作的動作都經確認對話框，初始焦點在「取消」。
- **側欄**（360～480px）：48px 單列工具列，切換畫面時高度不變，iframe 不跳動；380px 以下標籤改為圖示，倒數與需確認徽章保留。彈出層固定在工具列下方。核准頁分「需確認／執行中／最近」，詳情依「風險 → ChatGPT 的說明 → 參數或差異 → 動作列」排列。
- **工作台**（側欄 iframe 與 ChatGPT 宿主 400～1280px）：窄版以動態時間軸為主，詳情覆蓋整頁；760px 以上為頂部分頁加右側檢視區。工作目錄只顯示相對路徑。工作台不能核准，待確認項目只提示到側欄審核。
- **MCP 結果卡**：錯誤優先；圖片保持原比例並附「尺寸 · 格式 · 大小」；文字可展開與複製，JSON 以有深度上限的樹顯示；只用 textContent 呈現。
- **靜態頁**（Companion、OAuth 回呼、本機核准）：單張 480px 卡片、內嵌 K 標誌、內文至少 14px、跟隨系統主題，不用英文標語。

## 5. 文案規則

1. 一句狀態加一個下一步；同一事實在同一決策位置只說一次。
2. 不放介紹卡、標語或英文眉標；介面不出現原始工具名稱。
3. 只用繁體中文。程式識別字、路徑與 argv 原樣以等寬字呈現；全形標點與「／」，中文與英數之間加空格。
4. 今天用相對時間（剛剛、2 分鐘前），之後用「下午 3:12」「昨天」；倒數寫「剩 m:ss」。大小一律用 KiB／MiB。
5. 安全用語不軟化：命令、終端機與全自主一律寫「主機權限」「可操作工作區外」「可連網」與「沒有隔離」；不說沙箱或「只限此聊天」；授權適用所有 ChatGPT 聊天；結束碼 0 是「已完成」，不是已驗證；重新啟動與結束不說復原。
6. 模型提供的文字標示「ChatGPT 的說明（未經驗證）」，以 textContent 呈現。
7. 錯誤用固定對照句加一個動作，不顯示原始錯誤、HTTP 內容、stderr、網址或本機路徑。
8. 按鈕用說明結果的動詞，例如「允許這次」「套用這批」「匯入圖片」「更新金鑰」。
