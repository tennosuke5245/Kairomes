import {
  McpAuthInputSchema,
  McpAuthResultSchema,
  type McpPanelState,
  PANEL_ACCESS_LIMITS,
  PanelAccessMutationSchema,
  type PanelAccessResponse,
  type PanelConnection,
  type PanelSnapshot,
  panelAccessFingerprint,
  readSnapshots,
  type TrackedPanelAccessMutation,
} from "@kairomes/protocol";
import {
  AccessMutationTracker,
  AccessPendingConflict,
  accessPendingStorageKey,
  writeAccessPending,
} from "./access-mutation.ts";
import { readAccessMutationSnapshot } from "./access-mutation-snapshot.ts";
import { AccessPanel } from "./access-panel.ts";
import { ActiveWorkPanel } from "./active-work-panel.ts";
import { ApprovalMutationTracker } from "./approval-mutation.ts";
import { ApprovalPanel } from "./approval-panel.ts";
import {
  type ApprovalItem,
  approvalDecisionObserved,
  splitApprovalItems,
} from "./approval-state.ts";
import { browser } from "./browser.ts";
import { writeMcpAuthPending } from "./mcp-auth-tracker.ts";
import { readMcpCatalog } from "./mcp-catalog-read.ts";
import { McpPanel } from "./mcp-panel.ts";
import { parsePairingUrl, parseWorkbenchUrl } from "./pairing.ts";
import { PanelAnnouncements } from "./panel-announcements.ts";
import { panelErrorMessage } from "./panel-error.ts";
import { PanelStreamAvailability } from "./panel-stream-availability.ts";
import { reconcileWorkspaceSelection } from "./workspace-selection.ts";

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing extension UI: ${selector}`);
  return element;
}
const form = required<HTMLFormElement>("#pair");
const address = required<HTMLInputElement>("#address");
const error = required<HTMLElement>("#error");
const panelError = required<HTMLElement>("#panel-error");
const panelNotice = required<HTMLElement>("#panel-notice");
const nativeBar = required<HTMLElement>(".native-bar");
const connectionControls = required<HTMLElement>(".connection-controls");
const settingsContent = required<HTMLElement>(".settings-content");
const status = required<HTMLElement>("#connection-status");
const approvalChannel = required<HTMLElement>("#approval-channel");
const workbenchChannel = required<HTMLElement>("#workbench-channel");
const workspaceFilter = required<HTMLSelectElement>("#workspace-filter");
const panelRecover = required<HTMLButtonElement>("#panel-recover");
const panelStatus = required<HTMLElement>("#panel-status");
const approvalStatus = required<HTMLElement>("#approval-status");
const announcements = new PanelAnnouncements(
  (message) => panelStatus.replaceChildren(document.createTextNode(message)),
  (message) => approvalStatus.replaceChildren(document.createTextNode(message)),
);
const frame = required<HTMLIFrameElement>("#workbench");
const setup = required<HTMLElement>("#setup");
const settings = required<HTMLElement>("#settings");
const settingsOpen = required<HTMLButtonElement>("#settings-open");
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
let settingsReturnFocus: HTMLElement | undefined;

new ResizeObserver(() => {
  document.body.style.setProperty(
    "--native-bar-height",
    `${nativeBar.getBoundingClientRect().height}px`,
  );
}).observe(nativeBar);
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
let mcpOperation = 0;
let mcpAuthOwner: { target: PanelConnection; source: string } | undefined;
let catalogReadGeneration = 0;
let selectedWorkspace: string | null = null;
let needsPairing = false;
const approvalMutations = new ApprovalMutationTracker();
const accessMutations = new AccessMutationTracker();
let accessNeedsPairRecovery = false;
const streamAvailability = new PanelStreamAvailability();

function approvalSource(target = connection) {
  return target ? `${target.origin}:${target.instanceId}` : undefined;
}

function approvalItems(snapshot: PanelSnapshot) {
  return [
    ...(snapshot.imports ?? []),
    ...(snapshot.changes ?? []),
    ...(snapshot.commands ?? []),
    ...snapshot.sessions,
  ];
}

function approvalUncertain(item: ApprovalItem) {
  return approvalMutations.isLocked(approvalSource(), item);
}

function showActiveWork(open: boolean, restoreFocus = false) {
  const visible = open && !activeCount.hidden;
  activeWork.hidden = !visible;
  activeCount.setAttribute("aria-expanded", String(visible));
  document.body.classList.toggle("active-work-open", visible);
  if (visible) activeWork.querySelector<HTMLElement>("h2")?.focus();
  else if (restoreFocus) activeCount.focus();
}

activeCount.addEventListener("click", () => {
  if (approvals.isOpen) approvals.close();
  showActiveWork(Boolean(activeWork.hidden));
});
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
  status.replaceChildren(dot);
  status.setAttribute("aria-label", label);
  status.title = label;
  status.classList.toggle("connected", connected);
  status.dataset.state = connected ? "connected" : "unavailable";
  for (const button of settingsPages)
    button.disabled = button.dataset.settingsPage === "mcp" && (!connection || needsPairing);
  approvalChannel.textContent = connection ? (connected ? "已連接" : label) : "未配對";
  // Status updates are announced once, separately from the visual indicator.
  announcements.connection(label);
}

function syncPanelNotice() {
  if (settings.hidden) {
    if (panelNotice.parentElement !== document.body) panelStatus.before(panelNotice);
    if (panelRecover.parentElement !== connectionControls) connectionControls.append(panelRecover);
  } else {
    if (panelNotice.parentElement !== settingsContent) settingsContent.prepend(panelNotice);
    if (panelRecover.parentElement !== panelNotice) panelNotice.append(panelRecover);
  }
  panelNotice.hidden = !panelError.textContent && (settings.hidden || panelRecover.hidden);
}

function showPanelError(message: string, repair: "refresh" | "pair" = "refresh") {
  message = panelErrorMessage(message, {
    paired: !!connection && !needsPairing,
    stale: !!latest && !available,
    approvalUnknown: approvalMutations.hasUnknown || accessMutations.hasUnknown,
  });
  if (panelError.textContent !== message) panelError.textContent = message;
  panelRecover.hidden = !message;
  const accessRecovery = accessMutations.hasUnknown && accessNeedsPairRecovery;
  const action = accessRecovery ? "pair" : repair;
  panelRecover.dataset.action = action;
  panelRecover.textContent =
    action === "pair" ? (accessRecovery ? "解除配對" : "重新配對") : "查詢狀態";
  syncPanelNotice();
}

function syncWorkspaceFilter() {
  const workspaces = latest?.workspaces ?? [];
  const key = workspaces.map((item) => `${item.id}:${item.name}`).join();
  if (workspaceFilter.dataset.key !== key) {
    workspaceFilter.dataset.key = key;
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "全部本機操作";
    workspaceFilter.replaceChildren(
      all,
      ...workspaces.map((item) => {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.name;
        return option;
      }),
    );
    const selection = reconcileWorkspaceSelection(selectedWorkspace, workspaces);
    selectedWorkspace = selection.id;
    workspaceFilter.value = selectedWorkspace ?? "";
    if (selection.notifyWorkbench) sendWorkspaceFilter();
  }
  workspaceFilter.hidden = !connection;
  workspaceFilter.disabled = !available;
  workspaceFilter.title = workspaceFilter.selectedOptions[0]?.textContent ?? "全部本機操作";
  access.selectWorkspace(selectedWorkspace);
}

function sendWorkspaceFilter() {
  if (!connection) return;
  frame.contentWindow?.postMessage(
    { type: "kairomes:workspace-filter", version: 1, workspaceId: selectedWorkspace },
    connection.origin,
  );
}

workspaceFilter.addEventListener("change", () => {
  selectedWorkspace = workspaceFilter.value || null;
  workspaceFilter.title = workspaceFilter.selectedOptions[0]?.textContent ?? "全部本機操作";
  access.selectWorkspace(selectedWorkspace);
  renderApprovals();
  sendWorkspaceFilter();
});
frame.addEventListener("load", sendWorkspaceFilter);

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
  route: "approvals" | "disconnect" | "access" | "mcp" | "mcp-auth",
  body: unknown,
) {
  const response = await fetch(`${target.origin}/api/panel/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.panelToken}` },
    body: JSON.stringify(body),
    redirect: "error",
    // Stdio initialization allows a first browser sign-in (120s), then tools/list (10s).
    signal: AbortSignal.timeout(
      route === "mcp" && (body as { action?: string })?.action !== "list" ? 150000 : 10000,
    ),
  });
  if (response.status === 401 || response.status === 403) invalidatePairing(target);
  if (!response.ok) {
    let code: string | undefined;
    try {
      const data: unknown = await response.json();
      if (data && typeof data === "object" && "code" in data && typeof data.code === "string")
        code = data.code;
    } catch {
      /* The status alone still classifies the failure. */
    }
    throw new PanelRequestError(response.status, code);
  }
  return response.json();
}
class PanelRequestError extends Error {
  constructor(
    readonly status: number,
    /** Daemon error code, e.g. MCP_CWD_INVALID; only fixed-map text is ever shown for it. */
    readonly code?: string,
  ) {
    super(
      status === 401 || status === 403
        ? "配對已失效。"
        : status === 409
          ? "請求已變更；請重新審閱。"
          : status === 429
            ? "請稍後再查詢狀態。"
            : status < 500
              ? "請求未被接受。"
              : "結果待確認。",
    );
  }
}
async function decideApproval(session: ApprovalItem, action: "approve" | "deny" | "stop") {
  const target = connection;
  if (!target || !available) throw new Error("等待核准連線恢復後再試。");
  const source = approvalSource(target);
  if (!source || approvalMutations.isLocked(source, session)) throw new Error("結果待確認。");
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
    const snapshotAtRead = latest;
    const data = await api(target, "approvals", { action: "list" });
    if (connection === target) {
      if (data.instanceId !== target.instanceId) {
        invalidatePairing(target);
        throw new Error("配對已失效。");
      }
      if (latest === snapshotAtRead) latest = data;
      showPanelError("");
    }
  } catch (cause) {
    // An uncertain decision must never be replayed automatically. Refresh state only.
    if (connection !== target) return;
    if (!(cause instanceof PanelRequestError) || cause.status >= 500) {
      approvalMutations.markUnknown(source, session);
    }
    catalogReadGeneration++;
    available = false;
    access.render(latest, false);
    mcp.render(undefined, false);
    renderApprovals(latest, false);
    if (needsPairing || (cause instanceof PanelRequestError && [401, 403].includes(cause.status))) {
      invalidatePairing(target);
      throw cause;
    }
    try {
      const snapshotAtRead = latest;
      const readStreamGeneration = streamAvailability.generation;
      const returned = await api(target, "approvals", { action: "list" });
      if (connection === target) {
        if (returned.instanceId !== target.instanceId) {
          invalidatePairing(target);
          throw new Error("配對已失效。");
        }
        if (latest === snapshotAtRead) latest = returned;
        const data = latest ?? returned;
        if (streamAvailability.canRestore(readStreamGeneration)) available = true;
        access.render(data, available);
        approvalMutations.observe(source, approvalItems(data));
        const current = [
          ...(data.imports ?? []),
          ...(data.changes ?? []),
          ...(data.commands ?? []),
          ...(data.sessions ?? []),
        ].find((item: ApprovalItem) => item.id === session.id);
        if (approvalDecisionObserved(session, current, action)) {
          showPanelError("");
          return;
        }
        if (
          !approvalMutations.isLocked(source, session) &&
          (!(cause instanceof PanelRequestError) || cause.status >= 500)
        ) {
          showPanelError("");
          return;
        }
      }
    } catch {
      // A healthy but idle stream may have no changes; reconnect for a full snapshot.
      if (connection === target && !needsPairing) startStream(target);
    }
    throw cause instanceof PanelRequestError ? cause : new Error("結果待確認。");
  } finally {
    setTimeout(() => {
      if (connection === target) renderApprovals();
    }, 0);
  }
}
const reportApprovalError = (message: string) => {
  if (!needsPairing) showPanelError(available ? message : "結果待確認。");
};
const approvals = new ApprovalPanel(
  approvalContainer,
  decideApproval,
  reportApprovalError,
  (open) => {
    showActiveWork(false);
    approvalCount.setAttribute("aria-expanded", String(open));
    frame.hidden = open;
    settings.hidden = true;
    syncPanelNotice();
    if (!open) (approvalCount.hidden ? settingsOpen : approvalCount).focus();
  },
  approvalUncertain,
);
const activePanel = new ActiveWorkPanel(
  activeWorkList,
  (item) => decideApproval(item, "stop"),
  reportApprovalError,
  approvalUncertain,
);
const access = new AccessPanel(
  accessContainer,
  async (body) => {
    const target = connection;
    if (!target || !available) throw new Error("等待權限連線恢復後再試。");
    const input = PanelAccessMutationSchema.parse(body);
    const original = accessMutations.current;
    const request: TrackedPanelAccessMutation = {
      ...input,
      request_id: crypto.randomUUID(),
      valid_until: Date.now() + PANEL_ACCESS_LIMITS.intentMs,
      ...(input.action === "disable" && original?.unknown && original.request.action === "enable"
        ? {
            supersedes: {
              request_id: original.request.request_id,
              valid_until: original.request.valid_until,
              fingerprint: original.fingerprint,
            },
          }
        : {}),
    };
    const fingerprint = await panelAccessFingerprint(request);
    if (connection !== target || needsPairing || !available) return;
    if (!accessMutations.begin(target, request, fingerprint)) return;
    accessNeedsPairRecovery = false;
    // A reload must retain the identity even when delivery or its response is lost.
    try {
      await saveAccessPending(
        target,
        accessMutations.saved(),
        original
          ? { id: original.request.request_id, fingerprint: original.fingerprint }
          : undefined,
      );
    } catch {
      accessMutations.reject(target, request.request_id);
      if (connection !== target || needsPairing) return;
      throw new Error("結果待確認。");
    }
    if (connection !== target || needsPairing) return;
    if (!available) {
      accessMutations.reject(target, request.request_id);
      try {
        await saveAccessPending(target, accessMutations.saved(), {
          id: request.request_id,
          fingerprint,
        });
      } catch {
        /* A retained intent remains conservative on the next restore. */
      }
      return;
    }
    let receiptFailed = false;
    let failure: Error | undefined;
    try {
      await readAccessMutationSnapshot(() => api(target, "access", request), {
        instanceId: target.instanceId,
        current: () => connection === target && !needsPairing,
        generation: () => streamAvailability.generation,
        snapshot: () => latest,
        invalidate: () => invalidatePairing(target),
        acknowledge: (next) => {
          receiptFailed = acknowledgeAccess(
            target,
            next as PanelAccessResponse,
            request.request_id,
          );
        },
        receive: (next) => {
          latest = next;
          access.render(next, available);
          renderApprovals(next);
        },
      });
    } catch (cause) {
      // Never replay a permission change after uncertain delivery.
      if (connection !== target) return;
      if (cause instanceof PanelRequestError && cause.status < 500) {
        accessMutations.reject(target, request.request_id);
        if (
          cause.status === 429 &&
          request.action === "disable" &&
          request.supersedes &&
          accessMutations.hasUnknown
        )
          accessNeedsPairRecovery = true;
      } else accessMutations.markUnknown(target, request.request_id);
      if (connection === target && !needsPairing) startStream(target);
      failure = cause instanceof PanelRequestError ? cause : new Error("結果待確認。");
    }
    if (connection !== target || needsPairing) return;
    let cleanupFailed = false;
    try {
      await saveAccessPending(target, accessMutations.saved(), {
        id: request.request_id,
        fingerprint,
      });
    } catch {
      cleanupFailed = true;
    }
    if (connection !== target || needsPairing) return;
    access.render(latest, available);
    renderApprovals();
    showPanelError(receiptFailed || cleanupFailed ? "結果待確認。" : "");
    if (failure) throw failure;
  },
  (message) => {
    reportApprovalError(message);
  },
  () => accessMutations.unknownRequest,
);

async function saveAccessPending(
  target: PanelConnection,
  saved: ReturnType<AccessMutationTracker["saved"]>,
  expected?: { id: string; fingerprint: string },
) {
  try {
    await writeAccessPending(browser.storage.session, target, saved, expected);
  } catch (cause) {
    if (cause instanceof AccessPendingConflict && connection === target && !needsPairing) {
      try {
        await accessMutations.restore(target, cause.saved);
      } catch {
        invalidatePairing(target);
      }
    }
    throw cause;
  }
}

function acknowledgeAccess(target: PanelConnection, next: PanelAccessResponse, id: string) {
  if (connection !== target || needsPairing) return false;
  const settled = accessMutations.observe(target, next.access_receipt);
  if (!settled) accessMutations.markUnknown(target, id);
  if (!accessMutations.hasUnknown) accessNeedsPairRecovery = false;
  else if (
    accessMutations.current?.request.action === "disable" &&
    ["missing", "expired", "superseded"].includes(next.access_receipt?.state ?? "")
  )
    accessNeedsPairRecovery = true;
  return settled && next.access_receipt?.state === "failed";
}
const mcp = new McpPanel(
  integrationsContainer,
  async (body) => {
    const target = connection;
    if (!target || !available) throw new Error("等待本機連線恢復後再試。");
    // Discard background catalogs requested before or during a mutation/reconciliation.
    mcpOperation++;
    try {
      const state = (await api(target, "mcp", body)) as McpPanelState;
      if (connection !== target) throw new Error("連線已變更，請核對狀態。");
      return state;
    } finally {
      mcpOperation++;
    }
  },
  (message) => {
    reportApprovalError(message);
  },
  () => (connection ? `${connection.origin}:${connection.instanceId}` : undefined),
  {
    context: () =>
      connection && !needsPairing && mcpAuthOwner?.target === connection
        ? { source: mcpAuthOwner.source, instanceId: connection.instanceId }
        : undefined,
    request: async (body) => {
      const target = connection;
      if (!target || !available || needsPairing) throw new Error("登入狀態待確認");
      const input = McpAuthInputSchema.parse(body);
      mcpOperation++;
      try {
        const result = McpAuthResultSchema.parse(await api(target, "mcp-auth", input));
        if (connection !== target || needsPairing) throw new Error("登入狀態待確認");
        return result;
      } finally {
        mcpOperation++;
      }
    },
    load: async (identity) => {
      const owner = mcpAuthOwner;
      if (!owner || owner.target !== connection || needsPairing) throw new Error("登入狀態待確認");
      const key = `${owner.source}:${identity.server_id}:${identity.config_fingerprint}`;
      return (await browser.storage.session.get(key))[key];
    },
    save: async (identity, next, expected) => {
      const owner = mcpAuthOwner;
      if (!owner || owner.target !== connection || needsPairing) throw new Error("登入狀態待確認");
      const key = `${owner.source}:${identity.server_id}:${identity.config_fingerprint}`;
      await writeMcpAuthPending(
        browser.storage.session,
        key,
        next,
        expected,
        async (name, work) => {
          if (!navigator.locks) throw new Error("登入狀態待確認");
          await navigator.locks.request(name, async () => {
            if (mcpAuthOwner !== owner || connection !== owner.target || needsPairing)
              throw new Error("登入狀態待確認");
            await work();
          });
        },
      );
    },
    refresh: () => {
      if (connection) void refreshMcp(connection);
    },
  },
);

async function prepareMcpAuthOwner(target: PanelConnection) {
  const key = await accessPendingStorageKey(target);
  if (connection === target && !needsPairing)
    mcpAuthOwner = { target, source: key.replace("kairomesPanelAccess:", "kairomesMcpAuth:") };
}

async function refreshMcp(target: PanelConnection) {
  if (!available || connection !== target || needsPairing) return;
  const operation = mcpOperation;
  const readGeneration = catalogReadGeneration;
  await readMcpCatalog(
    async () => (await api(target, "mcp", { action: "list" })) as McpPanelState,
    () =>
      connection === target &&
      !needsPairing &&
      available &&
      operation === mcpOperation &&
      readGeneration === catalogReadGeneration,
    (state) => mcp.render(state, available),
    (cause) =>
      showPanelError(cause instanceof PanelRequestError ? cause.message : "無法讀取 MCP 狀態。"),
  );
}

function renderApprovals(snapshot = latest, connected = available) {
  const source = approvalSource();
  if (snapshot && connected && source && snapshot.instanceId === connection?.instanceId)
    approvalMutations.observe(source, approvalItems(snapshot));
  const items = [
    ...(snapshot?.imports ?? []),
    ...(snapshot?.changes ?? []),
    ...(snapshot?.commands ?? []),
    ...(snapshot?.sessions ?? []),
  ];
  const { pending, ongoing } = splitApprovalItems(items);
  approvalCount.hidden = pending.length === 0;
  approvalCount.textContent = `需確認 ${pending.length}`;
  announcements.approvals(pending.map((item) => item.id));
  activeCount.hidden = ongoing.length === 0;
  activeCount.setAttribute("aria-label", `執行中的工作 ${ongoing.length} 項`);
  activeCount.title = `執行中的工作 ${ongoing.length} 項`;
  activeNumber.textContent = String(ongoing.length);
  const focusWasInApproval = approvalContainer.contains(document.activeElement);
  approvals.render(pending, connected, selectedWorkspace);
  if (focusWasInApproval && !approvalContainer.contains(document.activeElement)) {
    const nextApproval =
      approvalContainer.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (nextApproval) nextApproval.focus();
    else if (!activeCount.hidden) activeCount.focus();
    else if (!accessContainer.hidden)
      accessContainer.querySelector<HTMLElement>("summary")?.focus();
    else if (!disconnect.hidden) settingsOpen.focus();
    else connectButton.focus();
  }
  const focusWasInActiveWork = activeWork.contains(document.activeElement);
  activePanel.render(ongoing, connected);
  if (ongoing.length === 0) {
    showActiveWork(false);
    if (focusWasInActiveWork) (approvalCount.hidden ? settingsOpen : approvalCount).focus();
  }
}
approvalCount.addEventListener("click", () => {
  showActiveWork(false);
  approvals.open();
});
function stopStream() {
  catalogReadGeneration++;
  streamAvailability.disconnected();
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
  const current = () => !abort.signal.aborted && stream === abort && connection === target;
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
        if (current()) {
          invalidatePairing(target);
        }
        return;
      }
      await readSnapshots<PanelSnapshot>(
        response,
        (next) => {
          if (!current()) return;
          if (next.instanceId !== target.instanceId) {
            invalidatePairing(target);
            throw new Error("工作台實例已變更，請重新配對。");
          }
          latest = next;
          streamAvailability.receivedSnapshot();
          available = true;
          needsPairing = false;
          backoff = 1000;
          renderApprovals(next);
          access.render(next);
          syncWorkspaceFilter();
          if (!mcpTimer) {
            void refreshMcp(target);
            mcpTimer = setInterval(() => void refreshMcp(target), 10_000);
          }
          // An unrelated activity snapshot cannot settle a pending MCP setting change.
          if (!mcp.hasUncertainMutation) showPanelError("");
          setConnectionStatus("本機已連接", true);
        },
        abort.signal,
      );
    } catch {
      if (!current()) return;
      catalogReadGeneration++;
      streamAvailability.disconnected();
      clearInterval(mcpTimer);
      mcpTimer = undefined;
      available = false;
      renderApprovals(latest, false);
      access.render(latest, false);
      mcp.render(undefined, false);
      workspaceFilter.disabled = true;
      setConnectionStatus("本機重連中");
      // A retained snapshot remains visible, but cannot authorize a decision.
      showPanelError("顯示上次快照。");
    }
    if (current()) {
      timer = setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
  };
  void connect();
}
function invalidatePairing(target: PanelConnection) {
  if (connection !== target) return;
  stopStream();
  needsPairing = true;
  mcpAuthOwner = undefined;
  mcp.render(undefined, false);
  accessMutations.bind(undefined);
  accessNeedsPairRecovery = false;
  void accessPendingStorageKey(target)
    .then((key) => browser.storage.session.remove(key))
    .catch(() => {});
  workspaceFilter.disabled = true;
  setConnectionStatus("配對已失效");
  showPanelError("", "pair");
  panelRecover.hidden = false;
  syncPanelNotice();
  void browser.storage.session.remove(storageKey);
}
function showWorkbench(url: string) {
  showActiveWork(false);
  frame.src = parseWorkbenchUrl(url);
  frame.hidden = false;
  setup.hidden = true;
  settings.hidden = true;
  syncPanelNotice();
  disconnect.hidden = false;
  accessContainer.hidden = !connection;
  integrationsContainer.hidden = !connection;
  address.value = "";
  error.textContent = "";
}

function showSettings(page: "general" | "mcp" = "general", returnFocus?: HTMLElement) {
  if ((!connection || needsPairing) && page === "mcp") return;
  if (settings.hidden) settingsReturnFocus = returnFocus ?? (frame.hidden ? address : frame);
  if (approvals.isOpen) approvals.close();
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
  syncPanelNotice();
  settingsPanels
    .find((panel) => panel.dataset.settingsPanel === page)
    ?.querySelector<HTMLElement>("h1")
    ?.focus({ preventScroll: true });
}

settingsBack.addEventListener("click", () => {
  if (!frame.getAttribute("src")) {
    settings.hidden = true;
    setup.hidden = false;
    syncPanelNotice();
    (settingsReturnFocus ?? address).focus();
    return;
  }
  settings.hidden = true;
  setup.hidden = true;
  syncPanelNotice();
  frame.hidden = false;
  (settingsReturnFocus ?? frame).focus();
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
  const message = event.data as {
    type?: unknown;
    version?: unknown;
    workspaceId?: unknown;
    available?: unknown;
  };
  if (message.type === "kairomes:open-settings" && message.version === 1) showSettings("general");
  if (message.version !== 1) return;
  if (message.type === "kairomes:workbench-ready") sendWorkspaceFilter();
  if (message.type === "kairomes:workbench-status" && typeof message.available === "boolean")
    workbenchChannel.textContent = message.available ? "已連接" : "資料待更新";
  if (
    message.type === "kairomes:workspace-select" &&
    (message.workspaceId === null ||
      latest?.workspaces?.some((item) => item.id === message.workspaceId))
  ) {
    selectedWorkspace = typeof message.workspaceId === "string" ? message.workspaceId : null;
    workspaceFilter.value = selectedWorkspace ?? "";
    syncWorkspaceFilter();
    renderApprovals();
    sendWorkspaceFilter();
  }
});
settingsOpen.addEventListener("click", () =>
  showSettings(connection && !needsPairing ? "mcp" : "general", settingsOpen),
);
panelRecover.addEventListener("click", async () => {
  if (panelRecover.dataset.action === "pair") {
    disconnect.click();
    return;
  }
  const target = connection;
  if (
    target &&
    available &&
    !needsPairing &&
    mcp.hasUncertainMutation &&
    !accessMutations.hasUnknown &&
    !approvalMutations.hasUnknown
  ) {
    const recoverHadFocus = document.activeElement === panelRecover;
    panelRecover.disabled = true;
    try {
      await mcp.reconcile();
      if (
        connection === target &&
        !mcp.hasUncertainMutation &&
        recoverHadFocus &&
        document.activeElement === document.body &&
        !settings.hidden
      )
        integrationsContainer.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    } finally {
      panelRecover.disabled = false;
    }
    return;
  }
  const pendingAccess = accessMutations.current;
  if (target && pendingAccess && accessMutations.hasUnknown) {
    panelRecover.disabled = true;
    let receiptFailed = false;
    try {
      await readAccessMutationSnapshot(
        () =>
          api(target, "access", { action: "status", request_id: pendingAccess.request.request_id }),
        {
          instanceId: target.instanceId,
          current: () => connection === target && !needsPairing,
          generation: () => streamAvailability.generation,
          snapshot: () => latest,
          invalidate: () => invalidatePairing(target),
          acknowledge: (next) => {
            receiptFailed = acknowledgeAccess(
              target,
              next as PanelAccessResponse,
              pendingAccess.request.request_id,
            );
          },
          receive: (next) => {
            latest = next;
          },
        },
      );
      if (connection === target && !needsPairing) {
        await saveAccessPending(target, accessMutations.saved(), {
          id: pendingAccess.request.request_id,
          fingerprint: pendingAccess.fingerprint,
        });
        if (connection !== target || needsPairing) return;
        access.render(latest, available);
        renderApprovals();
        showPanelError(receiptFailed ? "結果待確認。" : "");
      }
    } catch {
      if (connection === target && !needsPairing) showPanelError("結果待確認。");
    } finally {
      panelRecover.disabled = false;
    }
    return;
  }
  if (target && approvalMutations.hasUnknown) {
    panelRecover.disabled = true;
    try {
      const snapshotAtRead = latest;
      const readStreamGeneration = streamAvailability.generation;
      const data = (await api(target, "approvals", { action: "list" })) as PanelSnapshot;
      if (connection !== target || needsPairing) return;
      if (data.instanceId !== target.instanceId) {
        invalidatePairing(target);
        return;
      }
      if (latest === snapshotAtRead) latest = data;
      if (streamAvailability.canRestore(readStreamGeneration)) available = true;
      const snapshot = latest ?? data;
      const source = approvalSource(target);
      if (source) approvalMutations.observe(source, approvalItems(snapshot));
      access.render(snapshot, available);
      syncWorkspaceFilter();
      renderApprovals(snapshot, available);
      showPanelError("");
    } catch {
      if (connection === target && !needsPairing) showPanelError("結果待確認。");
    } finally {
      panelRecover.disabled = false;
    }
    return;
  }
  if (connection) startStream(connection);
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
      setConnectionStatus("僅可瀏覽");
      return;
    }
    const pairing = parsePairingUrl(address.value);
    // This permission prompt must remain directly inside a user's submit gesture.
    if (!(await browser.permissions.request(permission)))
      throw new Error("請允許連接本機，再試一次。");
    try {
      issued = await redeemPairing(pairing);
    } catch (cause) {
      if (!(cause instanceof PairingRequestError) || cause.code !== "PAIRING_EXPIRED") throw cause;
      connectButton.textContent = "正在換新連結…";
      const renewed = await renewPairing(pairing);
      connectButton.textContent = "正在連接…";
      issued = await redeemPairing(renewed);
      copyStatus.textContent = "已換新配對連結。";
    }
    if (generation !== attempt) throw new Error("配對已取消。");
    await browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await browser.storage.session.set({ [storageKey]: issued });
    if (generation !== attempt) throw new Error("配對已取消。");
    connection = issued;
    needsPairing = false;
    await prepareMcpAuthOwner(issued);
    if (connection !== issued || generation !== attempt) throw new Error("配對已取消。");
    accessMutations.bind(issued);
    accessNeedsPairRecovery = false;
    approvalMutations.bind(approvalSource());
    showPanelError("");
    showWorkbench(issued.workbenchUrl);
    startStream(issued);
  } catch (cause) {
    if (issued && connection !== issued) void api(issued, "disconnect", {}).catch(() => {});
    if (
      cause instanceof PairingRequestError &&
      ["PAIRING_INVALID", "PAIRING_RENEWAL_UNAVAILABLE"].includes(cause.code)
    ) {
      setupAdvanced.open = true;
      error.textContent = "請在 Desktop 取得新連結後重新配對。";
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
  if (approvals.isOpen) approvals.close();
  connection = undefined;
  mcpAuthOwner = undefined;
  mcp.render(undefined, false);
  accessMutations.bind(undefined);
  accessNeedsPairRecovery = false;
  if (target)
    void accessPendingStorageKey(target)
      .then((key) => browser.storage.session.remove(key))
      .catch(() => {});
  approvalMutations.bind(undefined);
  latest = undefined;
  renderApprovals(undefined, false);
  frame.removeAttribute("src");
  frame.hidden = true;
  settings.hidden = true;
  setup.hidden = false;
  disconnect.hidden = true;
  accessContainer.hidden = true;
  integrationsContainer.hidden = true;
  workspaceFilter.hidden = true;
  selectedWorkspace = null;
  workbenchChannel.textContent = "待確認";
  setConnectionStatus("尚未配對");
  showPanelError("");
  address.focus();
  try {
    await browser.storage.session.remove(storageKey);
  } catch {
    error.textContent = "配對快取清除未完成；請重新載入 Extension。";
  }
  if (target) {
    try {
      await api(target, "disconnect", {});
      error.textContent = "已解除配對並收回自主授權；個別核准的工作仍會持續。";
    } catch {
      error.textContent = "伺服器撤銷待確認；請重啟 app。個別核准的工作仍可能持續。";
    }
  }
});
window.addEventListener("pagehide", () => {
  stopStream();
  if (approvals.isOpen) approvals.close();
});
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
    await prepareMcpAuthOwner(target);
    if (connection !== target || generation !== attempt) return;
    accessMutations.bind(target);
    const pendingKey = await accessPendingStorageKey(target);
    const pending = await browser.storage.session.get(pendingKey);
    if (connection !== target || generation !== attempt) return;
    if (pending[pendingKey]) await accessMutations.restore(target, pending[pendingKey]);
    if (connection !== target || generation !== attempt) return;
    approvalMutations.bind(approvalSource());
    showWorkbench(target.workbenchUrl);
    startStream(target);
  } catch {
    if (connection && generation === attempt) invalidatePairing(connection);
    if (generation === attempt) error.textContent = "無法恢復先前配對，請重新產生本機配對碼。";
  }
})();
