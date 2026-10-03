# ChatGPT 圖片匯入：開發規劃與設計稿

日期：2026-10-03。基準為現行 0.1.4 原始碼，HEAD `5edf3dcb61eb5021135ccf200f0aa7af97ddceb1` 加上目前工作樹內容。本文件為新增功能提案；這輪只產出規劃、合成設計稿與設計檢查，沒有啟用圖片匯入，也沒有執行真實 ChatGPT／Tunnel 傳檔。

## 1. 產品決策

使用者在 ChatGPT 產生圖片後，可以要求 Kairomes 把同一張圖片存到已掛載專案。主要流程為「正式宿主檔案交付 → 本機準備 → 原生側欄審閱 → 個別核准 → 建立新檔 → 核對成果」。

第一期採直接公開的圖片匯入工具，檔案參數放在最外層，並宣告 `openai/fileParams`。先驗證宿主確實交付可取得的圖片內容，再實作產品流程；不將 Google Drive 的成功、工具清單可見或單元測試當成 Kairomes 已完成傳檔的證據。

第一期的圖片匯入一律個別核准，包含已有檔案自主或全自主的實例。這項規則是**新增的產品決策**，發布前須同步 README、SECURITY、工具描述與授權選單說明。不能讓介面「全自主」隱含圖片也會自動落檔。

一期範圍：

- 支援的候選格式為 PNG／JPEG／WebP，接收、解析與預覽須驗證真實 bytes；動畫格式與解碼限制依技術規格明確拒絕或收斂。
- 只建立掛載專案內的新檔；目的資料夾須已存在，不覆寫、不自動建立目錄。
- 優先驗證最新一張原生生成圖片。前輪圖片與編輯結果各自驗證，不由最新圖推論全部圖片都可取得。
- 匯入目標由工具的 `workspace_id` 與相對 `path` 綁定；側欄瀏覽專案不會重設目標，也不代表聊天授權。
- 本機等待審閱的 bytes 保留有界且有期限；第一期不做永久匯入紀錄或跨 Host 重啟的副作用恰好一次保證。

剪貼簿、抓取 ChatGPT DOM、Drive 中轉、Kairomes 自行呼叫產圖 API、通用二進位上傳與批次圖片，均為範圍外。後續若需要它們，另立流程與授權規格，不作為正式交付失敗時的隱藏替代。

## 2. 先看設計稿

- [可操作設計稿](prototypes/image-import.html)：核心畫面、互動預覽與傳遞邊界；支援情境切換、360／400／480px 與合成 200% 縮放。
- [核心畫面總覽](evidence/image-import/overview.png)：審閱圖片、已存檔、結果待確認。
- [完整互動規格](image-import-ux.md)：各狀態、文案、可信核准、失敗恢復、鍵盤與窄版條件。
- [技術架構與驗證閘門](image-import-architecture.md)：公開工具契約、來源證據、準備中收據、安全下載、記憶體與落檔。
- [設計檢查紀錄](evidence/image-import/verification.json)：這輪合成原型的尺寸與互動檢查；不包含真實帳戶結果。
- [畫面與檢查說明](evidence/image-import/README.md)：截圖尺寸、量測方法與合成證據的適用範圍。

設計稿以現行 [側欄色彩與布局](../../apps/extension/sidepanel.css)、[原生核准結構](../../apps/extension/src/approval-panel.ts)及[圖片成果卡](../../apps/widget/src/artifact-panel.tsx)為依據。圖片樣張使用 repository 公開品牌 PNG，並非使用者的生成圖片或私有工作區內容。

### 核心畫面

| 畫面 | 使用者需要確認的事 | 主要動作 | 決策位置 |
| --- | --- | --- | --- |
| 審閱圖片 | 圖片內容、固定專案與相對目的路徑、建立新檔範圍、期限 | 匯入圖片／拒絕 | Extension 原生介面 |
| 已存檔 | 當次寫入的路徑、大小及內容版本；目前檔案要另外讀取 | 檢查目前檔案 | 成果閱讀區 |
| 結果待確認 | 原核准可能已送達；不能再次送出或自行換 ID | 查詢結果 | 原操作詳情 |

技術資訊收在「來源與完整性」。完整雜湊可查閱，但預設不把 CDN 網址、file ID、核准 fingerprint 或權杖放進畫面。產品介面不呈現本原型的情境選單、寬度選擇與研究說明。

## 3. 證據與現況

| 判斷 | 狀態 | 依據與限制 |
| --- | --- | --- |
| 檔案 object 必須在工具最外層，四個欄位皆宣告、只有兩個必要 | 官方規格已確認 | [File APIs](https://developers.openai.com/plugins/reference#file-apis)；仍要檢查實際 `tools/list` 輸出 |
| Google Drive 工具具有檔案參照與 runtime 上傳改寫的描述 | 目前工具契約已確認 | 本環境 `google_drive_upload_file`／`google_drive_batch_update_document` 描述，未看到後端程式碼 |
| Google Drive 成功接收生成圖片 | 使用者提供的報告 | 對話截圖提供成功線索；這輪不重新上傳、不保存私人圖片或原始參數 |
| Drive 使用的機制就是公開 `fileParams` | 待驗證 | 工具描述與成功報告不能證明相同後端契約，也不能推論為 Drive 專屬權限 |
| Kairomes 已公開同等圖片匯入入口 | 尚未實作 | [公開工具](../../apps/daemon/src/tools.ts)、[工具註冊](../../apps/daemon/src/server.ts)沒有匯入工具或 `fileParams` metadata |
| 本機接 bytes、驗路徑與 create-only 落檔 | 已有內部骨架 | [workspace-core](../../packages/workspace-core/src/artifact-imports.ts)；仍需解碼、生命週期及安全下載改善 |
| 原生核准能呈現待審圖片 | 待改善 | [approval-panel](../../apps/extension/src/approval-panel.ts)已有文字欄位，尚缺待審 bytes 端點與圖片載入 |
| 先前失敗已證明本方案不可行 | 沒有足夠證據 | 可達 Git 歷史自建倉已是停用狀態，未留下當時的完整工具 descriptor 與接收形狀 |

公開工具目前明示不可匯入；本規劃不更改這項現況。舊註解記錄的失敗需當作待分析證據，不把未保留的原始封包補寫成事實。

## 4. 開發順序與門檻

| 階段 | 目的與交付物 | 涉及位置 | 通過條件 | 未通過時 |
| --- | --- | --- | --- | --- |
| I0：契約與宿主探測 | 開發用最外層 file probe；不寫工作區；wire descriptor snapshot 與分層測試紀錄 | protocol、server 註冊、開發 fixture | 契約正確；上傳合成圖與原生生成圖各自取得真 bytes，完成解碼與同圖核對 | 保持公開匯入停用，依錯誤層定位 |
| I1：安全接收與生命週期 | 先登錄 preparing 身份、異步下載、poll／cancel、固定 IP 下載、解碼及記憶體預算 | imports manager、download、workspace-core、protocol | 同 ID 去重、取消與晚回覆正確；所有網路／格式／容量負案例通過 | 不進入待核准產品路徑 |
| I2：原生審閱與落檔 | pending 圖片端點、完整身份核對、個別核准、create-only、未知結果收據 | preview HTTP、approval state／panel、sidepanel、core | 預覽與核准綁同一內容；斷線／過期／內容變更立即鎖定；同名檔與掛載競態被拒絕 | 保留查詢／拒絕；不可降級繞過必要預覽 |
| I3：成果與發布 | 當次收據與目前檔案分開、MCP result、公開文件、真實帳戶試點 | widget、工具描述、README、SECURITY、測試 | 真實 ChatGPT→Tunnel→原生側欄→本機新檔→同圖核對通過，產品檢查通過 | 原始碼標實驗範圍，不宣稱一般可用 |

I0 是宿主相容性門檻；I1／I2 的設計可獨立完成，但沒有 I0 原生產圖成功就不能開啟一般使用者功能。若只有上傳檔成功，應記錄「上傳檔可交付」，不能寫成「生成圖片已支援」。

本表是產品交付分期；技術稿以 G0–G3 標記驗證閘門。I0 對應 G0，I1 對應 G1，I2 對應 G2 與落檔準備，I3 才執行 G3 真實完整流程與發布驗收。

I0 分為 **I0a 只觀察契約形狀** 與 **I0b 受限 bytes 探測**。I0a 不下載；I0b 必須先完成最小固定 IP／TLS／redirect 下載 helper、完整解碼與更小的 5 MiB／4MP 單工作預算，再進行任何真實下載。這是前置安全條件；I1 才將它擴充為正式產品的 25 MiB／16MP 候選預算與可取消生命週期，不能為了探測先略過網路或解碼邊界。

### 最小實驗矩陣

| 案例 | 最低驗證 | 證據支持範圍 | 目前 |
| --- | --- | --- | --- |
| 本機 descriptor | 有／無 widget、stdio／attach 的 `fileParams` 與 JSON schema 一致 | 工具契約 | 未執行 |
| 已知合成 PNG 上傳至 ChatGPT | 真參照、受限下載、解碼、SHA-256 與已知樣張一致 | 上傳圖來源 | 未執行 |
| 新生成圖片 | 同一測試 surface 至少 3 次，並和使用者下載的同圖核對 | 最新原生產圖來源 | 未執行 |
| 前輪圖片／編輯圖片 | 分別實測真 bytes 與同圖內容 | 各自的來源範圍 | 未執行 |
| 回應遺失／過期 URL／重啟 | 查原身份、去重、unknown 不自行重送 | 恢復語意 | 未執行 |
| 原生核准＋本機新檔 | 確認目標、一次核准、寫入內容與核准內容一致 | 完整帳戶流程 | 未執行 |

若宿主會重新編碼圖片，需記錄傳輸後 bytes 與圖片內容的差異，UI／文件說明是否保留原檔；不得以肉眼相似代替原檔雜湊一致。

## 5. 關鍵工程決策

1. **直接入口。** 既有 broker 將下游參數包在 `arguments`，不能假設 `arguments.file` 會觸發頂層 fileParams。首版直接公開穩定工具，不依賴下游 catalog 動態註冊。
2. **小參照、非同步準備。** 現有 relay 的 JSON 請求上限 32 KiB、等待 30 秒；正式檔案參照是小 JSON。圖片下載不塞進 Base64 工具參數，request 先回 preparing 身份，poll 讀取結果。
3. **圖片來自受限接收。** 現有下載器先查 DNS 再交給 fetch，尚不能稱為 DNS pinning。正式接收須把檢查過的位址綁定到實際連線，保持 TLS hostname 驗證與逐次 redirect 檢查。
4. **解碼有界。** 現有 25 MiB 傳輸／80MP 圖片上限不是低記憶體保證；80MP RGBA 約 320 MiB。首版提出 16MP 解碼預算、單解碼 worker 與全域記憶體上限，待受控測量定案，詳見架構文件。
5. **核准不可移交。** 待審 bytes 經獨立可信 panel 端點取得；模型與聊天內 widget 不持有 panel token、管理權或核准能力。
6. **未知先對帳。** 同 ID 的 pending 快照或一般連線成功不足以證明原核准沒有執行；用同實例、原請求、fingerprint 與明確終態收據核對。重啟／收據失效保留未知，不能自行重跑。
7. **成果身份。** 存檔回傳相對路徑、大小、完整 SHA-256 與當次寫入結果；目前檔案必須另外重讀並核對。Hash 描述內容一致性，不證明來源真偽或操作恰好一次。

## 6. 驗收與文件更新

必要的失敗測試與案例清單以[技術規格](image-import-architecture.md)為準，至少包括非檔案參照、任意網址／私有 IP／重新導向、HTML 200、過大／解碼失敗、父目錄不存在、同名檔、symlink／掛載替換、取消／過期、重複請求、不同內容共用 ID、未知核准、Host 重啟與 memory quota。

產品程式落地後依 [CONTRIBUTING](../../CONTRIBUTING.md)執行 `bun run check`；若實際修改 Desktop／Tauri／sidecar，再跑 `bun run desktop:check`。MCP descriptor、schema、權限與 UI resource 有變時，同步更新相關測試及 README／SECURITY；不相容的 widget resource 變更須依實際 surface 更新 `WIDGET_URI` 或 `MCP_RESULT_URI`，不能只改程式而沿用舊快取。

UI 品質驗收：360／400／480px、200% 縮放、鍵盤全流程、Escape／返回焦點、未知鎖、歷史閱讀不被新活動搶走、圖片讀取錯誤與晚回覆身份隔離。合成 HTML 只能支持設計重排與模擬互動；原生 sidePanel、OS 剪貼簿、真正權杖通道與 ChatGPT／Tunnel 必須另外驗證。

## 7. 這輪交付與限制

已交付規劃、架構、互動規格、可操作 HTML 與合成畫面。原型操作均為記憶體狀態替身；核准、查詢與已存檔畫面不能當成真實操作的成功紀錄。這輪未把使用者截圖中的檔名、圖片或上傳參數存入 repository。

設計檢查已通過 39 次情境／寬度量測、12 次合成放大重排、9 次頁面窄版量測及 7 個模擬互動，結果見 [verification.json](evidence/image-import/verification.json)。真實宿主測試全部保持「未執行」，下一輪應先完成 I0 的直接工具實驗，再決定公開入口的實作與發布範圍。
