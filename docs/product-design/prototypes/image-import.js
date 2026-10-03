// Design-only state fixture. No network, filesystem, credential or MCP access.
const states = {
  pending: {
    label: "審閱圖片",
    badge: "等待核准",
    tone: "normal",
    image: true,
    expiry: true,
    primary: "匯入圖片",
    secondary: "拒絕",
    next: "applying",
    rationale:
      "先呈現已接收的圖片與固定目的地。預覽成功、內容身份一致、核准通道有效時，才能送出個別核准。",
  },
  preparing: {
    label: "準備圖片",
    badge: "準備中",
    tone: "muted",
    empty: "正在取得並驗證圖片…",
    primary: "準備中…",
    disabled: true,
    secondary: "取消",
    rationale:
      "正式 request 先取得可查詢的操作身份，再進行下載與驗證。此時尚未進入核准佇列，也不顯示假進度百分比。",
  },
  applying: {
    label: "寫入中",
    badge: "寫入中",
    tone: "muted",
    image: true,
    primary: "寫入中…",
    disabled: true,
    rationale:
      "目的地、掛載與 bytes 在套用前再次核對。這件操作不能重複核准或在寫入中改名；設計稿一秒後切到已存檔。",
  },
  applied: {
    label: "已存檔",
    title: "圖片已存檔",
    badge: "已存檔",
    tone: "success",
    image: true,
    summary: "品牌素材專案中的圖片已建立。",
    primary: "檢查目前檔案",
    rationale:
      "成功收據提供路徑與當次內容版本。按下檢查後才模擬重新讀取目前檔案，避免把執行時收據當成目前狀態。",
  },
  unknown: {
    label: "結果待確認",
    badge: "結果待確認",
    tone: "normal",
    image: true,
    message: "核准回覆未收到。先查詢這件操作的結果。",
    primary: "查詢結果",
    rationale:
      "結果不明是 client 決策鎖，伺服器仍可能正在處理。保留原請求與 fingerprint；pending 快照、同名檔或一般重新連線都不能解除鎖。設計稿查詢會取得合成的已存檔收據。",
  },
  conflict: {
    label: "目的檔已存在",
    badge: "未匯入",
    tone: "danger",
    empty: "目的檔案已存在",
    message: "assets/cover.png 已存在。請在 ChatGPT 指定另一個檔名。",
    primary: "返回清單",
    rationale:
      "第一期只建立新檔。發生衝突時保留原操作的失敗結果；新的目的地是另一件操作，不能重用已失敗請求的內容身份。",
  },
  expired: {
    label: "核准已到期",
    badge: "已到期",
    tone: "muted",
    empty: "待審圖片已清除",
    message: "這件匯入已到期。需要匯入時，請在 ChatGPT 重新提出。",
    primary: "返回清單",
    rationale:
      "到期會釋放待審 bytes。舊核准、快取預覽與晚回覆不能恢復操作資格；新請求需重新取得檔案與審閱。",
  },
  unavailable: {
    label: "來源無法取得",
    badge: "未收到圖片",
    tone: "danger",
    empty: "尚未收到可用的圖片內容",
    message: "ChatGPT 尚未交付可下載的圖片檔。請在原對話重新指定圖片。",
    primary: "返回清單",
    noReceipt: true,
    rationale:
      "fileId 或雲端路徑不足以成立可匯入圖片。交付失敗時不建立假 pending、不使用任意網址或 shell 補傳；這個情境不能宣稱 bytes 已取得。",
  },
  offline: {
    label: "核准通道中斷",
    badge: "無法核准",
    tone: "muted",
    image: true,
    message: "核准通道已中斷。重新連線並查詢狀態後，才能繼續。",
    primary: "查詢狀態",
    disabled: true,
    offline: true,
    rationale:
      "保留畫面供閱讀，立即停用決策。真產品需先恢復可信連線，再核對同實例、同操作與完整內容身份；舊快照沒有核准資格。",
  },
  denied: {
    label: "已拒絕",
    badge: "已拒絕",
    tone: "muted",
    empty: "這件匯入已拒絕",
    summary: "沒有建立本機檔案。",
    primary: "返回清單",
    rationale: "拒絕後釋放快取圖片，回傳已拒絕狀態。這件操作不能再次核准，需要新請求才能重新準備。",
  },
  cancelled: {
    label: "已取消",
    badge: "已取消",
    tone: "muted",
    empty: "這件匯入已取消",
    summary: "沒有建立本機檔案。",
    primary: "返回清單",
    noReceipt: true,
    rationale:
      "準備中取消會停止下載並清除已取得內容。晚到的下載回覆不能再建立待核准項目；寫入開始後不承諾能取消或復原。",
  },
  preview_error: {
    label: "預覽無法載入",
    badge: "等待核准",
    tone: "normal",
    empty: "圖片預覽無法載入",
    message: "先重新載入圖片，確認內容後才能匯入。",
    primary: "重新載入圖片",
    secondary: "拒絕",
    next: "pending",
    rationale:
      "已驗證的待審圖片也可能讀取或解碼失敗。只有『重新載入圖片』與拒絕可用；匯入按鈕不會繞過必要預覽。",
  },
  changed: {
    label: "審閱內容已變更",
    badge: "需要重新審閱",
    tone: "normal",
    empty: "原本的審閱內容已失效",
    message: "圖片、目的地或操作身份已變更。請重新載入並審閱。",
    primary: "重新審閱",
    next: "pending",
    rationale:
      "舊 fingerprint 與預覽資格立即失效。不能默默換成新圖片後沿用舊核准；設計稿按下重新審閱後切換到一份新的合成審閱內容。",
  },
};
let activeState = "pending";
let activeView = "board";
let generation = 0;
let applyTimer;
let queueOpen = false;
const interactiveMount = document.getElementById("interactive-panel");
const template = document.getElementById("panel-template");
const setText = (root, selector, text) => {
  root.querySelector(selector).textContent = text;
};

function createPanel(name, interactive) {
  const config = states[name];
  const panel = template.content.firstElementChild.cloneNode(true);
  panel.dataset.state = name;
  panel.dataset.tone = config.tone;
  setText(panel, ".product-title", config.title || "匯入圖片");
  setText(panel, ".state-badge", config.badge);
  if (config.summary) setText(panel, ".product-summary", config.summary);
  panel.querySelector(".image-preview").hidden = !config.image;
  panel.querySelector(".empty-preview").hidden = !config.empty;
  if (config.empty) setText(panel, ".empty-message", config.empty);
  panel.querySelector(".state-message").hidden = !config.message;
  if (config.message) setText(panel, ".message-text", config.message);
  panel.querySelector(".approval-expiry").hidden = !config.expiry;
  panel.querySelector(".write-scope").hidden = name !== "pending";
  panel.querySelector(".technical-details").hidden = config.noReceipt || name === "preparing";
  const primary = panel.querySelector(".primary-action");
  primary.textContent = config.primary;
  primary.disabled = Boolean(config.disabled);
  const secondary = panel.querySelector(".secondary-action");
  secondary.hidden = !config.secondary;
  if (config.secondary) secondary.textContent = config.secondary;
  panel.querySelector(".decision-footer").classList.toggle("one-action", !config.secondary);
  const queue = panel.querySelector(".queue-count");
  queue.hidden = !["pending", "unknown", "offline", "preview_error", "changed"].includes(name);
  if (config.offline) {
    setText(panel, ".connection-label", "核准通道中斷");
    panel.querySelector(".connection-label").classList.add("disconnected");
  }
  if (interactive)
    panel.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button || button.disabled) return;
      const action = button.dataset.action;
      if (action === "queue") {
        renderQueue(name);
      } else if (action === "secondary") {
        renderInteractive(name === "preparing" ? "cancelled" : "denied", true);
      } else if (name === "applied") {
        panel.querySelector(".file-verification").hidden = false;
        primary.textContent = "已核對目前檔案";
        primary.disabled = true;
        panel.querySelector(".panel-announcement").textContent =
          "合成資料：目前檔案與當次寫入版本一致。";
      } else if (name === "unknown") {
        renderInteractive("applied", true);
      } else if (config.next) {
        renderInteractive(config.next, true);
      } else {
        renderQueue(name);
      }
    });
  return panel;
}

function renderInteractive(name, focus = false) {
  queueOpen = false;
  generation += 1;
  clearTimeout(applyTimer);
  activeState = name;
  interactiveMount.replaceChildren(createPanel(name, true));
  setText(document, "#scenario-title", states[name].label);
  setText(document, "#scenario-rationale", states[name].rationale);
  for (const button of document.querySelectorAll("[data-state]")) {
    if (button.tagName === "BUTTON")
      button.setAttribute("aria-pressed", String(button.dataset.state === name));
  }
  if (focus) interactiveMount.querySelector(".product-title").focus();
  if (name === "applying") {
    const expectedGeneration = generation;
    applyTimer = setTimeout(() => {
      if (generation === expectedGeneration && activeView === "interactive")
        renderInteractive("applied", focus);
    }, 1000);
  }
}

function renderQueue(name) {
  queueOpen = true;
  generation += 1;
  clearTimeout(applyTimer);
  const panel = createPanel(name, true);
  const body = panel.querySelector(".product-body");
  const title = document.createElement("h2");
  title.className = "product-title";
  title.tabIndex = -1;
  title.textContent = ["pending", "unknown", "offline", "preview_error", "changed"].includes(name)
    ? "需確認 1"
    : "本機操作";
  const row = document.createElement("button");
  row.type = "button";
  row.className = "approval-row";
  row.style.marginTop = "16px";
  const heading = document.createElement("strong");
  heading.textContent = "匯入 assets/cover.png";
  const detail = document.createElement("span");
  detail.textContent = `品牌素材專案 · ${states[name].badge}`;
  row.append(heading, detail);
  row.addEventListener("click", () => renderInteractive(name, true));
  body.replaceChildren(title, row);
  panel.querySelector(".decision-footer").hidden = true;
  interactiveMount.replaceChildren(panel);
  title.focus();
}

function showView(name) {
  activeView = name;
  for (const view of ["board", "interactive", "boundary"])
    document.getElementById(`${view}-view`).hidden = view !== name;
  for (const button of document.querySelectorAll("[data-view]"))
    button.setAttribute("aria-pressed", String(button.dataset.view === name));
  if (name !== "interactive") {
    clearTimeout(applyTimer);
    generation += 1;
  } else renderInteractive(activeState);
}

for (const mount of document.querySelectorAll("[data-board-state]"))
  mount.replaceChildren(createPanel(mount.dataset.boardState, false));
for (const [name, config] of Object.entries(states)) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.state = name;
  button.textContent = config.label;
  button.setAttribute("aria-pressed", String(name === activeState));
  button.addEventListener("click", () => renderInteractive(name));
  document.getElementById("scenario-buttons").append(button);
}
for (const button of document.querySelectorAll("[data-view]"))
  button.addEventListener("click", () => showView(button.dataset.view));
for (const button of document.querySelectorAll("[data-width]"))
  button.addEventListener("click", () => {
    interactiveMount.style.width = `${button.dataset.width}px`;
    for (const sibling of document.querySelectorAll("[data-width]"))
      sibling.setAttribute("aria-pressed", String(sibling === button));
  });
document
  .getElementById("zoom-control")
  .addEventListener("change", (event) =>
    interactiveMount.classList.toggle("zoomed", event.target.checked),
  );
document
  .getElementById("reset-scenario")
  .addEventListener("click", () => renderInteractive("pending"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeView === "interactive") {
    event.preventDefault();
    if (!queueOpen) renderQueue(activeState);
    else document.querySelector(`button[data-state="${activeState}"]`).focus();
  }
});
renderInteractive("pending");
