# ChatGPT 檔案匯入本機：規劃與設計稿

日期：2026-10-11。基準為 0.3.0 原始碼（`a8d47fb`）。狀態：**新增功能提案，尚未實作**。這份文件只產出規劃；沒有修改產品程式、啟用工具、執行真實 ChatGPT／Tunnel 傳檔，也沒有變更任何權限。

本稿延續[圖片匯入規劃](image-import-plan.md)與[圖片匯入架構](image-import-architecture.md)，把「存一張圖片」擴充成「把 ChatGPT 對話中的檔案存進本機專案資料夾」。圖片匯入已建立的下載邊界、個別核准、create-only 寫入與結果不明處理全部沿用，本稿只寫新增與不同的部分。依據為目前程式碼、[README](../../README.zh-TW.md)、[SECURITY](../../SECURITY.md)、[操作指南](../usage.md)與[側欄決策邊界](../../.agents/skills/kairomes-sidebar-planning/references/boundaries.md)。

## 1. 目標與結論

使用者的目標：在 ChatGPT 對話裡說「把剛才那份報表存到專案的 `reports/2026-q3.xlsx`」，檔案就進到本機專案資料夾，過程和存圖片一樣在側欄確認一次。

結論：

1. **方向可行，而且大部分骨架已經存在。** 圖片匯入已經用 OpenAI 公開的檔案參數契約（`_meta["openai/fileParams"]`）收檔，這個契約本身不限檔案類型。擴充到一般檔案，宿主端不需要新機制；主要新增的是本機的**類型安全、審閱畫面與寫入規則**。
2. **Google Drive 可以，不代表 Kairomes 一定收得到同樣的檔案。** Drive 是 OpenAI 自己做的 connector，用的是沒有對第三方公開的 runtime 改寫；Kairomes 是 developer-mode App，只能依公開契約。差異見第 2 節，必須用實測（F0）確認。
3. **「ChatGPT 用 Python 產生的檔案」是最大的未知數。** 這最接近 Drive 的使用情境，但公開文件沒有說明這類檔案會不會交給第三方工具。F0 未通過前，不宣稱支援。
4. **不論宿主能不能交檔，都有可用的退路。** 模型可以只發出請求（不附檔），由使用者把下載好的檔案拖進側欄，跟現在的「等待圖片」相同。

## 2. 參考 Google Drive connector：能沿用與不能沿用的部分

| 面向 | ChatGPT 的 Google Drive | Kairomes |
| --- | --- | --- |
| 開發者 | OpenAI 第一方 connector | 第三方自架 MCP（developer-mode App＋Secure MCP Tunnel） |
| 檔案參數 | `google_drive_upload_file.file_uri` 是**字串**，工具描述稱它為 runtime／connector 的檔案參照與絕對本機路徑，由 runtime 改寫頂層檔案參數（[圖片匯入架構 §3.3](image-import-architecture.md#33-本環境-google-drive-runtime-的路徑重寫) 記錄的工具描述證據） | 公開契約 `_meta["openai/fileParams"]`：頂層欄位為**物件或物件陣列** `{download_url, file_id, mime_type?, file_name?}`（[OpenAI Plugins Reference](https://developers.openai.com/plugins/reference#define-file-inputs)） |
| 是否有公開文件 | 改寫機制沒有對第三方公開 | 有；但文件沒說明哪些來源（上傳、產圖、Python 產物）會被交付 |
| 取得 bytes 的位置 | OpenAI 與 Google 的雲端之間 | 使用者電腦經網際網路下載 OpenAI 短效網址，不帶 Cookie 或帳號憑證 |
| 寫入位置與控制 | 使用者的 Drive，受 Google OAuth 權限範圍限制 | 本機專案資料夾，由側欄個別核准，只建立新檔 |
| 檔案類型 | Drive 本身不限 | 需要本機白名單：存進電腦的檔案可能被雙擊執行或被工具自動載入 |

可以沿用的推論：OpenAI 的 runtime 確實有把對話檔案交給工具的能力，而且公開契約已允許非圖片檔（Plugin changelog 2026-03-09：`window.openai.uploadFile` 支援非圖片類型；2026-03-24：`selectFiles()` 可選檔案庫的檔案）。

不能沿用的推論：

- Drive 的字串路徑改寫**不能**套用到 Kairomes。Kairomes 收到字串路徑（例如 `/mnt/data/report.xlsx`）時一律拒絕，不嘗試解讀，也不把它當網址。
- Drive 成功上傳的截圖、其他 connector 的回報或單元測試，都不能代替 Kairomes 的實測。
- 現行圖片工具描述寫著「不要自己填 `/mnt/data` 路徑」。如果 ChatGPT 的 runtime 需要模型以某種方式指名 Python 產物才會交付，現行措辭可能讓它交不出來；這要在 F0 用不同描述比對，但 daemon 的輸入 schema 不放寬。

## 3. 使用情境與範圍

| 情境 | 途徑 | 狀態 |
| --- | --- | --- |
| 小型純文字或程式碼（單檔 65,536 字元以內） | 模型以 `file_change_request` 的 `write` 建立，側欄審閱 diff | 已實作，不在本稿範圍 |
| 使用者上傳到 ChatGPT 的 PDF、CSV、XLSX、ZIP | `file_import_request` 的頂層 `file` 由 ChatGPT 填入 | 新增；宿主交付待驗證（F0） |
| ChatGPT 用 Python 產生的 CSV、XLSX、DOCX | 同上 | 新增；**最關鍵的 F0 能力閘門** |
| ChatGPT 交不出檔案 | 模型省略 `file`，請求進入「等待檔案」，使用者在 ChatGPT 下載後拖進側欄 | 新增；不依賴宿主 |
| 使用者自己要存檔 | 側欄「匯入檔案」：拖放或選擇檔案 | 新增（擴充現有「匯入圖片」） |
| ChatGPT 工作台中挑檔案庫的檔案 | 宿主提供 `selectFiles`／`getFileDownloadUrl` 時顯示「從 ChatGPT 選擇檔案」 | 新增（擴充現有「從 ChatGPT 選擇圖片」） |

一期範圍：一次一個檔案；類型限第 6 節白名單；最大 25 MiB；只建立新檔，父資料夾必須已存在；每個檔案都在側欄個別核准，自主模式不略過。

範圍外（之後另立規格）：一次多檔、超過 25 MiB、覆寫既有檔、自動建立資料夾、解壓縮、音訊／影片／字型、PDF 內容預覽、跨 Host 重啟的收據，以及任何可執行檔或指令碼。

## 4. 現況與差距

| 能力 | 狀態 | 依據與本稿處理 |
| --- | --- | --- |
| 頂層 `file` 與 `openai/fileParams` 宣告 | 已實作（圖片） | [`server.ts`](../../apps/daemon/src/server.ts)註冊 `image_import_request`；檔案工具沿用相同 descriptor 形狀 |
| 受限下載：OpenAI 網域、DNS 固定連線、2 次重新導向、20 秒、25 MiB | 已實作（圖片） | [`openai-file-download.ts`](../../apps/daemon/src/openai-file-download.ts)；但前 12 bytes 必須是圖片簽章、`Accept` 只列圖片，需改為依類型檢查 |
| 請求身份、`preparing`／`awaiting_file`、取消、名額與到期 | 已實作（圖片） | [`ArtifactImportManager`](../../apps/daemon/src/artifact-imports.ts)；改為共用的匯入管理器，名額在圖片與檔案間共用 |
| create-only 寫入、寫後讀回、清理與 `write_outcome` | 已實作（圖片） | [`WorkspaceArtifactImports`](../../packages/workspace-core/src/artifact-imports.ts)；`validateDestination`／`prepare` 寫死圖片副檔名與檢查，需拆出類型政策 |
| 側欄讀回原檔、核對 SHA-256 才能核准 | 已實作（圖片） | `IMPORT_PREVIEW_REQUIRED` 與 [`image-preview.ts`](../../apps/extension/src/image-preview.ts)；檔案沿用同一道閘門，預覽改依類型呈現 |
| 側欄上傳路由 | 已實作，只收圖片 | [`preview.ts`](../../apps/daemon/src/preview.ts)對非 PNG／JPEG／WebP 回 415；改收 `application/octet-stream` 並由 daemon 判斷類型 |
| 拖放、選擇、貼上的入口 | 已實作，只收圖片 | [`image-intake.ts`](../../apps/extension/src/image-intake.ts)、[`import-dialog.ts`](../../apps/extension/src/import-dialog.ts)；擴充為任意白名單檔案 |
| 從 ChatGPT 選檔 | 已實作，只收圖片 | [`host-image-import.ts`](../../apps/widget/src/host-image-import.ts)只接受圖片 MIME；擴充為白名單類型 |
| 類型白名單、內容判斷、巨集與可執行內容檢查 | 新增 | 第 6 節 |
| Windows 網路來源標記（Mark of the Web） | 新增、待驗證 | 第 6.4 節 |
| 文字預覽與隱藏字元提示 | 新增 | 第 8 節 |
| 宿主交付非圖片檔、Python 產物 | 待驗證 | 第 9 節 F0；圖片的 G0 也尚未執行，兩者同一輪測 |

## 5. 產品決策（建議值，待維護者確認）

| # | 決策 | 建議 | 理由 |
| --- | --- | --- | --- |
| D1 | 工具形態 | 新增 `file_import_request`／`file_import_poll`／`file_import_cancel`；`image_import_*` 保留不變。兩組共用同一個管理器、狀態機與核准流程；`file_import_request` 收到圖片時套用圖片政策與看圖核准 | 不破壞已發布的圖片工具與 ChatGPT 的工具快取；之後可在確認沒有依賴後讓圖片工具退場 |
| D2 | 一期類型 | 文字資料、PDF、無巨集 Office、OpenDocument、ZIP（不解壓）、既有圖片 | 涵蓋 ChatGPT 最常產出與使用者最常上傳的檔案 |
| D3 | 程式碼與指令碼 | 不經匯入；改用 `file_change_request` | 程式碼應該審 diff；`.js`、`.ps1`、`.bat` 等在 Windows 可直接執行 |
| D4 | 大小 | 一期 25 MiB，記憶體名額與圖片共用 | 沿用已驗證的上限與記憶體預算；更大的檔案需要落盤暫存，另立設計 |
| D5 | 核准 | 每個檔案個別核准，任何 grant 都不略過 | 與圖片一致；「全自主」不應隱含能把任意下載檔放進專案 |
| D6 | 寫入 | 只建立新檔、父資料夾須已存在、不自動改名 | 沿用 create-only 核心，結果不明時不會覆寫或多存一份 |
| D7 | 網路來源標記 | Windows 上替匯入檔附加 `Zone.Identifier`（ZoneId=3） | 讓 Office 受保護的檢視等 Windows 機制把它當網路下載檔；待驗證後定案 |

## 6. 檔案類型政策

### 6.1 白名單

只接受下表的副檔名。實際內容須符合副檔名的類型；類型由 bytes 判斷，不信任 URL、`mime_type`、`file_name` 或 HTTP `Content-Type`。

| 類型 | 副檔名 | 內容檢查 | 側欄呈現 |
| --- | --- | --- | --- |
| 圖片 | `.png` `.jpg` `.jpeg` `.webp` | 沿用圖片匯入：靜態、16 MP、每邊 16,384 px | 圖片 |
| 文字資料 | `.txt` `.md` `.csv` `.tsv` `.json` `.jsonl` `.yaml` `.yml` `.toml` `.xml` `.log` `.srt` `.vtt` | 不含可執行檔簽章；有效 UTF-8（可含 BOM）且不含 NUL 才提供預覽，否則只顯示資訊 | 純文字預覽 |
| PDF | `.pdf` | 開頭為 `%PDF-` | 檔案資訊 |
| Office（無巨集） | `.docx` `.xlsx` `.pptx` | ZIP 容器；中央目錄含 `[Content_Types].xml` 與對應主檔（`word/document.xml`、`xl/workbook.xml`、`ppt/presentation.xml`）；不含 `vbaProject.bin` 或 ActiveX 部件 | 檔案資訊＋「不含巨集」 |
| OpenDocument | `.odt` `.ods` `.odp` | ZIP 容器，首項 `mimetype` 與副檔名一致；不含 `Basic/`、`Scripts/` 巨集部件 | 檔案資訊＋「不含巨集」 |
| 壓縮檔 | `.zip` | ZIP 簽章與可讀的中央目錄（最多 10,000 項）；**不解壓縮** | 項目數；含可執行檔名時另標示 |

ZIP 只讀中央目錄的名稱與大小，不解壓任何內容，因此沒有 zip bomb 或 zip slip 的寫入風險；名稱長度、項目數與目錄大小都要有上限，格式錯誤一律拒絕（`INVALID_ARCHIVE`）。

### 6.2 一律拒絕

白名單以外的副檔名一律拒絕（`IMPORT_TYPE_NOT_ALLOWED`），包含但不限於：

- 可執行檔與指令碼：`.exe` `.dll` `.msi` `.bat` `.cmd` `.ps1` `.vbs` `.js` `.wsf` `.hta` `.lnk` `.url` `.reg` `.jar` `.sh` 等。
- 含巨集的 Office：`.docm` `.xlsm` `.pptm` 等（`IMPORT_MACRO_DOCUMENT`）。
- 沒有副檔名的檔案，以及 `.html`、`.svg` 等會被瀏覽器執行指令碼的格式（一期不收，之後可評估以文字類型處理）。
- 任何類型的內容以 PE（`MZ`）、ELF 或 Mach-O 簽章開頭（`IMPORT_EXECUTABLE_CONTENT`）。

### 6.3 位置限制

沿用 `validateRelativePath` 的全部規則（私有名稱、`..`、反斜線、ADS、保留名稱、符號連結）。另外，匯入不能寫進會被工具或 CI 自動執行的設定資料夾：`.github`、`.gitlab`、`.husky`、`.githooks`、`.vscode`、`.idea`、`.devcontainer`、`.circleci`（`IMPORT_SENSITIVE_LOCATION`）。這些位置的檔案請用 `file_change_request` 審閱 diff。

### 6.4 Windows 網路來源標記

在寫完暫存檔、尚未 link 到目的路徑前，於 Windows 上附加 `:Zone.Identifier` 資料流（`[ZoneTransfer]` / `ZoneId=3`）。資料流屬於同一個檔案，link 後一併保留；SHA-256 只計算主要內容。附加失敗時整筆不寫入（`ZONE_MARK_FAILED`，`write_outcome=not_written`）。

待驗證：非 NTFS 磁碟（exFAT、網路磁碟）是否支援；不支援時是否改為在審閱畫面先告知並允許繼續。macOS／Linux 一期不附加。

## 7. 模型工具契約草案

以下是**新增設計**，不是現在可呼叫的工具。描述使用英文；實作須檢查 Zod 轉出的實際 `tools/list`。

```json
{
  "name": "file_import_request",
  "inputSchema": {
    "type": "object",
    "properties": {
      "workspace_id": { "type": "string", "format": "uuid" },
      "request_id": { "type": "string", "format": "uuid" },
      "path": { "type": "string", "minLength": 1, "maxLength": 1024 },
      "summary": { "type": "string", "minLength": 1, "maxLength": 200 },
      "file": {
        "type": "object",
        "properties": {
          "download_url": { "type": "string" },
          "file_id": { "type": "string" },
          "mime_type": { "type": "string" },
          "file_name": { "type": "string" }
        },
        "required": ["download_url", "file_id"],
        "additionalProperties": false
      }
    },
    "required": ["workspace_id", "request_id", "path", "summary"],
    "additionalProperties": false
  },
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": true, "idempotentHint": true },
  "_meta": {
    "openai/fileParams": ["file"],
    "openai/toolInvocation/invoking": "正在準備匯入檔案…",
    "openai/toolInvocation/invoked": "檔案匯入請求已建立"
  }
}
```

- `file` 沿用現有 `OpenAIFileReferenceSchema`，長度上限仍由 daemon 在呼叫後檢查。省略 `file` 時進入 `awaiting_file`。
- `file_import_poll`／`file_import_cancel` 與圖片版相同，只收 `import_id`。
- 模型可見的結果為 `kind: "file_import"`，包含 `id`、`request_id`、`workspace_id`、相對 `path`、`summary`、`state`、`write_outcome`、驗證後的 `file_type`（例如 `pdf`、`xlsx`、`csv`）、`byte_size`、完整 SHA-256（`version`）、時間、`error_code`、`message`、`denial_reason` 與 `guidance`。圖片另含寬高與 `artifact`。
- 不給模型：下載網址、`file_id`、來源檔名、fingerprint、上傳 ID。

工具描述至少說明：檔案由 ChatGPT 填入頂層 `file`；不要自己填網址、Base64 或沙箱路徑；ChatGPT 無法附檔時省略 `file` 並請使用者在側欄放入；只建立新檔；每個檔案都要使用者在側欄核准；請求建立不等於已存檔，請以原 ID poll；程式碼與設定檔改用 `file_change_request`。

伺服器 instructions 的圖片段落改為同時說明檔案：存圖片可用任一工具，其他檔案用 `file_import_request`。

## 8. 側欄審閱與自行匯入

單件審閱沿用圖片匯入的版面、閱讀鎖定、0.7 秒防誤按、結果不明鎖與返回焦點。由上而下：

```text
← 返回清單                         匯入檔案
專案     品牌素材專案
儲存為   reports/2026-q3.xlsx
[檔案圖示] Excel 活頁簿 · 2.4 MiB · 不含巨集
只建立新檔 · 14:35 到期
（文字類）預覽：前 400 行或 64 KiB
▸ 來源與完整性：完整 SHA-256、匯入 ID、來源名稱（未驗證）
                              [拒絕]  [匯入檔案]
```

- **核准閘門一致**：任何類型都要同一配對先讀回待審原檔，在側欄算 SHA-256 並比對大小與類型，才啟用「匯入檔案」。daemon 仍以 `IMPORT_PREVIEW_REQUIRED` 拒絕沒讀過內容的配對。
- **文字預覽**：以 `TextDecoder("utf-8", { fatal: true })` 解碼，只用 `textContent` 顯示，不轉譯 HTML 或 Markdown。雙向控制、零寬與其他不可見字元顯示成可見跳脫，並在資訊列加註「含隱藏字元」。超出範圍時寫「只顯示前 400 行」。
- **二進位檔**：只顯示類型、大小與檢查結果，不嘗試開啟或渲染。ZIP 顯示「N 個項目 · 不會解壓縮」，含可執行檔名時加註「內含可執行檔」。
- **模型的說明**：`summary` 標示為「ChatGPT 的說明」，不當作已驗證資訊。
- **完成後**：顯示「已匯入」與目的路徑；文字檔可在工作台開啟，其他類型只顯示路徑與 SHA-256。

狀態文案與圖片版相同，只把名詞換成「檔案」：「等待檔案」「正在接收檔案…」「載入待審檔案…」「無法核對待審檔案」「已匯入」「結果待確認」；衝突依錯誤碼顯示「目的檔案已存在」「找不到資料夾」「儲存位置已變更」。類型被拒時顯示一行原因，例如「Kairomes 不匯入可執行檔或指令碼」。

自行匯入：「需確認」頁的「匯入圖片」改為「匯入檔案」；拖放與「選擇檔案」接受白名單類型。貼上只在剪貼簿帶有檔案時處理（Windows 檔案總管複製的檔案能否貼上待驗證）。工作台與 ChatGPT 結果卡仍然沒有上傳或核准控制。

驗收沿用圖片匯入的 360／400／480px、真正 200% 縮放、鍵盤順序與 live announcement（「待審檔案已載入」「正在寫入檔案」「已匯入」「結果待確認」）。

## 9. 宿主交付驗證（F0）

F0 與圖片的 G0 在**同一輪**真實環境執行：同一版 daemon、真實 ChatGPT developer-mode App、Secure MCP Tunnel。工具先放在可信本機的開發旗標後面（正式建置不註冊），測試期間在側欄一律拒絕或取消，不落檔。側欄設定已有的 `importHydration` 計數（附檔／未附檔／被拒）擴充到檔案工具，用來分辨「沒有交付」「交付了不同形狀」與「下載失敗」。

| 案例 | 材料 | 要觀察的結果 | 通過後可以宣稱 |
| --- | --- | --- | --- |
| 上傳的 PDF | 公開合成 PDF，已知 SHA-256 | 收到物件；下載 bytes 的 SHA-256 相符 | 匯入上傳到 ChatGPT 的 PDF |
| 上傳的 CSV／XLSX／ZIP | 同上 | 同上；記錄是否提供 `mime_type`、`file_name` | 各類型的上傳檔 |
| Python 產生的檔案 | 在對話中以固定內容產生合成 CSV 與 XLSX，可重算 SHA-256 | 收到物件，或沒有交付、或交付字串；比對兩種工具描述措辭 | **保存 ChatGPT 產生的檔案**（與 Drive 情境最接近） |
| ChatGPT 產生的圖片 | 圖片 G0 原矩陣 | 見[圖片匯入架構 §4](image-import-architecture.md#4-g0先證明交付能力完全不落檔) | 保存 ChatGPT 產圖 |
| 檔案庫選檔 | 工作台「從 ChatGPT 選擇檔案」 | 非圖片能否選取；`getFileDownloadUrl` 的網址能否下載 | 從 ChatGPT 選擇檔案 |
| 超過上限 | 30 MiB 合成檔 | 在寫入前以大小上限拒絕，分類正確 | 上限行為 |
| 短效網址到期 | 延遲後再下載 | 固定分類，不顯示網址或遠端內容 | 恢復語意 |

每個要宣稱的來源類別至少在三次獨立請求中成功，並在新聊天重現。只記錄版本、日期、OS／瀏覽器、來源類別與成功／失敗分類；不記錄帳號、Tunnel ID、檔案 ID、短效網址、聊天內容或檔案內容。

收到的下載網址若不在現行網域清單（見 [SECURITY](../../SECURITY.md#chatgpt-圖片匯入)），先記錄網域類別，再由維護者決定是否加入；不因一次失敗就接受任意 HTTPS。

F0 結果決定發布用語：只有上傳檔通過時，對外寫「匯入你上傳到 ChatGPT 的檔案」；Python 產物沒有通過時，不寫「保存 ChatGPT 產生的檔案」，並在操作指南說明下載後拖進側欄的作法。

## 10. 開發階段

| 階段 | 優先 | 內容與主要檔案 | 完成條件 |
| --- | --- | --- | --- |
| F1 本機核心 | P0，可與 F0 並行 | `packages/workspace-core` 新增類型政策模組（白名單、簽章、UTF-8、ZIP 中央目錄、巨集檢查）；[`artifact-imports.ts`](../../packages/workspace-core/src/artifact-imports.ts)依類型 `prepare`；Windows 網路來源標記；位置限制 | 第 11 節的類型、位置與寫入失敗案例通過；圖片既有測試不變 |
| F2 側欄審閱與自行匯入 | P0 | [`preview.ts`](../../apps/daemon/src/preview.ts)上傳路由改收 octet-stream；Extension 的[`approval-panel.ts`](../../apps/extension/src/approval-panel.ts)、[`import-view.ts`](../../apps/extension/src/import-view.ts)、[`import-dialog.ts`](../../apps/extension/src/import-dialog.ts)、[`image-intake.ts`](../../apps/extension/src/image-intake.ts)、[`image-preview.ts`](../../apps/extension/src/image-preview.ts)擴充為檔案；文字預覽 | 讀回＋SHA-256 閘門、文字預覽、隱藏字元、窄版與鍵盤驗收 |
| F3 模型工具 | P0 | [`artifact-import.ts`](../../packages/protocol/src/artifact-import.ts)新增 schema；[`index.ts`](../../packages/protocol/src/index.ts)、[`tools.ts`](../../apps/daemon/src/tools.ts)、[`server.ts`](../../apps/daemon/src/server.ts)註冊與 instructions；[`openai-file-download.ts`](../../apps/daemon/src/openai-file-download.ts)依類型檢查開頭 bytes；[`artifact-imports.ts`](../../apps/daemon/src/artifact-imports.ts)共用名額；MCP 結果卡、工作台動態與「從 ChatGPT 選擇檔案」 | descriptor 快照測試；工具先在開發旗標後；`awaiting_file` 退路可用 |
| F0 宿主交付 | P0，依賴 F3 的開發旗標版本 | 第 9 節；需維護者的真實帳號與 Tunnel | 依結果決定宣稱範圍 |
| F4 完整流程與發布 | P1 | 真實 ChatGPT → Tunnel → 側欄 → 本機新檔 → SHA-256 核對；公開文件 | 第 12 節文件同步；`bun run check` 通過 |
| F5 後續 | P2 | 一次多檔（`fileParams` 陣列＋批次核准）、超過 25 MiB 的落盤暫存、覆寫既有檔（綁定 `expected_version`）、建立資料夾、音訊／影片／字型、ZIP 解壓（另需 zip slip 設計）、PDF 預覽 | 各自另立規格與失敗案例 |

F1、F2 不依賴宿主，可以先做；F3 的工具在 F0 完成前只在開發旗標後註冊。

## 11. 必須通過的失敗案例

| 類型 | 驗收要求 |
| --- | --- |
| 類型 | 白名單外副檔名；副檔名與內容不符（PDF 改名 `.xlsx`、ZIP 改名 `.docx` 但缺主檔）；含 `vbaProject.bin` 的 `.docx`；PE／ELF／Mach-O 內容配白名單副檔名；`.svg`、`.html`、無副檔名；全部拒絕且不建立待核准項目 |
| ZIP | 截斷的中央目錄、超過項目數或名稱長度、宣告大小不一致；只讀不解壓，失敗回 `INVALID_ARCHIVE` |
| 文字 | 非 UTF-8 或含 NUL 的文字檔不預覽但可匯入；雙向控制與零寬字元在預覽可見；`.txt` 內含 HTML 或指令碼時只顯示原文 |
| 位置 | `.github/workflows/x.yml`、`.vscode/tasks.json` 等回 `IMPORT_SENSITIVE_LOCATION`；既有的私有路徑、`..`、ADS、符號連結規則照舊 |
| 下載 | 沿用圖片的網域、DNS、重新導向、逾時與大小案例；回應是 HTML 錯誤頁時，二進位類型在開頭 bytes 即停止，文字類型以 HTTP 狀態與 `Content-Type: text/html` 拒絕 |
| 核准 | 未讀回內容回 `IMPORT_PREVIEW_REQUIRED`；admin 權杖與本機核准頁回 `IMPORT_APPROVAL_PANEL_ONLY`；檔案自主與全自主仍然待核准；內容改變使 fingerprint 失效 |
| 名額 | 圖片與檔案共用記憶體名額；模型不能佔滿側欄自行匯入的名額 |
| 寫入 | 目的檔在核准期間出現、父資料夾被換成連結、網路來源標記寫入失敗，全部 `not_written` 且不留暫存檔；寫後讀回失敗為 `unknown` 並鎖定 |
| 隱私 | 模型、工作台與一般快照看不到下載網址、檔案 ID、來源檔名或 fingerprint；錯誤訊息不含網址或遠端內容 |

## 12. 公開文件與版本

實作落地時同步：

- `README.md`、`README.zh-TW.md`、`README.ja.md` 的「可以做什麼」三份一起改，用語依 F0 結果限定來源。
- [操作指南](../usage.md)：「保存 ChatGPT 圖片」擴充為「保存 ChatGPT 檔案」，列出白名單、上限與退路。
- [SECURITY](../../SECURITY.md)：類型政策、位置限制、網路來源標記、上傳路由改收 octet-stream 後的條件。
- [CHANGELOG](../../CHANGELOG.md)、工具數量、版本號。
- MCP 結果卡新增 `file_import` 種類時更新 `MCP_RESULT_URI`；工作台 resource 有不相容變更時更新 `WIDGET_URI`。

產品程式落地後執行 `bun run check`；若修改 Desktop 或 sidecar，另執行 `bun run desktop:check`。

## 13. 待決事項與風險

- **D1～D7 待維護者確認**，尤其是 D1（是否合併圖片工具）與 D7（非 NTFS 磁碟的處理）。
- **Python 產物能否交付**是這個功能和 Drive 體驗最接近的部分，也最不確定；F0 是唯一能回答的方法。
- **Office 與 PDF 的內容風險**：外部範本、OLE 物件、PDF 動作、CSV 公式注入都可能在開啟時觸發。白名單、巨集檢查與網路來源標記只能降低風險，不能保證檔案無害；說明文字不寫「安全檔案」。
- **Windows 未實機驗證**：DNS 固定連線、`Zone.Identifier` 與受保護的檢視都需要在 Windows 11 實機確認。
- **紀錄只在記憶體**：與圖片相同，Host 重啟後不保留匯入紀錄，也不保證跨重啟恰好一次。

官方參考：[OpenAI Plugins Reference（File inputs、File APIs）](https://developers.openai.com/plugins/reference)、[Plugin changelog](https://developers.openai.com/plugins/changelog)、[Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。公開文件是契約依據，真實帳號測試才是相容性證據；本稿截至 2026-10-11 未執行後者。
