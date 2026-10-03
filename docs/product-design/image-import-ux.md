# ChatGPT 圖片匯入：側欄互動與設計稿

日期：2026-10-03。狀態：**新增設計，尚未實作；正式宿主檔案交付與真實 Tunnel 流程待驗證**。本文以目前工作目錄的原生 Extension 核准頁、工作台圖片預覽及結果不明處理為基準，不將合成畫面視為帳號端到端證據。

## 使用者目標與首版範圍

使用者在 ChatGPT 產生圖片後，要求「存到品牌素材專案的 `assets/cover.png`」。ChatGPT 透過正式檔案交付契約將圖片交給 Kairomes；本機 Host 收到、驗證並保留實體 bytes；使用者在可信原生側欄核對圖片及目的位置，按「匯入圖片」，完成後檢查本機成果。

首版以**正式宿主交付原生生成圖片**為主線。契約未通過時顯示「圖片尚無法交付」，不假裝已收到圖片、不開啟虛假的核准請求。拖放、檔案選擇、剪貼簿圖片、Google Drive 中轉、讀取 ChatGPT 網頁 DOM、代按下載及自行發送訊息均不納入首版主線；後續能力必須另有需求與驗證。

每次只匯入一張已驗證的 PNG／JPEG／WebP，候選傳輸上限沿用目前 25 MiB；首版像素、解碼與全域記憶體預算依[架構規格](image-import-architecture.md)收斂，提議 16MP，尚待受控測量定案，不能由現行 80MP 檔頭上限推論可安全完整解碼。目的為已掛載工作區內的相對路徑，父目錄必須已存在，只建立新檔，不覆寫、不自動建立資料夾。圖片匯入維持逐件原生核准，即使檔案自主或全自主開啟也不略過；公開功能說明、模式範圍與工具描述需明確告知這項首版政策。

## 現況與新增能力

| 能力 | 狀態 | 程式碼／設計依據 |
| --- | --- | --- |
| 頂列專案選擇、全實例待確認件數、短佇列與單件核准 | 已實作 | [sidepanel.ts](../../apps/extension/src/sidepanel.ts)、[approval-panel.ts](../../apps/extension/src/approval-panel.ts) |
| 圖片匯入的格式／尺寸／路徑資訊與個別核准骨架 | 已實作於內部流程；公開匯入工具停用 | [artifact-import.ts](../../packages/protocol/src/artifact-import.ts)、[artifact-imports.ts](../../apps/daemon/src/artifact-imports.ts)、[server.ts](../../apps/daemon/src/server.ts) |
| 待審圖片的 bytes 預覽及其機械核對 | 新增；現行圖片核准詳情只有文字欄位 | [approval-panel.ts](../../apps/extension/src/approval-panel.ts)、[preview.ts](../../apps/daemon/src/preview.ts) |
| 原生核准完整內容綁定、同件未知結果鎖、返回焦點 | 已實作的基礎；匯入需擴充與失敗驗證 | [approval-state.ts](../../apps/extension/src/approval-state.ts)、[approval-mutation.ts](../../apps/extension/src/approval-mutation.ts) |
| 已落檔圖片與歷史版本預覽 | 已實作；不可充當待審圖片接口 | [artifact-panel.tsx](../../apps/widget/src/artifact-panel.tsx)、[bridge.ts](../../apps/widget/src/bridge.ts) |
| 原生產圖經宿主／Tunnel 交付、正式公開匯入工具 | 待驗證；通過後才能啟用 | [server.ts](../../apps/daemon/src/server.ts)、[openai-file-download.ts](../../apps/daemon/src/openai-file-download.ts) |

目前畫面沿用[最新未知核准畫面](evidence/completion-audit/approval-pending-unknown.png)與[工作台圖片畫面](evidence/study-materials/artifact-current-400.jpg)。兩者均為合成材料；後者使用固定圖片與合成版本，不證明圖片匯入可用。邊界見 [Kairomes 決策邊界](../../.agents/skills/kairomes-sidebar-planning/references/boundaries.md)，可讀性基準見[最新樣式檢查](readability-audit.md)。

## Surface 與目標歸屬

| Surface | 本流程的責任 |
| --- | --- |
| ChatGPT 與 MCP | 產圖、提出目標 `workspace_id`／`path`、以正式契約交付、查詢同一請求；不自行核准 |
| Extension 原生 DOM | 顯示真正待審圖片、目的專案與相對路徑、期限，接受可信使用者的匯入／拒絕操作 |
| localhost 工作台 iframe | 展示操作與已落檔成果；不取得 panel token、不代核准 |
| ChatGPT widget | 展示「等待本機確認」「寫入中」「已匯入」或失敗結果；不出現可核准按鈕 |
| 舊式獨立本機核准頁 | 首版排除圖片匯入核准；沒有原圖 hash／解碼審閱 gate，不能代替已配對原生側欄 |
| Desktop／Host | 維持掛載與生命週期、驗證來源和 bytes、準備及寫入；不把管理憑證或來源下載網址交給模型／iframe |

頂列「全部本機操作」或選中的專案只篩選瀏覽內容。**匯入目標由該請求的 `workspace_id` 與 `path` 決定**，不因頂列切換而改寫。沒有可信聊天 ID 時，不寫「這個聊天專用」或「目前聊天的專案」。

開啟匯入詳情時，一次清楚顯示「專案：品牌素材專案」及「儲存為：`assets/cover.png`」。若頂列目前篩選另一個專案，使用者可從全實例待確認入口進入該件，詳情仍保留真正目標；不靜默切換頂列、不借頂列名稱冒充匯入專案。人工切換篩選可返回佇列，但不能改變待審身份或解除未知結果鎖。自動解除掛載保留已開啟的證據並停用操作。

## 正常旅程

1. **交付**：ChatGPT 將圖片交給正式匯入工具。Host 先登錄有界工作與 request ID，快速回傳可查詢的 `preparing` 收據，再非同步下載及驗證；現行 [relay](../../apps/cli/src/relay.ts) 的 30 秒等待窗口不能用同步長下載耗盡。只有收到真實 bytes 且目的位置驗證成功，才建立等待核准項目。下載期間顯示「正在接收圖片…」；無可量測進度時不用百分比。
2. **準備**：Host 驗證檔案大小、簽章、尺寸、格式與副檔名，計算內容 SHA-256，建立 immutable prepared buffer。圖片資料保留期限、同時等待數量及記憶體上限需受目前管理器邊界約束。
3. **審閱**：頂列增加待確認件數；使用者開啟單件詳情，從獨立可信入口載入待審 bytes。預覽載入及核對完成後才啟用「匯入圖片」。
4. **決策**：按「匯入圖片」綁定原請求與完整內容身份；操作立即停用，顯示「寫入中…」。按「拒絕」只結束原請求。關閉詳情不等於拒絕或取消。
5. **寫入**：Host 再次核對工作區、父目錄、目的檔案不存在及 buffer hash，執行 create-only 寫入。等待期間沒有「停止」按鈕，不承諾能取消或復原已提交的寫入。
6. **檢查成果**：同件 `applied`、`write_outcome=written_verified` 且回傳 artifact 身份一致後顯示「已存檔」。保留目的路徑，提供「檢查目前檔案」進入原工作區、原路徑的成果；當次寫入版本與目前檔案另行核對，不以工具呼叫已回覆或 HTTP 200 代替寫入成功。

## 版面與精簡文案

原生頂列保留品牌、專案瀏覽篩選、存取模式與連線狀態，待確認件數仍是全實例計數。匯入詳情取代工作台閱讀區，沿用 [sidepanel.css](../../apps/extension/sidepanel.css) 的暖紙底、紅色主操作、14px 必要正文、18px 標題、既有焦點樣式與返回流程。沒有獨立歡迎卡、重複的流程介紹或擋住圖片的浮動通知。

單件原生核准頁由上而下：

1. 「← 返回清單」／「匯入圖片」及單一狀態。
2. 「專案」完整名稱與「儲存為」完整相對路徑；長名稱換行，不只用 tooltip。
3. 待審圖片區。完整圖片等比例縮放，透明圖片用既有棋盤底；`object-fit: contain`，不裁掉內容。
4. 單列可換行的「128 × 128 · 7.9 KiB · PNG」（合成樣張）。格式、大小與尺寸由實體 bytes 驗證，來源檔名只能當顯示名稱。
5. 「只建立新檔」與固定到期時間，例如「14:35 到期」。時間由該件期限換算為 Asia/Taipei；原型的 14:35 是合成值，不逐秒倒數或持續公告。
6. 收合的「來源與完整性」：完整 SHA-256、匯入 ID、request ID 與目的工作區 ID；值可選取及換行。來源名稱只作不可信顯示文字，不顯示原始來源 file ID、fingerprint、token、下載 URL、私人本機 URL 或雲端絕對路徑。
7. 操作列「匯入圖片」／「拒絕」。預覽未驗證時主操作停用；單一短狀態說明原因。

SHA-256 可在摘要顯示短前綴，但**程式與核准請求必須比對完整 hash**。不得用合成畫面上的「已核對」文字、模型宣稱、圖片檔名或短前綴當安全證據。不要求使用者手抄 hash；完整性由程式檢查。

widget 只顯示一張狀態卡：「圖片匯入」＋真正目的路徑＋單一狀態；等待時為「請在 Kairomes 側欄確認」。不畫出假的側欄核准控制，也不為了模擬原生預覽而把 panel token 或待審讀取能力交給 widget。

## 狀態與下一個動作

`preparing` 需新增服務端工作／早期收據；預覽載入是唯讀子狀態，結果不明及離線是 client overlay，不覆寫服務端狀態。現行 `ArtifactImport.state` 尚無 `preparing`。匯入的既有終態應保留，實作時另定受驗證的投影與收據契約。

| 情境 | 短狀態／必要資訊 | 可以做的動作 | 必須維持的限制 |
| --- | --- | --- | --- |
| 交付及驗證中 | 正在接收圖片…；真正目的路徑 | 返回工作台 | 不列入可核准佇列，不顯示假縮圖或假百分比 |
| `pending`，預覽載入中 | 載入待審圖片… | 拒絕、返回 | 匯入停用；預覽與身份均未成功不得核准 |
| `pending`，預覽核對完成 | 等待確認；圖片、目標、到期時間 | 匯入圖片、拒絕 | 精確原件與完整 fingerprint；沒有自主略過 |
| 預覽失敗／hash 不符 | 無法核對待審圖片 | 重新載入圖片、拒絕 | 清除舊 URL；只重試唯讀預覽，不重送匯入 |
| 內容／目的身份變更 | 內容已變更，請重新審閱 | 重新審閱、返回 | 舊預覽失效；完整新身份與新 bytes 重新核對 |
| 權威 `applying`，原 processing 收據已確認 | 寫入中… | 返回工作台、查詢狀態 | 即使 `write_outcome=unknown` 仍表示正常進行中；不提供重送、重新核准或取消寫入 |
| `applied` 且 `write_outcome=written_verified` | 已存檔；原目的路徑 | 檢查目前檔案、返回工作台 | artifact 對應同工作區／路徑／完整版本才展示；目前檔案另行讀取 |
| `conflict` | 目的檔案已存在 | 查看既有檔案、返回工作台 | 不覆寫、不自動加尾碼；改名由新且明確的請求處理 |
| 父目錄不存在 | 找不到儲存資料夾 | 返回工作台 | 不自動建目錄；沒有寫入，也沒有可核准項目 |
| `expired` | 請求已到期 | 返回工作台 | 釋放待審 bytes；不把舊圖標成目前待審；新交付需新請求 |
| `denied`／`cancelled` | 已拒絕／已取消 | 返回工作台 | 不自行重送；取消只在尚未提交寫入時成立 |
| `failed` 且 `write_outcome=not_written` | 匯入失敗＋短分類 | 查詢狀態、返回工作台 | 不渲染原始來源錯誤、download URL 或 token；有權威無落檔結果才標未寫入 |
| 原 processing 收據無法確認，或終態仍 `write_outcome=unknown` | 結果待確認／無法確認匯入結果 | 查詢狀態、返回 | 可能已有目的檔；保留原操作鎖，不當作安全重試終態，不自動清除或覆寫檔案 |
| 提交回覆不明 | 結果待確認 | 查詢狀態、返回 | 鎖住該件匯入／拒絕／改路徑；關閉再開仍鎖住 |
| 側欄斷線／401／Host 改變 | 本機連線中斷／請重新配對 | 重新連線／配對、查看保留內容 | 舊快照不恢復操作資格；先更新權威狀態 |
| 正式來源無法交付 | 圖片尚無法交付 | 返回工作台 | 沒有真 bytes 不建立核准；不引導 file ID、雲端路徑、任意 URL 或模型 Base64 假交付 |
| 記錄已無法查詢 | 無法確認匯入結果 | 唯讀查目的檔案、返回 | 清單缺席不等於未寫入；不自行換 ID 重做 |

「查看既有檔案」顯示的是衝突檔案目前版本，標示「既有檔案」；它不是待審來源圖，也不代表待審內容曾成功匯入。

## 待審 bytes 與完整身份

新增可信原生 preview 入口，示意名稱為 **`POST /api/panel/artifact-import/preview`**；這是設計用名稱，尚無現行端點。它只對精確 Extension origin、有效 panel bearer 與目前 Host instance 回應。請求綁定匯入 ID、fingerprint 與完整 prepared SHA-256；查詢的只能是該件尚保留的待審 buffer，不接受任意檔案路徑或任意來源 URL。

這個入口與現行 `/api/artifacts/content` 分開：後者按工作區、相對路徑與落檔版本讀取已存在圖片，不能取得尚未核准的 bytes。pending preview 不先寫入目的路徑來借用既有 endpoint，也不讓 widget／工作台 token／MCP token 讀取它。

Host 先檢查 `pending`、未到期、buffer 未釋放及內容 SHA-256；Extension 收取完整 bytes 後自行計算 SHA-256、核對 byte length、格式及目前審閱身份，再由同一份 bytes 建立 object URL、解碼展示。若需核准前後一致性，不能只比對 HTTP 標頭自稱的 hash；圖片 decode 失敗、解碼尺寸不符及回覆身份不符均停用匯入。身份切換、返回或到期時取消舊載入並 revoke URL，晚到的成功、失敗及取消回覆不能取代新圖。

完整機械身份至少包括：來源 Host instance、`workspace_id`、目的 `path`、`request_id`、匯入 ID、prepared 完整 SHA-256、byte size、驗證後 MIME／尺寸、到期時間與審閱 fingerprint。fingerprint 應由 Host 對 prepared 內容與目的範圍生成，不能由模型設定。所有欄位、bytes 或目的位置變更均使原審閱失效。

成功轉入一般 artifact 預覽時，再比對原匯入目標與回傳 artifact 完整身份。讀取失敗保留「匯入時版本」與錯誤；只有成功且仍對應的重新讀取，才能標成「目前預覽」。hash 身份驗證不等於影像內容可信，也不等於獲得 OS sandbox。

## 閱讀鎖定與未知結果對帳

開啟待審詳情即固定該件身份、圖片、目的路徑與閱讀位置；新圖片或其他工具成果只增加既有件數，不替換畫面。新狀態可以停用舊決策，但不得把另一張圖悄悄塞進目前詳情。人工「重新審閱」才接受新身份。返回佇列保留 scroll 與原列焦點；該列已結束時回到佇列標題，不跳到下一件核准。

收到匯入或拒絕的未知回覆時，以原來源 instance＋request ID＋匯入 ID＋fingerprint＋prepared hash 唯讀對帳。`pending` 的新快照、無關 SSE、查詢成功、清單不再顯示、目前時鐘超過到期時間及重新打開詳情，均不能單獨證明該次操作沒有執行。

原操作的權威 processing 收據對應 `applying` 時，可確認寫入已被接受，維持「寫入中」；此時 `write_outcome=unknown` 只表示寫後結果尚未完成，不投影為提交回覆不明。同件 `applied`、`write_outcome=written_verified` 加一致 artifact 才確認完成。明確拒絕／到期／衝突／失敗收據也需對應原操作及 `write_outcome=not_written`，不能借另一件終態解除鎖。收據／回覆無法確認，或終態仍 `write_outcome=unknown` 時維持未知鎖，不因 `failed` 便當作安全重試終態。核准與拒絕另帶穩定的 `approval_request_id`，依原配對 owner、action、instance、內容身份及收據核對，具體契約見架構文件。現行 generic approval tracker 的期限與清單清理行為須為匯入重新稽核，不直接套用為完成證據。

Host 重啟或保留期限清掉記錄後，顯示「無法確認匯入結果」，保留原目標與內容身份；可以唯讀核對目的檔案是否存在及是否等於預期 hash。相同內容只能支持「目前檔案符合預期」，不能證明原決策恰好執行一次。結果未明不自動重新下載、重新核准、換 request ID、換目的檔名或啟動新的匯入。

離線狀態優先於晚到的預覽／目錄錯誤；所有可改變檔案的控制停用。恢復同 instance 後先讀權威快照／收據，再決定狀態；新的連線標籤本身不清除未知鎖。來源下載過期但已取得並驗證的 prepared bytes 尚有效時，可在原本地期限內審閱；未取得 bytes 時不得把已過期來源當作 ready。

## 窄版、縮放、鍵盤與公告

| 驗收尺寸 | 版面要求 |
| --- | --- |
| 360px | 主閱讀區單欄、16px 內距；路徑完整換行；圖片等比例縮放；沒有 document 水平捲動 |
| 400px | 沿用現行原生詳情寬度；圖像優先閱讀，目標及期限在同一條閱讀序列 |
| 480px | 不另開資訊側欄；圖片可增高，欄位保持與窄版相同順序 |
| 真正 200% zoom | 重排為單欄，標題與操作可換行；操作列空間不足時成垂直按鈕，不遮擋圖片、錯誤或完整 hash |

必要文字至少 14px；文字、狀態及 placeholder 以 4.5:1 為目標，焦點與相鄰背景另核對。沿用既有 40px 操作高度。sticky 操作列需留出等量底部空間；短視窗與 200% zoom 應可改為正常文件流，不能造成只能捲圖片、看不到拒絕或返回。

鍵盤順序為：返回清單 → 必要的唯讀預覽操作 → 來源與完整性 → 拒絕 → 匯入圖片。DOM 次序與視覺排列一致；沒有第二個重複返回按鈕。詳情開啟將焦點移至標題；預覽完成不搶焦點。Enter／Space 只觸發當前原生控制，不能由 iframe postMessage 代觸發。Escape 返回佇列或工作台；提交中與未知時返回仍不代表取消。圖片放大若採 modal，須有標題、焦點約束、Escape 關閉與回到觸發按鈕。

圖片替代文字描述它的角色與目標，例如「待匯入至 assets/cover.png 的圖片」，不編造圖像內容；來源提供的描述只作不可信文字。預覽 loading 與行動區使用 `aria-busy`，狀態變更用一次性的 polite live announcement：「待審圖片已載入」「正在寫入圖片」「已匯入」「結果待確認」。連線、待確認件數與單件結果保留獨立 live region，不互相覆寫、不按秒播報到期、不反覆播報相同 loading。reduced motion 下保留文字狀態，避免閃爍或連續動畫。

原生 Chrome／Edge sidePanel、讀屏公告順序、真正 200% zoom、鍵盤焦點與完整對比均須實機驗收。把 viewport 改為一半或用 CSS 放大，只能標作重排合成檢查。

## 合成設計稿的畫面清單

[可操作 HTML 原型](prototypes/image-import.html)的畫面證據置於 `evidence/image-import/`。使用 repository [公開品牌 PNG](../../apps/widget/assets/kairomes-k-128.png)、合成專案「品牌素材專案」、相對路徑 `assets/cover.png` 與固定到期時間。樣張為 128 × 128、8,126 bytes，已從檔案核對完整 SHA-256：`99daefff0b900556a1e27a0f87a985823540e3f7d85a9195fb86881e9469a015`。不同圖片的 hash 必須不同，不用人工輸入「相同版本」字串冒充內容核對。頁面置頂標示「設計草稿 · 合成資料」及尚未驗證正式傳檔，控制區與產品閱讀區分開；不配置真 panel token、Tunnel 或來源下載地址。

| 畫面 | 元件排列與差異 |
| --- | --- |
| 交付中 | 既有工作台頂列 → 單一匯入狀態列 → 路徑 → indeterminate loading；沒有可核准項目 |
| 待審 ready | 原生核准標題 → 專案／儲存為 → 大圖 → 尺寸列 → create-only／期限 → 收合身份 → 匯入／拒絕 |
| 待審 loading／preview error | 同一 ready 位置保留圖框，顯示短 loading 或唯讀重載；匯入停用 |
| 寫入中 | 保留已審圖與目標；單一「寫入中…」，原操作停用，保留返回 |
| 成功 | 結果標題「已匯入」→ 目的路徑 → 匯入時圖片 → 同一尺寸與版本 → 查看圖片／返回 |
| 衝突 | 單一短狀態「目的檔案已存在」→ 原目標與操作身份 → 查看既有檔案／返回；待審 bytes 已釋放時不展示可用來源圖；不出現覆寫 |
| 到期／解除掛載 | 原目標與身份保留，待審圖框失效；單一原因，無核准控制 |
| 結果不明 | 原生連線／通知列 →「結果待確認」與查詢狀態 → 原審閱內容 → disabled 操作；切換頁面仍鎖定 |
| 離線 | 頂列「本機連線中斷」與恢復入口；保留原審閱，不讓局部錯誤蓋掉主狀態 |
| 來源不可交付 | 一張短結果卡「圖片尚無法交付」→ 原目標 → 返回；不顯示合成成功縮圖或待核准件數 |
| widget | 單一展示卡依次切換等待／寫入／成功／失敗；沒有匯入／拒絕控制 |

原型提供 `pending`、`applying`、`applied`、`unknown`、`preparing`、`offline`、`unavailable`、`conflict`、`expired`、`denied`、`cancelled`、`preview_error`、`changed` 十三個情境。`unknown` 只作 client overlay；`offline` 保留舊資料但停用核准；`expired`、`unavailable`、`denied`、`cancelled` 不展示可用的待審圖片。原型可檢查公開 PNG 的瀏覽器呈現，但只顯示固定合成 hash，未執行新的 pending 端點、機械身份核對、正式核准或權限驗證。衝突畫面的查看既有檔案、配對設定及 widget 卡片屬完整產品規格，未在本次十三情境原型實作。

上述原型只驗證閱讀順序、狀態文案、焦點與尺寸。合成切換不能證明正式交付、來源真實性、原生權限、對帳、create-only 落檔或圖片 decode 安全；這些必須由產品程式與真實／受控 transport 證據另外驗證。

## 開發與驗收優先順序

| 優先 | 工作 | 必要依賴與完成條件 |
| --- | --- | --- |
| P0 | 正式交付能力門檻 | 真原生圖片經正式宿主契約到本機，核對 bytes；失敗分類可見。未通過不啟用公開工具 |
| P0 | prepared 身份與原生 preview | 新可信端點、完整 hash、解碼一致性、到期與釋放；模型／iframe／錯 origin／錯 token 無法取圖或核准 |
| P0 | 匯入決策及未知對帳 | 原件收據、同件鎖、已存在目的／工作區變動／來源變動／回應遺失／重啟與到期失敗案例 |
| P1 | 單件詳情與成果關聯 | 原生真 bytes 審閱、成功 artifact 身份核對、衝突區分、閱讀鎖定、返回焦點與晚回覆防護 |
| P1 | 視覺與無障礙 | 360／400／480、真 200%、完整路徑、鍵盤與獨立公告；原生 Chrome／Edge 驗證 |
| 後續 | 其他來源或批次匯入 | 剪貼簿／Drive／拖放／批次需求另立規格，不用來替代 P0 正式交付門檻 |

涉及檔案為 [protocol](../../packages/protocol/src/artifact-import.ts)、[匯入管理器](../../apps/daemon/src/artifact-imports.ts)、[可信 HTTP 邊界](../../apps/daemon/src/preview.ts)、[寫入核心](../../packages/workspace-core/src/artifact-imports.ts)、[原生核准元件](../../apps/extension/src/approval-panel.ts)、[核准狀態](../../apps/extension/src/approval-state.ts)、[對帳](../../apps/extension/src/approval-mutation.ts)、[樣式](../../apps/extension/sidepanel.css)與 [widget 成果](../../apps/widget/src/artifact-panel.tsx)。新 preview 大小與傳輸方式須和現行 HTTP 的 320 KiB body 上限分別設計，不能將圖片塞進既有控制 JSON 端點。

程式碼落地後執行 `bun run check`；若修改 Desktop／sidecar 再執行 `bun run desktop:check`。公開工具、schema、權限及 UI resource 變動同步測試與 README／SECURITY 等公開說明；不相容的工作台 widget 變動更新 `WIDGET_URI`，獨立 MCP 結果 resource 更新 `MCP_RESULT_URI`，依實際受影響 surface 決定。此階段只產出規劃與合成設計，不發布、不安裝 Extension、不改既有 grant 或產品權限。
