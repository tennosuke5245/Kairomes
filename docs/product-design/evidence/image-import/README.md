# 圖片匯入設計稿：合成檢查紀錄

日期：2026-10-03（Asia/Taipei）。基準為 Kairomes 0.1.4、HEAD `5edf3dcb61eb5021135ccf200f0aa7af97ddceb1` 加上當時工作樹。對應[開發規劃](../../image-import-plan.md)、[互動規格](../../image-import-ux.md)與[獨立 HTML 原型](../../prototypes/image-import.html)。

本目錄是**新增設計的合成畫面**，不是現行產品、原生 Extension 或真實 ChatGPT 傳檔的操作紀錄。以本機 file URL 載入原型，使用 Playwright 的 headless Microsoft Edge 擷取；瀏覽器版本與量測保存在 [verification.json](verification.json)。沒有啟動 Host／Tunnel、使用帳號、取得權杖、讀取私人圖片或發出遠端請求。

## 畫面

| 畫面 | 尺寸 | 支持的觀察 |
| --- | --- | --- |
| [核心總覽](overview.png) | 1400×1226 | 審閱、已存檔、結果待確認三個 400px 設計畫面 |
| [審閱圖片](pending-400.png) | 400×760 | 圖片、固定目標、建立新檔範圍、期限與兩個決策動作 |
| [200% 合成重排](pending-200-percent-400.png) | 400×1887 | 在固定 400px 可見寬度內使用 CSS zoom 2，欄位與操作改為單欄；不是瀏覽器原生 sidePanel 的 200% 驗收 |
| [傳遞與核准邊界](boundaries.png) | 1400×1100 | 宿主、Host、原生決策與本機成果的分工 |
| [窄版結果待確認](unknown-mobile-400.png) | 400×1888 | 設計稿頁面在 400px viewport 的重排；該件只有查詢動作 |

## 已執行的合成檢查

- 13 個情境 × 360／400／480px，共 39 次側欄量測；檢查實際呈現寬度與內部水平溢出。
- 審閱、結果待確認、無法交付、離線 × 三種寬度，共 12 次 CSS 200% 重排量測；檢查可見寬度仍與選定寬度相符。
- 三個視圖 × 三種 viewport，共 9 次頁面水平溢出檢查。
- 7 個模擬互動：匯入至完成、目前檔案檢查、拒絕、準備中取消、原收據查詢、Escape 返回與詳情焦點、完整性資訊展開。
- 公開 PNG 載入成功；沒有 JavaScript 頁面錯誤或遠端請求。另以人工閱讀檢查總覽與放大畫面。

PNG fixture 為[公開品牌素材](../../../../apps/extension/assets/kairomes-k-128.png)，128×128、8,126 bytes，SHA-256：

```text
99daefff0b900556a1e27a0f87a985823540e3f7d85a9195fb86881e9469a015
```

原型只是固定 fixture 與記憶體狀態切換：顯示的 hash、時間、專案、請求身份及完成結果都是合成資料。未驗證正式 pending 端點、原圖身份機械核對、decoder 預算、核准權限、原生讀屏公告、完整色彩對比或本機落檔。完整鍵盤與原生 Chrome／Edge 200% zoom 仍須在實作後驗收。ChatGPT 生成圖片的實際交付及 Secure MCP Tunnel 相容性依架構稿 G0／G3 閘門另行驗證。
