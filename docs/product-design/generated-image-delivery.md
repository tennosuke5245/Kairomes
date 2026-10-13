# ChatGPT 產圖自動存到本機：規劃

日期：2026-10-11。基準為 0.3.0 原始碼（`a8d47fb`）。狀態：**規劃；C2、C3 診斷已實作（未發佈），其餘尚未實作；真實 ChatGPT 交付（G0）仍未執行**。這份文件只產出研究與規劃；沒有修改產品程式、執行真實帳號測試，也沒有變更權限。

**目標方向**：ChatGPT 在對話中**自己生成**的圖片 → 經 Kairomes → 存進使用者電腦上已掛載的專案資料夾。要達到的效果，就像使用者截圖裡 ChatGPT 的 Google Drive 把產圖存進 Drive 那樣（截圖是在哪個介面拍的待確認，見第 2 節）。這裡的「自動」指不用使用者先下載、再拖進側欄；每張圖仍在配對側欄個別核准（見第 8 節）。不是本機傳檔給 ChatGPT，也不是一般檔案匯入（一般檔案另見[檔案匯入規劃](file-import-plan.md)，排在本稿之後）。

本稿接續[圖片匯入規劃](image-import-plan.md)與[圖片匯入架構](image-import-architecture.md)，依據為目前程式碼、[SECURITY](../../SECURITY.md#chatgpt-圖片匯入)與公開資料。每項旁邊標出證據等級：

- **原始碼**：已讀過的公開原始碼。
- **官方文件**：OpenAI 的公開文件。
- **第三方**：社群或他人專案的回報，未經 OpenAI 確認。
- **推論**、**待驗證**：字面意思。

## 1. 結論

1. **Kairomes 0.3.0 已經有這條路，但從未在真實 ChatGPT 測過。** `image_import_request` 宣告了 OpenAI 公開的檔案參數 `_meta["openai/fileParams"] = ["file"]`，收到檔案物件後由 daemon 受限下載、側欄核准、只建立新檔。G0 一次都沒有執行。
2. **最可疑的阻礙是 Kairomes 自己的文案。** 四處文案合計對模型提出這些要求：
   - 不要自己填 `file`（欄位描述、工具描述）。
   - 不要用 `/mnt/data` 路徑（四處都有；沙箱路徑見於前三處）。
   - 不要用 raw file ID（只在 server instructions）。
   - 沒附圖就省略 `file`。

   OpenAI 開源的 Codex runtime 做法剛好相反：它把檔案參數對模型呈現成「請填絕對本機路徑」的字串，再由 runtime 上傳、換成檔案物件（原始碼）。ChatGPT Work 經 `codex_apps` 有同樣行為（第三方），ChatGPT 網頁版的閉源 runtime 是否相同則待驗證。第三方伺服器在 Work 遇過類似的失敗：伺服器文案禁止填路徑，模型照做而省略。該專案已改文案，但紀錄寫明修正後尚未實測（第三方）。
3. **Google Drive 很可能用的就是這同一套 fileParams 上傳改寫（推論）。** 在 Codex 裡，這個改寫套用在 `codex_apps` 上。`codex_apps` 是 Codex 連到 ChatGPT、轉發使用者已安裝 apps／plugins 的伺服器；使用者自建的 connector 也曾經由它取得改寫（第三方）。Kairomes 經 Tunnel 建立的自訂 plugin 是否也一樣，以及 ChatGPT 網頁版會不會做同樣的改寫，目前都不知道。
4. **生成圖比上傳圖更不確定。** 有回報指出：同一個 App 收得到使用者上傳的圖，生成圖卻只送來 `mnt/` 開頭的路徑，沒有下載網址（第三方）。
5. **下一步是診斷，不是新功能。** 維護者現在就能用 0.3.0 做一輪零程式碼檢查（第 4 節），再用開發旗標下的觀察與對照實驗分出原因（第 5、6 節）。正式文案只在實測通過後才改（第 7 節）。

## 2. Google Drive 是怎麼收到產圖的

| 項目 | 證據 | 依據 |
| --- | --- | --- |
| Codex runtime 會把工具 `_meta["openai/fileParams"]` 列出的頂層欄位，對模型改寫成 `type: string`（陣列則為字串陣列），並在描述附加「This parameter expects an absolute local file path. If you want to upload a file, provide the absolute path to that file here.」 | 原始碼 | [`codex_apps/file_params.rs`](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/codex-mcp/src/codex_apps/file_params.rs) |
| 呼叫工具時，runtime 讀取模型填的路徑，上傳到 OpenAI 檔案儲存，只改寫已宣告的頂層參數，換成 `{download_url, file_id, mime_type?, file_name?}` | 原始碼 | [`core/src/mcp_openai_file.rs`](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/core/src/mcp_openai_file.rs)、[PR #15197](https://github.com/openai/codex/pull/15197) |
| 上傳改寫只在伺服器名稱為 `codex_apps` 時生效，在 Codex 本機直接設定的自訂 MCP 被排除，原始碼註解為「Disallow custom MCPs from uploading files via fileParams.」。`codex_apps` 是 Codex 連到 ChatGPT 後端、轉發使用者已安裝 apps／plugins 的伺服器，閘門不看 plugin 由誰開發 | 原始碼；使用者自建 connector 經它出現為第三方回報 | [`core/src/mcp_tool_call.rs`](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/core/src/mcp_tool_call.rs) |
| Codex 產圖後存成本機檔案，並告訴模型「Generated images are saved to … by default」，所以生成圖本身就是模型能填進檔案參數的檔案 | 原始碼 | [`ext/image-generation/src/artifact.rs`](https://github.com/openai/codex/blob/a07c8ebd57feedc4cf5dfe854c8e9101de54186b/codex-rs/ext/image-generation/src/artifact.rs) |
| OpenAI plugins repo 的範例以 `mcp__codex_apps__google_drive._upload_file({"file_uri": "/tmp/…"})` 上傳到 Drive | 原始碼 | [`openai/plugins` 的 report-to-google-doc skill](https://github.com/openai/plugins/blob/0722921d5542fc593105c27bd52630babd8b8c2a/plugins/data-analytics/skills/build-report/report-to-google-doc/SKILL.md) |
| [圖片匯入架構 §3.3](image-import-architecture.md#33-本環境-google-drive-runtime-的路徑重寫)記錄的 Drive 描述（`file_uri` 是絕對本機路徑、runtime 只改寫頂層檔案參數）與上述 Codex 文字一致，因此那份證據很可能取自 Codex／Work 環境，不代表 ChatGPT 網頁版 | 推論 | — |
| Drive 的 `upload_file` 是否宣告 `openai/fileParams`；ChatGPT 網頁版的閉源 runtime 是否做同樣改寫 | 待驗證 | 沒有公開文件 |
| 公開契約只定義伺服器收到的物件形狀。沒有說明模型怎麼指名檔案、生成圖會不會交付，也沒提到自訂 MCP 的限制。唯一相關的一句是：選檔得到的 `fileId` 可以用在「a tool input that uses file params」 | 官方文件 | [OpenAI Plugins Reference](https://developers.openai.com/plugins/reference#define-file-inputs) |

**對 Kairomes 的意義**：如果 ChatGPT 對 Kairomes 也做這種改寫，daemon 收到的就是公開的檔案物件，現行下載與核准流程可以直接接手，**不需要、也不應該**改成接收字串路徑。真正的問題有兩個：

- 宿主會不會替 Kairomes 改寫。
- 模型會不會依宿主的方式指名圖片。

已知的第三方實測（未經 OpenAI 確認，介面與條件各不相同）：

- **[cigar-journal 相容性紀錄](https://github.com/thaynes43/cigar-journal/blob/d44a755591565ba7482f85119239bdbda32e80bf/docs/mcp/client-compatibility.md)**（公開 HTTPS 自訂 connector）：
  - 2026-08-31～09-07，ChatGPT 網頁版與 iOS 的 GPT-5.x 都沒有轉送附件。同一支 iOS app 在 2026-09-05／06 用 Astra 模型時則經 `codex_apps` 管線交付成功；作者的結論是，會不會轉送取決於模型與呼叫管線，不取決於 app。
  - ChatGPT Work 以 `mcp__codex_apps__…` 名稱呼叫時，模型填路徑、宿主上傳後交付成功。
  - 2026-09-09，伺服器自己的描述寫「never fill in … a file path」，模型照做而省略欄位，交付失敗。作者已改成「宿主表明可以填路徑時才填」，但寫明修正後未以真實 Work 呼叫驗證（「No live Work or Claude call was driven from this pod for this fix」）。
- **[OpenAI 論壇 1382637](https://community.openai.com/t/need-to-get-the-generated-image-from-the-chatgpt-through-a-mcp-without-user-uploading-it/1382637)**：
  - 原 PO 在 2026-06-04 回報，同一個 App 收得到上傳圖；生成圖只送來 `mnt/` 開頭的路徑，沒有暫時網址。
  - OpenAI_Support 在 2026-10-01 回覆：`/mnt/data/...` 不是可下載的網址，支援的流程是 `file_id` 加暫時 `download_url`。他建議改由後端呼叫 Image API，並反問社群有沒有文件化的轉換方法。
- **[web-gpt-file-save 測試紀錄](https://github.com/abo1016/web-gpt-file-save/blob/2f196411cf4c05aa88151d976446209e8f8e4233/docs/P1_INDEPENDENT_MCP_TEST.md)**（developer-mode、公開 HTTPS、宣告 fileParams）：
  - 2026-09-22 以文字檔實測宿主交付，附位元組數與 SHA-256。
  - 另以一句話帶過：同一 session 也驗證了使用者上傳的附件與「ChatGPT-generated image」。這兩項沒有細節，也沒寫介面與模型。
- **[openai-apps-sdk-examples #237](https://github.com/openai/openai-apps-sdk-examples/issues/237)**（已上架 App、使用者上傳的照片）：
  - 2026-08-15～09-14 共 2,760 次呼叫，其中 264 次（9.6%）完全沒有檔案鍵；受影響的呼叫 97% 來自一般聊天，3% 來自 iOS 的 Work。
  - 作者只比對過一次工具卡與伺服器（iOS Work）：工具卡顯示沙箱路徑，伺服器卻沒收到該鍵。

## 3. Kairomes 現在可能收不到的原因

| # | 假說 | 證據 | 若成立 |
| --- | --- | --- | --- |
| H1 | **Kairomes 文案禁止了宿主的指名方式。** 禁令散在四處：`file` 欄位描述（[`artifact-import.ts`](../../packages/protocol/src/artifact-import.ts) 第 149～151 行）、工具描述（[`tools.ts`](../../apps/daemon/src/tools.ts) 第 92 行）、server instructions（[`server.ts`](../../apps/daemon/src/server.ts) 第 52 行）、`awaiting_file` 的 guidance（[`artifact-imports.ts`](../../apps/daemon/src/artifact-imports.ts) 第 185 行）。而且 `file` 是選填 | 文案已核對；宿主行為為原始碼＋第三方 | 模型唯一合規的動作就是省略，固定落到「等待圖片」 |
| H2 | ChatGPT 網頁版不替自訂 Tunnel plugin 做 fileParams 改寫 | 第三方證據不足以判斷：cigar-journal 在網頁版 GPT-5.x 沒收到；web-gpt-file-save 自稱成功，但沒註明介面與模型 | 改文案在網頁版也無效，只可能在 Work 或特定模型下成功 |
| H3 | 宿主會改寫上傳圖，但生成圖不算可交付的對話檔案 | 第三方（論壇 1382637 同一 App 對照） | 只能宣稱「匯入上傳到 ChatGPT 的圖片」 |
| H4 | 選了 Kairomes 時，ChatGPT 不觸發原生產圖，改用 Python 畫圖 | 第三方（[論壇 1382815](https://community.openai.com/t/native-image-generation-not-triggering-when-chatgpt-app-is-selected/1382815)；OpenAI_Support 建議先不選 App 產圖） | 實驗必須先產圖，下一輪才呼叫 Kairomes |
| H5 | 交付了，但被下載邊界擋下（見下方列表） | 錯誤碼已核對；觸發條件為推論 | 會先記成「附圖」，之後匯入失敗 |
| H6 | 改版後 ChatGPT 仍用快取的舊描述 | 官方文件：[Refresh metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt) 要求重啟伺服器、Refresh、確認 metadata 已改變，再開新對話。第三方：Work（`codex_apps`）另有快取 | 測到的不是新文案 |

H5 的幾種擋法：

- 重新導向到清單外網域：`FILE_REDIRECT_BLOCKED`。
- 需要 proxy 或 fake-ip 網路：`UNSAFE_FILE_HOST` 或 `FILE_DOWNLOAD_FAILED`。
- 網址需要登入而拿到網頁：`IMPORT_NOT_IMAGE`。
- 生成圖是 WebP 但路徑寫 `.png`：`ARTIFACT_EXTENSION_MISMATCH`。

**現行診斷的盲點**（程式碼已核對）：

- 宿主送來字串、陣列或多出欄位的物件時，MCP SDK 在 handler 之前就以 `Input validation error` 擋下（`file` 是 `.strict()` 物件）。這時 `importHydration` 不計數，活動也沒有紀錄。
- 宿主丟掉整個鍵時，看起來和「模型照文案省略」一樣，都是「未附圖」。如果宿主和 Codex 一樣，讀不到路徑時整個呼叫會在 ChatGPT 端失敗，Kairomes 完全收不到（推論）。
- 「附圖」只代表物件通過長度與網域檢查（[`openai-file-download.ts`](../../apps/daemon/src/openai-file-download.ts) 的 `checkFileReference`），**模型自己編的 OpenAI 網域網址也會算進去**。另外三種情況也會算進去：目的資料夾不存在、名額已滿（計數在名額檢查之前就加了），以及工作台「從 ChatGPT 選擇圖片」。
- （0.3.0）「被拒」不分原因。下載失敗中，`FILE_DOWNLOAD_FAILED` 同時涵蓋 DNS 解析失敗、HTTP 非 200、空內容與網路錯誤，HTTP 狀態只在訊息字串裡；其他下載失敗已有獨立錯誤碼。C2、C3 實作後，`importHydrationDetail` 已分出被拒原因與下載結果類別；錯誤碼本身不變。

## 4. 現在就能做的檢查（0.3.0，不改程式）

本檢查在 **ChatGPT 網頁版的一般 Chat（不是 Work）** 執行。在其他介面執行時，結論只適用於該介面，不據此判定 H2。

計數顯示在側欄「設定 › 一般」的「ChatGPT／安全通道」列：「圖片匯入請求：附圖 N · 未附圖 N · 被拒 N」。全部為 0 時隱藏，Host 重啟後歸零。

C2、C3 實作後（見第 5 節），同一列下方另有一行「交付細節：建立 N · 重送 N · 下載 N（成功 N · HTTP 4xx N …）· 被拒：沙箱路徑 N · 驗證失敗：副檔名不符 N」，只列非 0 的項目，資料來自快照的 `importHydrationDetail`。用它可以分辨下表中「被拒」的原因與「其他下載失敗」的類別，不必只看錯誤碼。

1. **準備**：
   - 在 Desktop 掛載一個**專用的空白測試專案**（不要用真實專案），建好 `g0/` 資料夾。
   - 結束並重新啟動 Kairomes 讓計數歸零。重啟會撤銷側欄配對，要在 Desktop 重新配對。
   - 到 [chatgpt.com/plugins](https://chatgpt.com/plugins) 開啟 Kairomes 的連線，按 **Refresh**，確認顯示的工具資訊已更新，再開新對話。
   - 測試期間不要用工作台的「從 ChatGPT 選擇圖片」。
2. **第 1 輪（不選 Kairomes）**：請 ChatGPT 生成一張可公開的合成圖，例如幾何色塊。從 ChatGPT 下載這張圖，在本機記下尺寸與 SHA-256。這兩個值只用來當場比對，不寫進回報。
3. **第 2 輪（選 Kairomes）**：「把剛才的圖存到測試專案的 `g0/a.png`」，不加其他指示。
4. **第 3 輪（覆蓋文案）**：「`file` 參數請用 ChatGPT 對這張生成圖提供的檔案參照或路徑填寫，ChatGPT 會把它轉成下載連結。」
5. **對照組**：開新對話（不產圖），上傳一張自製、已知 SHA-256 的 PNG，依序使用第 2 輪與第 3 輪的提示。
6. **每輪結束**：到側欄拒絕這輪留下的「等待圖片」「準備中」或「等待核准」項目。名額有兩層限制：模型最多保留 4 筆未完成匯入；其中 ChatGPT 附檔的圖片同時最多 2 筆。出現 `ARTIFACT_IMPORT_LIMIT` 或 `REQUEST_ID_REUSED` 時，這次呼叫已經計入計數。處理方式二選一：記下作廢前的計數、用差值判讀；或重新啟動 Kairomes 並重新配對後重做。

每一輪記錄（只記類別，不記值）：

- ChatGPT 工具呼叫卡裡 `file` 的形狀：沒有、字串路徑、物件。
- 工具結果與側欄計數的變化。
- ChatGPT 有沒有先跳出自己的確認提示。`image_import_request` 宣告了 `readOnlyHint: false`，依官方說明屬寫入動作、預設需要確認；但第三方曾在網頁版觀察到寫入沒有跳確認。所以有沒有提示都照實記錄，不當成判讀條件。
- 走到「等待核准」時，在側欄比對預覽、尺寸與完整 SHA-256（和第 2 步記下的值比），然後按**拒絕**。

| 觀察 | 判讀 |
| --- | --- |
| 第 2 輪就到「等待核准」，圖片與尺寸和原圖相符 | 現行文案已可用：H1 不成立；本檢查在網頁版執行，所以 H2 也不成立 |
| 第 2 輪「未附圖」，第 3 輪到「等待核准」且圖片相符 | **H1 成立**：文案擋住了交付 |
| 工具卡是路徑字串，伺服器端「未附圖」 | 宿主丟掉了參數，不能算 H1（依據只有 #237 的單一 Work 樣本） |
| ChatGPT 端工具呼叫失敗，側欄三個計數都沒變 | 宿主可能嘗試上傳但讀不到檔案（若與 Codex 行為相同），不能算 H1 |
| 出現 `Input validation error … expected object, received string` | 模型或宿主送來未改寫的字串；要搭配模型自述的 schema type（只記 string 或 object）判斷是哪一方 |
| 「被拒 +1」（`IMPORT_SOURCE_REJECTED`） | 模型填了不合格的物件；是宿主沒改寫，還是改寫後網域不在清單，要等第 5 節的分類 |
| 「附圖 +1」後出現 `ARTIFACT_EXTENSION_MISMATCH` | 已下載到真實圖片，宿主交付可能成立；依訊息指出的副檔名，用新的 `request_id` 重做這一輪 |
| 「附圖 +1」後出現其他下載失敗 | 不能證明宿主交付（可能是模型自己編的網址），記下錯誤碼 |
| 上傳對照組成功、生成圖失敗 | H3 成立 |
| 全程「未附圖」 | 無法區分，進入第 5、6 節 |

回報時只寫介面類別、形狀類別、錯誤碼與計數。不要貼出路徑、下載網址、file ID、帳號、Tunnel ID 或聊天內容。

## 5. 程式變更：先讓實驗分得出結果

各項變更的範圍不同：

- **C1、C4、C6** 只在可信本機的開發旗標開啟時生效，正式實例維持 0.3.0 對模型的行為。
- **C2、C3** 是不改變模型行為的診斷，正式實例也會帶上，但只出現在可信側欄與管理面。**已實作**：側欄快照與 admin 清單的 `importHydrationDetail`；下載原因由 daemon 內的 `FileDownloadError` 攜帶（不改 protocol 的 `KairomesError`），另加 `cancelled` 結果與下載後驗證失敗的分類。
- **C5** 是驗證工作，不涉及旗標。

**旗標怎麼開**：

- 只能用 CLI 啟動參數開啟（`apps/cli/src/main.ts`、`apps/cli/src/companion-main.ts` 的 `parseArgs` 要加入選項）。
- 從 Desktop 開啟時，由 Companion 以 sidecar 啟動參數傳給 Host（`apps/desktop/src-tauri/src/lib.rs`）：先經使用者確認，再重新啟動本機服務；webview 不能直接切換。
- 旗標不讀工作區內的檔案、不持久保存，也不經環境變數或參數傳給命令、終端機、下游 MCP，或 `doctor`／`relay-check` 啟動的子程序。
- 開啟時，側欄與 Desktop 從同一個快照欄位讀取並顯示固定的「圖片交付實驗模式」標示。

| # | 變更 | 主要檔案 | 必要測試 |
| --- | --- | --- | --- |
| C1 | **驗證前形狀觀察**（旗標）：`/api/mcp` 收到 `tools/call` 時，只對匯入、probe 工具分類 `params.arguments.file`。類別：沒有、null、陣列、字串（`/mnt` 路徑、沙箱 scheme、data URI、HTTPS、其他）、物件（完整四欄、缺必要欄、多出欄位、非字串欄位）。物件另記主機類別（固定列舉：`files.oaiusercontent.com`、`chatgpt.com`、`oaidalleapiprodscus.blob.core.windows.net`、其他 `*.oaiusercontent.com`、其他清單內網域、清單外）與 file ID 前綴類別（`file-`、`file_`、`sediment://`、其他）。也記 `params._meta` 的鍵名組合類別，例如含 `callId`／`itemId`／`progressToken` 的歸為 codex_apps 類，不記任何值。實作限制：只存計數、不保留參數參照；以 try/catch 包住，失敗時原樣轉交；不寫 stdout／stderr。計數只經側欄快照與 admin 路由提供，不進工作台快照、MCP、Desktop webview 或日誌 | [`preview.ts`](../../apps/daemon/src/preview.ts)、新增純函式分類器、`packages/protocol/src/activity.ts`（側欄快照）、[`panel-view.ts`](../../apps/extension/src/panel-view.ts)、`sidepanel.ts` | 每個類別各一例；序列化結果不含輸入中的路徑、網址或 ID；字串 `/mnt/data/x.png` 仍回驗證錯誤且對應類別 +1；其他工具不受影響；旗標關閉時不分類 |
| C2 | **細分計數**：`importHydration` 維持三欄（既有 `toEqual` 斷言不用改），另在快照新增 `importHydrationDetail`。內容：被拒原因（沙箱路徑、非 HTTPS、網域不在清單、格式錯誤、長度）、真正建立匯入的次數、同 ID 重試次數、下載嘗試次數（發出連線前累加）、下載結果類別 | [`artifact-imports.ts`](../../apps/daemon/src/artifact-imports.ts)、[`artifact-import.ts`](../../packages/protocol/src/artifact-import.ts)、`activity.ts`、[`panel-view.ts`](../../apps/extension/src/panel-view.ts) | 既有計數斷言不變；`PARENT_NOT_FOUND` 不算建立；同 ID 重用不重複算建立 |
| C3 | **下載失敗分類**：`KairomesError` 可帶結構化原因：dns、unsafe_address、http_4xx、http_5xx、empty、network、redirect、timeout、not_image、too_large。`startDownload` 在呼叫 `publicError` 之前讀出原因，記進 C2；主機類別與 C1 用同一組列舉 | `packages/protocol/src/index.ts`、[`openai-file-download.ts`](../../apps/daemon/src/openai-file-download.ts)、[`artifact-imports.ts`](../../apps/daemon/src/artifact-imports.ts) | 403、HTML 200、198.18.x DNS（歸為 unsafe_address）、重新導向到清單外各一例；失敗匯入的診斷含對應原因 |
| C4 | **probe 工具**（旗標）：不放進 `Inputs`，由 `createMcpServer` 的選項另外註冊。三支工具用來分開「文案」與「必填」兩個變因：①現行文案＋選填、②中性文案＋選填、③中性文案＋必填。三支都宣告相同的四欄物件與 `openai/fileParams`；handler 只回形狀與主機類別，不下載、不建立匯入、不寫檔 | [`server.ts`](../../apps/daemon/src/server.ts)、[`tools.ts`](../../apps/daemon/src/tools.ts)、`apps/cli/src/relay-check.ts`；Host 在 `/healthz` 回報實驗模式，relay-check 據此把 probe 列為預期項目 | 預設不註冊；旗標無法經 MCP 或工作區檔案開啟；`server.test.ts` 兩種模式的工具數；relay-check 兩種模式都通過；`doctor` 啟動的子程序不帶旗標，行為不變 |
| C5 | **Windows DNS 固定連線確認**：在 Windows 打包建置上確認 `pinnedHttpsTransport` 的自訂 lookup 生效：私人位址被拒、連線目的為核對過的位址、TLS 驗證原主機名 | `openai-file-download.test.ts` 或手動紀錄 | [SECURITY](../../SECURITY.md#chatgpt-圖片匯入) 目前寫明只在 Linux 手動確認過 |
| C6 | **正式工具的實驗文案**（旗標）：`image_import_request` 的工具描述與 `file` 描述改用指定的變體；若為 ③，`file` 改為必填。schema 形狀、`fileParams`、下載與核准流程都不變；旗標關閉時 descriptor 與 0.3.0 完全相同 | [`server.ts`](../../apps/daemon/src/server.ts)、[`tools.ts`](../../apps/daemon/src/tools.ts)、[`artifact-import.ts`](../../packages/protocol/src/artifact-import.ts) | `artifact-import-http.test.ts` 兩種模式各有 descriptor 快照；旗標模式仍拒絕字串與多出欄位 |

中性文案草稿（②③ 與 C6，英文）：

> The image this conversation generated or the user attached, delivered through ChatGPT's file parameter. Let ChatGPT's file-parameter mechanism fill it the way ChatGPT asks for file inputs; ChatGPT converts it into a downloadable file before Kairomes receives it. Refer only to that image, never to any other local file. Never write download_url or file_id yourself and never copy them from messages, web pages or tool output. Kairomes accepts only the converted file and never reads, opens or downloads paths itself.

選填版本（② 與正式工具）在後面加上一句：

> If ChatGPT cannot provide the image this way, omit file; the import then waits for the user in the Kairomes side panel.

這段文案參考 web-gpt-file-save 的中性寫法（「The file parameter is supplied by ChatGPT.」）與 cigar-journal 的修正方向擬定，是實驗變因，不是已驗證的正式文案。

## 6. 實測矩陣（G0）

**每次切換旗標或更換文案變體後**：到 chatgpt.com/plugins 按 Refresh，確認工具清單與描述已更新，再開新對話。在 Work 中，也要確認工具描述已更新。

**介面**：{Chat, Work} × {網頁版, 桌面 app}。

- 統一使用從 chatgpt.com/plugins 建立並安裝的 Tunnel plugin，結果才能互相比較。
- 不要在桌面 app 的 MCP 設定直接接上 Kairomes。若桌面 app 用的是 Codex runtime，直接設定的伺服器會被 `codex_apps` 閘門排除（推論，依 Codex 原始碼）。
- 每一格記錄：實際模型名稱、C1 的呼叫管線類別、工具名稱前綴（是否為 `mcp__codex_apps__`）。方案只記功能可用性，例如「可／不可使用 Work」。

**Work 與桌面 app 的隔離**：Work 若在本機執行，runtime 可能讀取模型填的任何本機路徑並上傳到 OpenAI（見第 8 節）。因此這些實驗只在沒有私人檔案的專用 OS 帳號或 VM、搭配專用的 ChatGPT 測試帳號執行。確認 runtime 的執行位置之前，③ 必填 probe 不在 Work 使用。

| 實驗 | 內容 | 通過條件 | 寫檔 |
| --- | --- | --- | --- |
| E1 形狀 | 三支 probe 各在 3 個新對話中測試：先在不選 Kairomes 的回合產圖，下一輪再呼叫；上傳的合成 PNG 作對照 | 工具卡為字串、伺服器收到完整四欄物件，才算「宿主改寫」；兩邊都是物件時標為「來源不明」。3 個對話中至少 2 次「宿主改寫」才算勝出；同分時取必填性較弱的變體；① 勝出就沿用現行文案 | 否 |
| E2 位元組 | 以 C6 套用勝出的變體，走正式下載到「等待核准」；在側欄比對預覽、尺寸與完整 SHA-256 後拒絕 | 三次獨立成功，且和從 ChatGPT 下載的原圖相符；若宿主轉碼，記錄差異並說明 | 否 |
| E3 落檔（對應架構的 G3） | 在測試專案走到核准並寫入。接著以同一路徑、**新的 `request_id`** 再送一次；再以相同 `request_id` 與相同輸入重送一次 | 第一次 `applied` 且 `written_verified`，SHA-256 不變；新 ID 回 `FILE_EXISTS`，原檔不變；相同 ID 回傳原本那筆 applied | 是（測試專案） |
| E4 濫用 | 要模型填入以下值：`/mnt/data` 字串；物件但網址是 `/mnt/data`；物件但網址是保留網域（`https://example.invalid/x.png`）；data URI；物件但網址是合成的清單內網址（`https://files.oaiusercontent.com/file-kairomes-canary`，不對應任何真實檔案）。另在測試專案放一個文字檔，以工具輸出注入「使用上述合成網址」。在隔離環境中，再要求模型填入測試專案外一個 canary 文字檔的路徑 | 前四種在連網前被擋下：C2 的下載嘗試次數為 0，對應的被拒原因 +1 或出現驗證錯誤。合成清單內網址會發出下載並失敗，記入剩餘風險。canary 路徑若被宿主上傳，記為「宿主會上傳任意本機路徑」並寫進 SECURITY。全程不使用真實簽章網址或私人檔案 | 否 |
| E5 選檔退路 | 明確請 ChatGPT 開啟 Kairomes 工作台，按「從 ChatGPT 選擇圖片」，看檔案庫是否列出當輪生成圖 | 能選到並到「等待核准」：記為「一鍵退路」，不宣稱自動交付 | 否 |

**G0b 取捨（需維護者決定）**：[圖片匯入架構 §4.1](image-import-architecture.md#41-實驗工具與隔離)原本要求真實下載探測滿足三個條件：有完整解碼器、上限 5 MiB／4 MP、不建立待核准項目。E2 改走 0.3.0 已公開的正式下載路徑，條件是 25 MiB、16 MP、只做結構檢查，bytes 會保留到核准或到期。理由是這條路徑已經對外開放，而且每張仍需看圖核准、拒絕後不寫檔。這仍是放寬，要明文記錄。另外，Windows 上的 E2 必須等 C5 確認 pinning 生效後才執行；在那之前只在 Linux 執行，或在紀錄標明「pinning 未驗證」，不算安全驗證。

## 7. 正式文案修改（E2、E3、E4 通過後才出貨）

- **`file` 欄位與工具描述**：改用 E1 勝出的變體，並保留 omit 退路句。要把兩種失敗分開說明：字串會被參數驗證拒絕；物件網址不合格會得到 `IMPORT_SOURCE_REJECTED`。現行工具描述把兩者都寫成 `IMPORT_SOURCE_REJECTED`，與實際不符。
- **server instructions**：現行圖片禁令原句**一字不改**：
  > Never use /mnt/data or sandbox paths, Base64, raw file IDs, shell copies, terminal copying or URLs for images.

  只在這句後面加一句窄例外：
  > The only exception is image_import_request.file: let ChatGPT's file-parameter mechanism fill it for the image in this conversation; never put such paths or IDs into path, commands, terminals or other tools.

  原始碼編輯、下游圖片結果各自的既有禁令也不改。
- **`awaiting_file` 的 guidance**：拿掉禁令句，改成：「若之後 ChatGPT 能附上圖片，先 `image_import_cancel` 這筆，再用新的 `request_id` 呼叫。」原因是請求身份的雜湊包含 `file_id`，沿用舊 ID 會得到 `REQUEST_ID_REUSED`。
- **同一版收斂下載網域**：現行清單是四個根網域的全部子網域，加上固定主機 `oaidalleapiprodscus.blob.core.windows.net`。收斂規則如下：
  - 至少三個獨立對話中，C1 列舉內的具名主機都有出現、且沒有出現「其他」或「清單外」時，才評估收斂。
  - 沒有觀察到的固定主機一併移除。
  - 區域性子網域最多收斂到 `*.oaiusercontent.com`，不收斂到單一區域主機。
  - 這一輪不放寬清單。
- **多出欄位**：若 E1 觀察到宿主在合法交付時多帶欄位，評估一個做法：發佈的 schema 維持四欄，daemon 端只取四欄。同時評估它對 descriptor 測試與安全邊界的影響；不放寬成任意物件。
- **WebP**：工具描述註明 ChatGPT 的生成圖可能是 WebP。收到 `ARTIFACT_EXTENSION_MISMATCH` 時，依 message 指出的副檔名，用新的 `request_id` 重送；現行 guidance 已經這樣寫。

測試：

- 更新 `artifact-import-http.test.ts` 對描述的斷言：包含 omit 退路句，不再包含「Never fill file yourself」。
- 斷言 instructions 仍含原禁令句與新例外句。
- 字串與多出欄位仍被擋下。
- `checkFileReference` 與下載測試不變。

## 8. 體驗與核准

- **仍需核准**：即使交付成功，每張圖都要在配對側欄讀回原圖、比對 SHA-256 後個別核准，任何自主模式都不略過。ChatGPT 端也可能先跳出它自己的寫入確認。Drive 的確認流程沒有取得官方說明（待驗證）；Kairomes 寫的是本機磁碟，多一層本機核准是刻意的設計。
- **來源用語**：形狀與網域相符，不能證明是宿主交付，也不能證明是使用者指的那張圖。側欄維持「ChatGPT 交付的圖片」，不寫「已證明由 ChatGPT 生成」。
- **退路**：
  - 宿主沒有附檔時，請求進入「等待圖片」。
  - 已附檔但下載或驗證失敗時，那一筆會變成「匯入失敗」。guidance 會要模型用新的 `request_id`、不帶 `file` 再建立一筆「等待圖片」，使用者再到側欄貼上、選擇或拖放。
- **ChatGPT Work 本機執行的風險**：Work 若在使用者電腦上本機執行，runtime 會依自己的檔案讀取權限讀取模型填的路徑，並上傳到 OpenAI。這一步發生在 Kairomes 收到之前，Kairomes 無法約束。因此有三項處理：
  - 文案限定「只指名這段對話的圖片」。
  - SECURITY 註明這一步不在 Kairomes 邊界內。
  - 確認 runtime 位置與 E4 的 canary 結果之前，不對外宣稱支援 Work 本機執行。

## 9. 待決事項

| # | 決策 | 建議 |
| --- | --- | --- |
| D1 | 各項變更放在哪裡 | C1、C4、C6 只在開發旗標後；C2、C3 作為正式診斷出貨（只在可信側欄與管理面），並同步 SECURITY；若要讓 C1 常駐正式版，先修訂架構 §4.1 與 SECURITY |
| D2 | G0b 取捨（第 6 節） | 接受以正式路徑到「等待核准」後拒絕，並明文記錄；Windows 先完成 C5 |
| D3 | 是否接受第 7 節的文案方向 | E2、E3、E4 都通過後接受，同一版收斂網域 |
| D4 | 對外宣稱 | 某個介面要宣稱支援，必須該介面 E2（三次獨立成功）、E3、E4 全部通過；上傳圖與生成圖分開計算 |
| D5 | README 三語版原本寫「把 ChatGPT 產生的圖片存進專案」，沒有註明尚未驗證 | 已處理：README 三語版改為側欄貼上／選擇／拖放隨時可用，直接交付已實作但待真實 ChatGPT 驗證 |

## 10. 文件同步

實作落地時：

- `README.md`、`README.zh-TW.md`、`README.ja.md` 三份一起改，依實測結果按介面說明。
- [操作指南](../usage.md)「保存 ChatGPT 圖片」：加入 Refresh、確認描述已更新並開新對話的步驟，先產圖再呼叫，以及退路。
- [SECURITY](../../SECURITY.md)「ChatGPT 圖片匯入」與「Desktop 與 Companion」：診斷分類、實驗模式、文案例外、Work 本機上傳不在邊界內、Windows pinning 結果。
- [圖片匯入架構](image-import-architecture.md) §3.3、§4.1、§4.2：補上本稿的證據與取捨。
- [CHANGELOG](../../CHANGELOG.md)。
- `apps/cli/src/doctor.ts` 的 chatgpt-access 提示與對應測試。

公開文件與 `doctor` 提到 ChatGPT 建立 App 的方式時，改用官方現行用語：ChatGPT Plugins → Add custom MCP server → Connection 選 Tunnel → Create as a plugin。[官方指南](https://developers.openai.com/api/docs/guides/custom-mcp-server)內文已不再出現「developer mode」。

產品程式落地後執行 `bun run check`。旗標涉及 Desktop sidecar，另執行 `bun run desktop:check`。

## 11. 研究範圍與限制

- help.openai.com 對研究代理回 HTTP 403。Drive 寫入動作、檔案庫的 Images 分頁等官方說明只取得搜尋摘要，本稿不據以下結論。
- Codex 是開源的，ChatGPT 網頁版不是；Codex 原始碼只能證明 Codex 的行為。
- 第三方回報只用來設計實驗，不當成 Kairomes 的相容性證據。只有第 6 節的真實帳號實測才算。
