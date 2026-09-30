import {
  type McpPanelState,
  type PanelConnection,
  type PanelSnapshot,
  readSnapshots,
} from "@kairomes/protocol";
import { AccessPanel } from "./access-panel.ts";
import { ActiveWorkPanel } from "./active-work-panel.ts";
import { ApprovalPanel } from "./approval-panel.ts";
import { type ApprovalItem, splitApprovalItems } from "./approval-state.ts";
import { browser } from "./browser.ts";
import { McpPanel } from "./mcp-panel.ts";
import { parsePairingUrl, parseWorkbenchUrl } from "./pairing.ts";

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing extension UI: ${selector}`);
  return element;
}
const form = required<HTMLFormElement>("#pair");
const address = required<HTMLInputElement>("#address");
const error = required<HTMLElement>("#error");
const panelError = required<HTMLElement>("#panel-error");
const status = required<HTMLElement>("#connection-status");
const frame = required<HTMLIFrameElement>("#workbench");
const setup = required<HTMLElement>("#setup");
const settings = required<HTMLElement>("#settings");
const settingsBack = required<HTMLButtonElement>("#settings-back");
const settingsPages = [...document.querySelectorAll<HTMLButtonElement>("[data-settings-page]")];
const settingsPanels = [...document.querySelectorAll<HTMLElement>("[data-settings-panel]")];
const disconnect = required<HTMLButtonElement>("#disconnect");
const connectButton = required<HTMLButtonElement>("#connect-button");
const accessContainer = required<HTMLElement>("#access");
const integrationsContainer = required<HTMLElement>("#integrations");
const approvalContainer = required<HTMLElement>("#approvals");
const approvalCount = required<HTMLButtonElement>("#approval-count");
const activeCount = required<HTMLButtonElement>("#active-count");
const activeNumber = required<HTMLElement>("#active-number");
const activeWork = required<HTMLElement>("#active-work");
const activeWorkList = required<HTMLElement>("#active-work-list");
const activeClose = required<HTMLButtonElement>("#active-close");
const copyStatus = required<HTMLElement>("#copy-status");
const setupAdvanced = required<HTMLDetailsElement>("#setup-advanced");
const permission = { origins: ["http://127.0.0.1/*"] };
const storageKey = "kairomesPanel";
let connection: PanelConnection | undefined;
let latest: PanelSnapshot | undefined;
let available = false;
let stream: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let mcpTimer: ReturnType<typeof setInterval> | undefined;
let generation = 0;
let previousPending = 0;

function showActiveWork(open: boolean, restoreFocus = false) {
  const visible = open && !activeCount.hidden;
  activeWork.hidden = !visible;
  activeCount.setAttribute("aria-expanded", String(visible));
  document.body.classList.toggle("active-work-open", visible);
  if (visible) activeWork.querySelector<HTMLElement>("h2")?.focus();
  else if (restoreFocus) activeCount.focus();
}

activeCount.addEventListener("click", () => showActiveWork(activeWork.hidden));
activeClose.addEventListener("click", () => showActiveWork(false, true));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || activeWork.hidden) return;
  event.preventDefault();
  showActiveWork(false, true);
});
document.addEventListener("pointerdown", (event) => {
  if (
    activeWork.hidden ||
    !(event.target instanceof Node) ||
    activeWork.contains(event.target) ||
    activeCount.contains(event.target)
  )
    return;
  const focusable =
    event.target instanceof Element &&
    event.target.closest(
      "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe, label[for], [contenteditable], [tabindex]:not([tabindex='-1'])",
    );
  const restoreFocus = !focusable && activeWork.contains(document.activeElement);
  showActiveWork(false);
  if (restoreFocus)
    setTimeout(() => {
      if (!activeCount.hidden) activeCount.focus();
    }, 0);
});
frame.addEventListener("focus", () => showActiveWork(false));

function setConnectionStatus(label: string, connected = false) {
  const dot = document.createElement("i");
  status.replaceChildren(dot, label);
  status.classList.toggle("connected", connected);
}

const commands = {
  start: `bun.cmd run app --port 0 --extension-id ${browser.runtime.id}`,
  pair: `bun.cmd run kairomes pair --extension-id ${browser.runtime.id}`,
  tunnel: "tunnel-client run --profile kairomes",
};
required<HTMLElement>("#extension-id").textContent = browser.runtime.id;
required<HTMLElement>("#start-command").textContent = commands.start;
required<HTMLElement>("#pair-command").textContent = commands.pair;
required<HTMLElement>("#tunnel-command").textContent = commands.tunnel;
required<HTMLElement>("#tunnel-command-settings").textContent = commands.tunnel;

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = value;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    if (!copied) throw new Error("無法複製，請手動選取指令。");
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy-target]")) {
  const idleLabel = button.textContent ?? "複製";
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget ?? "");
    const value = target?.textContent?.trim();
    if (!value) return;
    button.disabled = true;
    try {
      await copyText(value);
      button.textContent = "已複製";
      button.dataset.copied = "true";
      copyStatus.textContent = `${button.dataset.copyLabel ?? "指令"}已複製到剪貼簿。`;
      setTimeout(() => {
        button.textContent = idleLabel;
        delete button.dataset.copied;
      }, 1600);
    } catch (cause) {
      copyStatus.textContent = cause instanceof Error ? cause.message : "無法複製指令。";
    } finally {
      button.disabled = false;
    }
  });
}

type PairingTarget = ReturnType<typeof parsePairingUrl>;

class PairingRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PairingRequestError";
  }
}

async function pairingPost(target: PairingTarget, route: "pair" | "pair/renew") {
  const response = await fetch(`${target.origin}/api/panel/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: target.code, instanceId: target.instanceId }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? payload : {};
    const code =
      "code" in detail && typeof detail.code === "string" ? detail.code : "PAIRING_FAILED";
    const message =
      "message" in detail && typeof detail.message === "string"
        ? detail.message
        : `配對失敗（${response.status}），請確認 app 仍在執行。`;
    throw new PairingRequestError(code, message);
  }
  return payload;
}

async function redeemPairing(target: PairingTarget) {
  const issued = validate(await pairingPost(target, "pair"));
  if (issued.origin !== target.origin || issued.instanceId !== target.instanceId)
    throw new Error("配對回應與指定的工作台不符。");
  return issued;
}

async function renewPairing(target: PairingTarget) {
  const payload = await pairingPost(target, "pair/renew");
  if (!payload || typeof payload !== "object" || !("pairingUrl" in payload))
    throw new Error("工作台沒有回傳新的配對連結。");
  if (typeof payload.pairingUrl !== "string") throw new Error("新的配對連結格式不正確。");
  const renewed = parsePairingUrl(payload.pairingUrl);
  if (renewed.origin !== target.origin || renewed.instanceId !== target.instanceId)
    throw new Error("換新的配對連結不屬於目前工作台。");
  return renewed;
}

function validate(value: unknown): PanelConnection {
  if (!value || typeof value !== "object") throw new Error("側欄配對資料無效，請重新配對。");
  const data = value as PanelConnection;
  if (
    typeof data.workbenchUrl !== "string" ||
    new URL(parseWorkbenchUrl(data.workbenchUrl)).origin !== data.origin ||
    typeof data.panelToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.panelToken) ||
    typeof data.instanceId !== "string" ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.instanceId)
  )
    throw new Error("側欄配對資料無效，請重新配對。");
  return data;
}
async function api(
  target: PanelConnection,
  route: "approvals" | "disconnect" | "access" | "mcp",
  body: unknown,
) {
  const response = await fetch(`${target.origin}/api/panel/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.panelToken}` },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`本機核准連線失敗（${response.status}）；請確認 app 仍在執行及配對尚未到期。`);
  return response.json();
}
async function decideApproval(session: ApprovalItem, action: "approve" | "deny" | "stop") {
  const target = connection;
  if (!target || !available) throw new Error("等待核准連線恢復後再試。");
  try {
    await api(target, "approvals", {
      action,
      ...("source_file_id" in session
        ? { import_id: session.id }
        : "files" in session
          ? { change_id: session.id }
          : "argv" in session
            ? { command_id: session.id }
            : { session_id: session.id }),
      fingerprint: session.fingerprint,
    });
    const data = await api(target, "approvals", { action: "list" });
    if (connection === target) {
      latest = data;
      panelError.textContent = "";
    }
  } catch (cause) {
    // An uncertain decision must never be replayed automatically. Refresh state only.
    if (connection !== target) return;
    available = false;
    try {
      const data = await api(target, "approvals", { action: "list" });
      if (connection === target) {
        latest = data;
        available = true;
      }
    } catch {
      // A healthy but idle stream may have no changes; reconnect for a full snapshot.
      if (connection === target) startStream(target);
    }
    throw cause;
  } finally {
    setTimeout(() => {
      if (connection === target) renderApprovals();
    }, 0);
  }
}
const reportApprovalError = (message: string) => {
  panelError.textContent = message;
};
const approvals = new ApprovalPanel(approvalContainer, decideApproval, reportApprovalError);
const activePanel = new ActiveWorkPanel(
  activeWorkList,
  (item) => decideApproval(item, "stop"),
  reportApprovalError,
);
const access = new AccessPanel(
  accessContainer,
  async (body) => {
    const target = connection;
    if (!target || !available) throw new Error("等待權限連線恢復後再試。");
    try {
      const next = await api(target, "access", body);
      if (connection === target) {
        latest = next;
        access.render(next, available);
        renderApprovals(next);
      }
    } catch (cause) {
      // Never replay a permission change after uncertain delivery.
      if (connection === target) startStream(target);
      throw cause;
    }
  },
  (message) => {
    panelError.textContent = message;
  },
);
const mcp = new McpPanel(
  integrationsContainer,
  async (body) => {
    const target = connection;
    if (!target || !available) throw new Error("等待本機連線恢復後再試。");
    return (await api(target, "mcp", body)) as McpPanelState;
  },
  (message) => {
    panelError.textContent = message;
  },
);

async function refreshMcp(target: PanelConnection) {
  try {
    const state = (await api(target, "mcp", { action: "list" })) as McpPanelState;
    if (connection === target) mcp.render(state, available);
  } catch (cause) {
    if (connection === target)
      panelError.textContent = cause instanceof Error ? cause.message : "無法讀取 MCP 狀態。";
  }
}

function renderApprovals(snapshot = latest, connected = available) {
  const items = [
    ...(snapshot?.imports ?? []),
    ...(snapshot?.changes ?? []),
    ...(snapshot?.commands ?? []),
    ...(snapshot?.sessions ?? []),
  ];
  const { pending, ongoing } = splitApprovalItems(items);
  approvalCount.hidden = pending.length === 0;
  approvalCount.textContent = `${pending.length} 件需要你`;
  activeCount.hidden = ongoing.length === 0;
  activeCount.setAttribute("aria-label", `執行中的工作 ${ongoing.length} 項`);
  activeCount.title = `執行中的工作 ${ongoing.length} 項`;
  activeNumber.textContent = String(ongoing.length);
  const focusWasInApproval = approvalContainer.contains(document.activeElement);
  approvals.render(pending, connected);
  if (focusWasInApproval && !approvalContainer.contains(document.activeElement)) {
    const nextApproval =
      approvalContainer.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (nextApproval) nextApproval.focus();
    else if (!activeCount.hidden) activeCount.focus();
    else if (!accessContainer.hidden)
      accessContainer.querySelector<HTMLElement>("summary")?.focus();
    else if (!disconnect.hidden) disconnect.focus();
    else connectButton.focus();
  }
  const focusWasInActiveWork = activeWork.contains(document.activeElement);
  activePanel.render(ongoing, connected);
  if (ongoing.length === 0) {
    showActiveWork(false);
    if (focusWasInActiveWork) (approvalCount.hidden ? disconnect : approvalCount).focus();
  } else if (pending.length > previousPending) {
    showActiveWork(false);
    if (focusWasInActiveWork) approvalCount.focus();
  }
  previousPending = pending.length;
}
approvalCount.addEventListener("click", () => {
  showActiveWork(false);
  const first = document.querySelector<HTMLElement>("#approvals .approval-card.pending");
  first?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  first?.querySelector<HTMLButtonElement>("button")?.focus();
});
function stopStream() {
  clearTimeout(timer);
  clearInterval(mcpTimer);
  mcpTimer = undefined;
  stream?.abort();
  stream = undefined;
  available = false;
  access.render(latest, false);
  mcp.render(undefined, false);
  renderApprovals(latest, false);
}
function startStream(target: PanelConnection) {
  stopStream();
  const abort = new AbortController();
  stream = abort;
  let backoff = 1000;
  const connect = async () => {
    try {
      const response = await fetch(`${target.origin}/api/panel/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${target.panelToken}`,
        },
        body: "{}",
        redirect: "error",
        signal: abort.signal,
      });
      if (response.status === 401 || response.status === 403) {
        if (!abort.signal.aborted && connection === target) {
          available = false;
          renderApprovals(latest, false);
          access.render(latest, false);
          setConnectionStatus("配對已失效");
          panelError.textContent = "請解除配對，再使用本機 pair 指令取得新的配對碼。";
          await browser.storage.session.remove(storageKey);
        }
        return;
      }
      await readSnapshots<PanelSnapshot>(
        response,
        (next) => {
          if (next.instanceId !== target.instanceId)
            throw new Error("工作台實例已變更，請重新配對。");
          if (abort.signal.aborted || connection !== target) return;
          latest = next;
          available = true;
          backoff = 1000;
          renderApprovals(next);
          access.render(next);
          if (!mcpTimer) {
            void refreshMcp(target);
            mcpTimer = setInterval(() => void refreshMcp(target), 10_000);
          }
          panelError.textContent = "";
          setConnectionStatus("核准連線已連接", true);
        },
        abort.signal,
      );
    } catch (cause) {
      if (abort.signal.aborted || connection !== target) return;
      available = false;
      renderApprovals(latest, false);
      access.render(latest, false);
      setConnectionStatus("核准連線重連中");
      panelError.textContent = cause instanceof Error ? cause.message : "本機連線中斷。";
    }
    if (!abort.signal.aborted && connection === target) {
      timer = setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
  };
  void connect();
}
function showWorkbench(url: string) {
  showActiveWork(false);
  frame.src = parseWorkbenchUrl(url);
  frame.hidden = false;
  setup.hidden = true;
  settings.hidden = true;
  disconnect.hidden = false;
  accessContainer.hidden = !connection;
  integrationsContainer.hidden = !connection;
  address.value = "";
  error.textContent = "";
}

function showSettings(page: "general" | "mcp" = "general") {
  if (!connection) return;
  showActiveWork(false);
  for (const button of settingsPages) {
    const active = button.dataset.settingsPage === page;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
  for (const panel of settingsPanels) panel.hidden = panel.dataset.settingsPanel !== page;
  frame.hidden = true;
  setup.hidden = true;
  settings.hidden = false;
  settingsPanels
    .find((panel) => panel.dataset.settingsPanel === page)
    ?.querySelector<HTMLElement>("h1")
    ?.focus({ preventScroll: true });
}

settingsBack.addEventListener("click", () => {
  if (!connection) return;
  settings.hidden = true;
  setup.hidden = true;
  frame.hidden = false;
  frame.focus();
});
for (const button of settingsPages) {
  button.addEventListener("click", () => {
    const page = button.dataset.settingsPage;
    if (page === "general" || page === "mcp") showSettings(page);
  });
}
window.addEventListener("message", (event) => {
  if (
    !connection ||
    event.source !== frame.contentWindow ||
    event.origin !== connection.origin ||
    !event.data ||
    typeof event.data !== "object"
  )
    return;
  const message = event.data as { type?: unknown; version?: unknown };
  if (message.type === "kairomes:open-settings" && message.version === 1) showSettings("general");
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const attempt = ++generation;
  const idleLabel = connectButton.textContent ?? "連接我的工作台";
  connectButton.disabled = true;
  connectButton.setAttribute("aria-busy", "true");
  connectButton.textContent = "正在連接…";
  error.textContent = "";
  let issued: PanelConnection | undefined;
  try {
    if (address.value.includes("/#session=")) {
      showWorkbench(address.value);
      setConnectionStatus("瀏覽模式 · 核准請使用配對碼");
      return;
    }
    const pairing = parsePairingUrl(address.value);
    // This permission prompt must remain directly inside a user's submit gesture.
    if (!(await browser.permissions.request(permission)))
      throw new Error(
        "需要允許 Extension 連接本機才能在側欄核准；也可以使用一般工作台網址進入瀏覽模式。",
      );
    try {
      issued = await redeemPairing(pairing);
    } catch (cause) {
      if (!(cause instanceof PairingRequestError) || cause.code !== "PAIRING_EXPIRED") throw cause;
      connectButton.textContent = "連結已過期，正在安全換新…";
      const renewed = await renewPairing(pairing);
      connectButton.textContent = "正在連接…";
      issued = await redeemPairing(renewed);
      copyStatus.textContent = "原配對連結已過期，Kairomes 已安全換新並完成連接。";
    }
    if (generation !== attempt) throw new Error("配對已取消。");
    await browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await browser.storage.session.set({ [storageKey]: issued });
    if (generation !== attempt) throw new Error("配對已取消。");
    connection = issued;
    panelError.textContent = "";
    showWorkbench(issued.workbenchUrl);
    startStream(issued);
  } catch (cause) {
    if (issued && connection !== issued) void api(issued, "disconnect", {}).catch(() => {});
    if (
      cause instanceof PairingRequestError &&
      ["PAIRING_INVALID", "PAIRING_RENEWAL_UNAVAILABLE"].includes(cause.code)
    ) {
      setupAdvanced.open = true;
      error.textContent = `${cause.message} 請保持 app 執行，並複製下方的重新配對指令。`;
    } else error.textContent = cause instanceof Error ? cause.message : "配對失敗。";
  } finally {
    connectButton.disabled = false;
    connectButton.removeAttribute("aria-busy");
    connectButton.textContent = idleLabel;
  }
});
disconnect.addEventListener("click", async () => {
  generation++;
  const target = connection;
  stopStream();
  connection = undefined;
  latest = undefined;
  renderApprovals(undefined, false);
  frame.removeAttribute("src");
  frame.hidden = true;
  settings.hidden = true;
  setup.hidden = false;
  disconnect.hidden = true;
  accessContainer.hidden = true;
  integrationsContainer.hidden = true;
  setConnectionStatus("尚未配對");
  panelError.textContent = "";
  address.focus();
  try {
    await browser.storage.session.remove(storageKey);
  } catch {
    error.textContent = "配對快取清除未完成；請重新載入 Extension。";
  }
  if (target) {
    try {
      await api(target, "disconnect", {});
      error.textContent =
        "已解除配對，完整主機存取及其命令與終端機已撤銷。個別核准的工作仍會持續至自己的期限。";
    } catch {
      error.textContent =
        "已清除本機配對，但伺服器撤銷尚未確認；請重新啟動 app 撤銷所有配對。已核准的 shell 不會因解除配對自動停止。";
    }
  }
});
window.addEventListener("pagehide", stopStream);
void (async () => {
  const attempt = generation;
  try {
    const stored = await browser.storage.session.get(storageKey);
    if (
      !stored[storageKey] ||
      !(await browser.permissions.contains(permission)) ||
      generation !== attempt
    )
      return;
    const target = validate(stored[storageKey]);
    connection = target;
    showWorkbench(target.workbenchUrl);
    startStream(target);
  } catch {
    if (generation === attempt) error.textContent = "無法恢復先前配對，請重新產生本機配對碼。";
  }
})();
