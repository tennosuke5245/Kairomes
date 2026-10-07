import {
  type ArtifactImportApproval,
  McpAuthInputSchema,
  McpAuthResultSchema,
  type McpPanelState,
  PANEL_ACCESS_LIMITS,
  PanelAccessMutationSchema,
  type PanelAccessResponse,
  type PanelConnection,
  type PanelImportResponse,
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
import { ApprovalMutationTracker } from "./approval-mutation.ts";
import { ApprovalPanel } from "./approval-panel.ts";
import {
  type ApprovalItem,
  approvalDecisionObserved,
  awaitingDecision,
  checkDenialReason,
  isImportItem,
  splitApprovalItems,
} from "./approval-state.ts";
import { browser } from "./browser.ts";
import { setIcon } from "./icons.ts";
import { importErrorText } from "./image-file.ts";
import { ImageIntake, type ImageTarget } from "./image-intake.ts";
import { ImageUploadTracker } from "./image-upload.ts";
import { ImportClient, ImportRequestError } from "./import-client.ts";
import { ImportDialog } from "./import-dialog.ts";
import { writeMcpAuthPending } from "./mcp-auth-tracker.ts";
import { readMcpCatalog } from "./mcp-catalog-read.ts";
import { McpPanel } from "./mcp-panel.ts";
import { NoticeSlot } from "./notice-slot.ts";
import { parsePairingUrl, parseWorkbenchUrl } from "./pairing.ts";
import { PanelAnnouncements } from "./panel-announcements.ts";
import { type NoticeTone, panelRecoveryNotice, STALE_NOTICE } from "./panel-error.ts";
import { PanelStreamAvailability } from "./panel-stream-availability.ts";
import { importHydrationText, panelView, settingsBackLabel } from "./panel-view.ts";
import { commandTokens, setupCommands } from "./setup-commands.ts";
import {
  actionBadgeText,
  activeIndicator,
  type ConnectionState,
  connectionView,
  needButton,
} from "./toolbar-state.ts";
import {
  ALL_PROJECTS,
  reconcileWorkspaceSelection,
  workspaceLabel,
} from "./workspace-selection.ts";

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing extension UI: ${selector}`);
  return element;
}
const form = required<HTMLFormElement>("#pair");
const address = required<HTMLInputElement>("#address");
const panelNotice = required<HTMLElement>("#panel-notice");
const status = required<HTMLElement>("#connection-status");
const statusDot = required<HTMLElement>("#connection-status .k-dot");
const brand = required<HTMLElement>("#brand");
const approvalChannel = required<HTMLElement>("#approval-channel");
const workbenchChannel = required<HTMLElement>("#workbench-channel");
const importHydration = required<HTMLElement>("#import-hydration");
const settingsReconnect = required<HTMLButtonElement>("#settings-reconnect");
const workspaceSwitcher = required<HTMLElement>("#workspace-switcher");
const workspaceFilter = required<HTMLSelectElement>("#workspace-filter");
const panelRecover = required<HTMLButtonElement>("#panel-recover");
const panelStatus = required<HTMLElement>("#panel-status");
const approvalStatus = required<HTMLElement>("#approval-status");
const accessStatus = required<HTMLElement>("#access-status");
const announcements = new PanelAnnouncements(
  (message) => panelStatus.replaceChildren(document.createTextNode(message)),
  (message) => approvalStatus.replaceChildren(document.createTextNode(message)),
);
const frame = required<HTMLIFrameElement>("#workbench");
const workbenchEmpty = required<HTMLElement>("#workbench-empty");
const workbenchEmptyReload = required<HTMLButtonElement>("#workbench-reload");
const setup = required<HTMLElement>("#setup");
const settings = required<HTMLElement>("#settings");
const settingsOpen = required<HTMLButtonElement>("#settings-open");
const settingsBack = required<HTMLButtonElement>("#settings-back");
const settingsPages = [...document.querySelectorAll<HTMLButtonElement>("[data-settings-page]")];
const settingsPanels = [...document.querySelectorAll<HTMLElement>("[data-settings-panel]")];
const pairingRow = required<HTMLElement>("#pairing-row");
const disconnect = required<HTMLButtonElement>("#disconnect");
const disconnectDialog = required<HTMLDialogElement>("#disconnect-dialog");
const connectButton = required<HTMLButtonElement>("#connect-button");
const accessTrigger = required<HTMLButtonElement>("#access");
const integrationsContainer = required<HTMLElement>("#integrations");
const approvalContainer = required<HTMLElement>("#approvals");
const approvalCount = required<HTMLButtonElement>("#approval-count");
const approvalNumber = required<HTMLElement>("#approval-number");
const activeCount = required<HTMLButtonElement>("#active-count");
const activeNumber = required<HTMLElement>("#active-number");
let settingsReturnFocus: HTMLElement | undefined;
let settingsVisible = false;
let workbenchUrl: string | undefined;

const copyStatus = required<HTMLElement>("#copy-status");
const setupAdvanced = required<HTMLDetailsElement>("#setup-advanced");
const notice = new NoticeSlot(
  panelNotice,
  {
    icon: required<SVGSVGElement>("#panel-notice > .k-icon"),
    message: required<HTMLElement>("#panel-error"),
    action: panelRecover,
    close: required<HTMLButtonElement>("#notice-close"),
  },
  () => visibleBodyFocus(),
);
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
/** Upload identities for image imports, scoped to the paired instance like decisions. */
const uploads = new ImageUploadTracker();
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

/** 設定 › 一般: whether ChatGPT attached the image to its import requests (trusted counts). */
function renderImportHydration(snapshot: PanelSnapshot | undefined) {
  const text = importHydrationText(snapshot?.importHydration);
  importHydration.hidden = !text;
  importHydration.textContent = text ?? "";
}

function approvalUncertain(item: ApprovalItem) {
  return approvalMutations.isLocked(approvalSource(), item);
}

/** One paired instance at a time: decisions and uploads start empty. */
function bindInstance() {
  const source = approvalSource();
  approvalMutations.bind(source);
  uploads.bind(source);
}

// 執行中 opens the approval page on its own tab; stop controls stay in native DOM there.
activeCount.addEventListener("click", () => approvals.toggle("running"));

/** One body below the toolbar; the toolbar keeps its height, so the iframe never jumps. */
function renderView() {
  const view = panelView({
    settingsOpen: settingsVisible,
    approvalsOpen: approvals.isOpen,
    hasWorkbench: workbenchUrl !== undefined,
    frameLoaded: frame.hasAttribute("src"),
  });
  settings.hidden = view !== "settings";
  setup.hidden = view !== "setup";
  frame.hidden = view !== "workbench";
  workbenchEmpty.hidden = view !== "empty";
  const approvalsTab = view === "approvals" ? approvals.tab : undefined;
  approvalCount.setAttribute(
    "aria-pressed",
    String(approvalsTab !== undefined && approvalsTab !== "running"),
  );
  activeCount.setAttribute("aria-pressed", String(approvalsTab === "running"));
  settingsOpen.setAttribute("aria-pressed", String(view === "settings"));
  const gear = settingsOpen.querySelector<SVGSVGElement>("svg");
  if (gear) setIcon(gear, "GearSix", view === "settings");
  const back = settingsBackLabel(workbenchUrl !== undefined);
  if (settingsBack.getAttribute("aria-label") !== back)
    settingsBack.setAttribute("aria-label", back);
}

/** A sensible focus target when the focused element disappears. */
function visibleBodyFocus(): HTMLElement | undefined {
  if (!settings.hidden)
    return settingsPages.find((tab) => tab.getAttribute("aria-selected") === "true");
  if (!setup.hidden) return address;
  if (!workbenchEmpty.hidden) return workbenchEmptyReload;
  return approvalCount.hidden ? settingsOpen : approvalCount;
}

function setConnectionStatus(state: ConnectionState) {
  const view = connectionView(state);
  status.setAttribute("aria-label", `Kairomes：${view.label}`);
  status.title = view.label;
  status.dataset.state = state;
  statusDot.dataset.tone = view.tone;
  if (view.pulse) statusDot.dataset.pulse = "";
  else statusDot.removeAttribute("data-pulse");
  const mcpTab = settingsPages.find((tab) => tab.dataset.settingsPage === "mcp");
  const mcpBlocked = !connection || needsPairing;
  if (mcpTab) {
    mcpTab.setAttribute("aria-disabled", String(mcpBlocked));
    if (mcpBlocked) mcpTab.title = "配對後才能管理 MCP";
    else mcpTab.removeAttribute("title");
  }
  approvalChannel.dataset.tone = view.tone;
  approvalChannel.querySelector<HTMLElement>(".k-dot")?.setAttribute("data-tone", view.tone);
  const channelLabel = approvalChannel.querySelector("span:last-child");
  if (channelLabel) channelLabel.textContent = view.label;
  settingsReconnect.hidden = !connection || needsPairing || state === "connected";
  pairingRow.hidden = !connection && workbenchUrl === undefined;
  // Status updates are announced once, separately from the visual indicator.
  announcements.connection(`本機工作台：${view.label}`);
}

function showPanelError(message: string, repair: "refresh" | "pair" = "refresh") {
  const paired = !!connection && !needsPairing;
  notice.setRecovery(
    panelRecoveryNotice(message, {
      paired,
      needsPairing: !!connection && needsPairing,
      stale: !!latest && !available,
      approvalUnknown: approvalMutations.hasUnknown || accessMutations.hasUnknown,
      accessRecovery: accessMutations.hasUnknown && accessNeedsPairRecovery,
      repair,
    }),
  );
}

/** A one-off line in the notice slot (pairing results, unpair outcome). */
function flashNotice(message: string, tone: NoticeTone = "danger") {
  notice.flash(message ? { message, tone } : undefined);
}

function syncSwitcherLabel() {
  const view = workspaceLabel(selectedWorkspace, latest?.workspaces ?? []);
  workspaceFilter.title = view.label;
  const switcherIcon = workspaceSwitcher.querySelector<SVGSVGElement>(".sp-switcher__icon");
  if (switcherIcon) setIcon(switcherIcon, view.icon);
}

function syncWorkspaceFilter() {
  const workspaces = latest?.workspaces ?? [];
  const key = workspaces.map((item) => `${item.id}:${item.name}`).join();
  if (workspaceFilter.dataset.key !== key) {
    workspaceFilter.dataset.key = key;
    const all = document.createElement("option");
    all.value = "";
    all.textContent = ALL_PROJECTS;
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
  workspaceSwitcher.hidden = !connection;
  brand.hidden = !workspaceSwitcher.hidden;
  workspaceFilter.disabled = !available;
  syncSwitcherLabel();
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
  syncSwitcherLabel();
  access.selectWorkspace(selectedWorkspace);
  renderApprovals();
  sendWorkspaceFilter();
});
frame.addEventListener("load", sendWorkspaceFilter);

const commands = setupCommands(browser.runtime.id);
/** Each argument wraps as a unit; the text (and so the copy) stays the exact command. */
function showCommand(selector: string, command: string) {
  const target = required<HTMLElement>(selector);
  target.replaceChildren();
  commandTokens(command).forEach((token, index) => {
    if (index) target.append(" ");
    const span = document.createElement("span");
    span.className = "sp-copy__token";
    span.textContent = token;
    target.append(span);
  });
}
required<HTMLElement>("#extension-id").textContent = browser.runtime.id;
showCommand("#start-command", commands.start);
showCommand("#pair-command", commands.pair);
showCommand("#tunnel-command", commands.tunnel);
showCommand("#tunnel-command-settings", commands.tunnel);

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
  const label = button.querySelector<HTMLElement>("[data-copy-text]");
  const glyph = button.querySelector<SVGSVGElement>("svg");
  const idleLabel = label?.textContent ?? "複製";
  let reset: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget ?? "");
    const value = target?.textContent?.trim();
    if (!value) return;
    button.disabled = true;
    try {
      await copyText(value);
      if (label) label.textContent = "已複製";
      if (glyph) setIcon(glyph, "Check");
      button.dataset.copied = "true";
      copyStatus.textContent = `${button.dataset.copyLabel ?? "指令"}已複製到剪貼簿。`;
      clearTimeout(reset);
      reset = setTimeout(() => {
        if (label) label.textContent = idleLabel;
        if (glyph) setIcon(glyph, "Copy");
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
    /** Daemon error code, e.g. IMPORT_PREVIEW_REQUIRED; only fixed-map text is shown. */
    readonly code?: string,
  ) {
    super(
      status === 401 || status === 403
        ? "配對已失效。"
        : code === "IMPORT_PREVIEW_REQUIRED"
          ? importErrorText(code)
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

/** Fetch for the binary image routes: same token, origin and no-redirect rule as api(). */
async function panelFetch(
  target: PanelConnection,
  path: string,
  init: RequestInit & { timeoutMs: number },
) {
  const { timeoutMs, signal, headers, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${target.origin}${path}`, {
    ...rest,
    headers: {
      ...(headers as Record<string, string>),
      Authorization: `Bearer ${target.panelToken}`,
    },
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  // A refused token ends the pairing. A 403 on the preview GET (no Origin is sent on a GET from
  // this page) is a refused read, not proof that the pairing is gone.
  if (response.status === 401 || (response.status === 403 && rest.method !== "GET"))
    invalidatePairing(target);
  return response;
}

const importClient = new ImportClient({
  fetch: (path, init) => {
    const target = connection;
    // Nothing is sent without a usable pairing, so this refusal is definite.
    if (!target || needsPairing || !available) throw ImportRequestError.unsent("OFFLINE");
    return panelFetch(target, path, init);
  },
  uploads,
  source: () => approvalSource(),
});

/**
 * Runs an import route and adopts the snapshot it returns, unless the stream delivered a newer
 * frame meanwhile (that frame already holds the change). A different instance ends the pairing.
 */
async function withImportSnapshot(run: () => Promise<PanelImportResponse>) {
  const target = connection;
  const before = latest;
  const response = await run();
  if (target && connection === target) {
    if (response.instanceId !== target.instanceId) {
      invalidatePairing(target);
      throw new ImportRequestError("PANEL_UNAUTHORIZED", undefined, false);
    }
    if (latest === before) {
      const { import: _touched, ...snapshot } = response;
      latest = snapshot;
      renderApprovals(snapshot);
    }
  }
  return response;
}

function findImport(id: string): ArtifactImportApproval | undefined {
  return latest?.imports?.find((item) => item.id === id);
}

/** The 匯入圖片 action exists once paired with at least one mounted project. */
function canStartImport() {
  return Boolean(connection) && !needsPairing && (latest?.workspaces?.length ?? 0) > 0;
}
async function decideApproval(
  session: ApprovalItem,
  action: "approve" | "deny" | "stop",
  reason?: string,
) {
  const target = connection;
  if (!target || !available) throw new Error("等待核准連線恢復後再試。");
  const source = approvalSource(target);
  if (!source || approvalMutations.isLocked(source, session)) throw new Error("結果待確認。");
  // A reason travels only with a deny, inside the same single request; it is checked before
  // anything is sent, so a rejected reason never leaves an unconfirmed decision behind.
  const denial = action === "deny" && reason !== undefined ? checkDenialReason(reason) : undefined;
  if (denial && !denial.ok) throw new Error(denial.message);
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
      ...(denial?.ok && denial.reason !== undefined ? { reason: denial.reason } : {}),
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
const importDialog = new ImportDialog({
  client: {
    create: (input, signal) => withImportSnapshot(() => importClient.create(input, signal)),
    upload: (item, image, signal) =>
      withImportSnapshot(() => importClient.upload(item, image, signal)),
    content: (item, signal) => importClient.content(item, signal),
  },
  workspaces: () => latest?.workspaces ?? [],
  defaultWorkspace: () => selectedWorkspace,
  available: () => available && !!connection && !needsPairing,
  find: findImport,
  decide: async (item, action) => {
    try {
      await decideApproval(item, action);
    } catch (cause) {
      reportApprovalError(cause instanceof Error ? cause.message : "結果待確認。");
      throw cause;
    }
  },
  finished: (id, approved, image) => approvals.openItem(id, { approved, image }),
  announce: (message) => approvalStatus.replaceChildren(document.createTextNode(message)),
});
function openImportDialog(file?: File, pasteAgain = false) {
  const active = document.activeElement;
  importDialog.open({
    file,
    pasteAgain,
    returnFocus: active instanceof HTMLElement && active !== document.body ? active : approvalCount,
  });
}

const importUnavailableText = () =>
  !connection || needsPairing ? "配對後才能匯入圖片。" : "還沒有專案；請先在 Desktop 加入專案。";

/**
 * An image was pasted while the workbench frame had focus. Its bytes stay in that frame (it is
 * another origin and never uploads), so the panel takes focus and asks for the paste again.
 * Acted on only while the frame really has focus: the frame cannot open the dialog on its own.
 */
function relayWorkbenchPaste() {
  if (document.activeElement !== frame || importDialog.isOpen) return;
  if (!canStartImport()) {
    flashNotice(importUnavailableText(), "warning");
    return;
  }
  openImportDialog(undefined, true);
}

/**
 * 檢查目前檔案 / 查看既有檔案: show the workbench with that file open. The workbench reads it
 * with its own tools; the panel only names the workspace and relative path.
 */
function openWorkbenchFile(workspaceId: string, path: string) {
  const target = connection;
  const workbench = frame.contentWindow;
  if (!target || !workbench || !latest?.workspaces?.some((item) => item.id === workspaceId)) {
    flashNotice("這個專案已不在工作台，無法開啟檔案。", "warning");
    return;
  }
  // A filter on another project would hide the file; switch to its project first.
  if (selectedWorkspace !== null && selectedWorkspace !== workspaceId) {
    selectedWorkspace = workspaceId;
    workspaceFilter.value = workspaceId;
    syncSwitcherLabel();
    access.selectWorkspace(selectedWorkspace);
    renderApprovals();
    sendWorkspaceFilter();
  }
  approvals.close();
  workbench.postMessage(
    { type: "kairomes:open-artifact", version: 1, workspaceId, path },
    target.origin,
  );
  frame.focus();
}
const approvals = new ApprovalPanel(approvalContainer, {
  decide: decideApproval,
  report: reportApprovalError,
  inform: (message) => {
    showPanelError("");
    flashNotice(message, "neutral");
  },
  change: (open, tab) => {
    if (open) {
      settingsVisible = false;
      access.close();
    }
    renderView();
    if (!open) {
      const trigger = tab === "running" && !activeCount.hidden ? activeCount : approvalCount;
      (trigger.hidden ? settingsOpen : trigger).focus();
    }
  },
  uncertain: approvalUncertain,
  announce: (message) => approvalStatus.replaceChildren(document.createTextNode(message)),
  imports: {
    content: (item, signal) => importClient.content(item, signal),
    upload: async (item, image) => {
      await withImportSnapshot(() => importClient.upload(item, image));
    },
    uploadStatus: (item) => uploads.status(approvalSource(), item.id),
  },
  startImport: () => openImportDialog(),
  canStartImport,
  openFile: (item) => openWorkbenchFile(item.workspace_id, item.path),
  refresh: async () => {
    const target = connection;
    if (!target || needsPairing || !available) throw new Error("offline");
    const before = latest;
    const data = (await api(target, "approvals", { action: "list" })) as PanelSnapshot;
    if (connection !== target) return;
    if (data.instanceId !== target.instanceId) {
      invalidatePairing(target);
      return;
    }
    if (latest === before) latest = data;
    renderApprovals();
  },
});

// Paste or drop an image anywhere in the panel: into the open import that waits for one,
// into the open dialog, or as a new import of the user's own.
const intake = new ImageIntake({
  target: (): ImageTarget | undefined => {
    if (importDialog.isOpen)
      return {
        offer: (file) => importDialog.offer(file),
        dropLabel: "放開以使用這張圖片",
        ownZone: importDialog.dropZone,
      };
    const reviewed = approvals.reviewedItem;
    if (
      reviewed &&
      isImportItem(reviewed) &&
      awaitingDecision(reviewed) &&
      reviewed.state !== "pending"
    )
      return {
        offer: (file) => {
          if (!approvals.offerImage(file)) flashNotice("這筆匯入現在無法接收圖片。", "warning");
        },
        dropLabel: "放開以提供這張圖片",
      };
    if (canStartImport())
      return { offer: (file) => openImportDialog(file), dropLabel: "放開以匯入到專案" };
    return undefined;
  },
  notify: (message) => flashNotice(message, "warning"),
  unavailable: importUnavailableText,
});
document.body.append(intake.overlay);
const access = new AccessPanel(
  accessTrigger,
  required<HTMLElement>("#access-popover"),
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
  (message) => accessStatus.replaceChildren(document.createTextNode(message)),
);

// One 1 s tick for grant countdowns; it only redraws and never changes a grant.
setInterval(() => {
  if (connection) access.tick();
}, 1000);

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
  if (snapshot && connected && source && snapshot.instanceId === connection?.instanceId) {
    approvalMutations.observe(source, approvalItems(snapshot));
    uploads.observe(source, snapshot.imports ?? []);
  }
  const items = [
    ...(snapshot?.imports ?? []),
    ...(snapshot?.changes ?? []),
    ...(snapshot?.commands ?? []),
    ...(snapshot?.sessions ?? []),
  ];
  const { pending, ongoing } = splitApprovalItems(items);
  const need = needButton(pending.length);
  approvalCount.hidden = !connection;
  approvalCount.dataset.count = need.count;
  approvalCount.setAttribute("aria-label", need.ariaLabel);
  approvalNumber.hidden = !need.badge;
  approvalNumber.textContent = need.badge;
  announcements.approvals(pending.map((item) => item.id));
  syncActionBadge(pending.length, connected && !!connection && !needsPairing);
  const active = activeIndicator(ongoing.length);
  activeCount.hidden = active.hidden;
  activeCount.setAttribute("aria-label", active.ariaLabel);
  activeCount.title = active.ariaLabel;
  activeNumber.textContent = active.badge;
  const focusWasInApproval = approvalContainer.contains(document.activeElement);
  approvals.render(items, connected, selectedWorkspace);
  if (focusWasInApproval && !approvalContainer.contains(document.activeElement)) {
    const nextApproval =
      approvalContainer.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (nextApproval) nextApproval.focus();
    else if (!activeCount.hidden) activeCount.focus();
    else if (!accessTrigger.hidden) accessTrigger.focus();
    else if (!approvalCount.hidden) approvalCount.focus();
    else if (connection) settingsOpen.focus();
    else connectButton.focus();
  }
  // The 執行中 button hides with the last running item; keep focus in the toolbar.
  if (activeCount.hidden && document.activeElement === activeCount)
    (approvalCount.hidden ? settingsOpen : approvalCount).focus();
}

let actionBadge: string | undefined;
/** The browser toolbar badge mirrors decisions waiting here (B8 P1); it never decides. */
function syncActionBadge(pending: number, connected: boolean) {
  const text = actionBadgeText(pending, connected);
  if (text === actionBadge) return;
  actionBadge = text;
  try {
    void browser.action?.setBadgeText({ text }).catch(() => {});
    if (text) void browser.action?.setBadgeBackgroundColor({ color: "#a8233f" }).catch(() => {});
  } catch {
    /* A browser without the action badge API keeps the in-panel count only. */
  }
}

approvalCount.addEventListener("click", () => {
  // 需確認 toggles the page; from 執行中 or 最近 it switches to the 需確認 queue.
  if (approvals.isOpen && approvals.tab !== "pending") approvals.open("pending");
  else approvals.toggle("pending");
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
  if (connection === target && !needsPairing && available === false)
    setConnectionStatus(latest ? "reconnecting" : "connecting");
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
          renderImportHydration(next);
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
          setConnectionStatus("connected");
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
      setConnectionStatus("reconnecting");
      // A retained snapshot remains visible, but cannot authorize a decision.
      showPanelError(STALE_NOTICE);
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
  setConnectionStatus("invalid");
  showPanelError("", "pair");
  void browser.storage.session.remove(storageKey);
}
function showWorkbench(url: string) {
  workbenchUrl = url;
  frame.src = parseWorkbenchUrl(url);
  settingsVisible = false;
  renderView();
  pairingRow.hidden = false;
  accessTrigger.hidden = !connection;
  integrationsContainer.hidden = !connection;
  address.value = "";
  flashNotice("");
}

workbenchEmptyReload.addEventListener("click", () => {
  if (workbenchUrl) showWorkbench(workbenchUrl);
  else renderView();
});

function selectSettingsPage(page: "general" | "mcp", focusTab = false) {
  for (const tab of settingsPages) {
    const active = tab.dataset.settingsPage === page;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focusTab) tab.focus({ preventScroll: true });
  }
  for (const panel of settingsPanels) panel.hidden = panel.dataset.settingsPanel !== page;
}

function showSettings(page: "general" | "mcp" = "general", returnFocus?: HTMLElement) {
  if ((!connection || needsPairing) && page === "mcp") return;
  if (!settingsVisible) settingsReturnFocus = returnFocus ?? (frame.hidden ? address : frame);
  if (approvals.isOpen) approvals.close();
  access.close();
  settingsVisible = true;
  renderView();
  selectSettingsPage(page, true);
}

function closeSettings() {
  if (!settingsVisible) return;
  settingsVisible = false;
  renderView();
  const target = settingsReturnFocus;
  (target?.isConnected && !target.closest("[hidden]") ? target : visibleBodyFocus())?.focus();
}

settingsBack.addEventListener("click", closeSettings);
settings.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (event.target instanceof Element && event.target.closest("dialog")) return;
  event.preventDefault();
  closeSettings();
});
const settingsTabs = required<HTMLElement>("#settings [role='tablist']");
settingsTabs.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const enabled = settingsPages.filter((tab) => tab.getAttribute("aria-disabled") !== "true");
  const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? enabled[0]
      : event.key === "End"
        ? enabled.at(-1)
        : enabled[(index + (event.key === "ArrowLeft" ? -1 : 1) + enabled.length) % enabled.length];
  const page = next?.dataset.settingsPage;
  if (page === "general" || page === "mcp") showSettings(page);
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
  // Files dragged over the workbench: cover it with the trusted overlay so the drop lands here.
  if (message.type === "kairomes:file-drag") intake.hint();
  if (message.type === "kairomes:file-paste") relayWorkbenchPaste();
  if (message.type === "kairomes:workbench-status" && typeof message.available === "boolean") {
    // The iframe reports only its own data stream; approvals use the panel's stream.
    workbenchChannel.hidden = message.available;
    workbenchChannel.textContent = message.available ? "" : "工作台畫面的資料待更新";
  }
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
// The gear always opens 一般; MCP is one tab away.
settingsOpen.addEventListener("click", () => {
  if (settingsVisible) closeSettings();
  else showSettings("general", settingsOpen);
});
// 重新連線 in 一般 restarts the stream only; unconfirmed results keep their own 查詢狀態.
settingsReconnect.addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  const target = connection;
  if (target && !needsPairing) startStream(target);
});
panelRecover.addEventListener("click", async () => {
  if (panelRecover.dataset.action === "pair") {
    void disconnectPanel();
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
  flashNotice("");
  let issued: PanelConnection | undefined;
  try {
    if (address.value.includes("/#session=")) {
      showWorkbench(address.value);
      setConnectionStatus("browse");
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
    bindInstance();
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
      flashNotice("請在 Desktop 取得新連結後重新配對。");
    } else flashNotice(cause instanceof Error ? cause.message : "配對失敗。");
  } finally {
    connectButton.disabled = false;
    connectButton.removeAttribute("aria-busy");
    connectButton.textContent = idleLabel;
  }
});
disconnect.addEventListener("click", () => {
  if (!disconnectDialog.open) disconnectDialog.showModal();
});
required<HTMLButtonElement>("#disconnect-cancel").addEventListener("click", () => {
  disconnectDialog.close();
});
disconnectDialog.addEventListener("close", () => {
  if (disconnectDialog.returnValue !== "confirm" && !disconnect.closest("[hidden]"))
    disconnect.focus();
  disconnectDialog.returnValue = "";
});
required<HTMLButtonElement>("#disconnect-confirm").addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  disconnectDialog.close("confirm");
  void disconnectPanel();
});

/** Leaves the pairing: privilege-reducing only, and it never replays an unknown change. */
async function disconnectPanel() {
  generation++;
  const target = connection;
  stopStream();
  if (approvals.isOpen) approvals.close();
  access.close();
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
  uploads.bind(undefined);
  importDialog.dispose();
  intake.hide();
  latest = undefined;
  renderApprovals(undefined, false);
  frame.removeAttribute("src");
  workbenchUrl = undefined;
  settingsVisible = false;
  renderView();
  pairingRow.hidden = true;
  accessTrigger.hidden = true;
  integrationsContainer.hidden = true;
  workspaceSwitcher.hidden = true;
  brand.hidden = false;
  selectedWorkspace = null;
  workbenchChannel.hidden = true;
  workbenchChannel.textContent = "";
  renderImportHydration(undefined);
  setConnectionStatus("unpaired");
  showPanelError("");
  address.focus();
  try {
    await browser.storage.session.remove(storageKey);
  } catch {
    flashNotice("配對快取清除未完成；請重新載入 Extension。");
  }
  if (target) {
    try {
      await api(target, "disconnect", {});
      flashNotice("已解除配對並收回自主授權；個別核准的工作仍會持續。", "neutral");
    } catch {
      flashNotice("伺服器撤銷待確認；請重啟 app。個別核准的工作仍可能持續。", "warning");
    }
  }
}
required<HTMLElement>("#extension-version").textContent = browser.runtime.getManifest().version;
setConnectionStatus("unpaired");
renderView();
window.addEventListener("pagehide", () => {
  stopStream();
  if (approvals.isOpen) approvals.close();
  syncActionBadge(0, false);
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
    bindInstance();
    showWorkbench(target.workbenchUrl);
    startStream(target);
  } catch {
    if (connection && generation === attempt) invalidatePairing(connection);
    if (generation === attempt) flashNotice("無法恢復先前配對，請重新產生本機配對碼。");
  }
})();
