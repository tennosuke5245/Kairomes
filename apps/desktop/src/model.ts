import type {
  CompanionAttention,
  CompanionGrantSummary,
  CompanionPendingKind,
  CompanionStatus,
  CompanionTunnelStatus,
  TunnelReason,
} from "../../../packages/protocol/src/companion.ts";
import type { Workspace } from "../../../packages/protocol/src/index.ts";
import { secondsUntil } from "./format.ts";

export type {
  DiagnosticCheck,
  DiagnosticCheckId,
  DiagnosticCode,
  DiagnosticFix,
  DiagnosticState,
  DiagnosticsReport,
} from "../../../packages/protocol/src/diagnostics.ts";
export type {
  CompanionAttention,
  CompanionGrantSummary,
  CompanionPendingKind,
  CompanionStatus,
  CompanionTunnelStatus,
  TunnelReason,
};

type ProcessState = "starting" | "running" | "error" | "stopped";

export type WorkspaceSummary = Workspace;

/** Desktop-only absolute project root. Never send it to the widget, the Extension or the model. */
export type WorkspacePath = { id: string; root: string };

export type DesktopSnapshot = {
  /** Version of the Desktop app itself. */
  version: string;
  /** Increases with every status collection in one Desktop process; larger is newer. */
  sequence: number;
  credentialConfigured: boolean;
  tunnelClientInstalled: boolean;
  runtime: {
    state: ProcessState;
    owned: boolean;
    message: string;
  };
  companion: CompanionStatus | null;
  /** The Companion differs from Desktop, or its workbench differs from the Companion. */
  versionMismatch: boolean;
};

type WireTunnel = Omit<
  CompanionTunnelStatus,
  "startedAt" | "reason" | "restartCount" | "nextRetryAt" | "logs"
> &
  Partial<
    Pick<CompanionTunnelStatus, "startedAt" | "reason" | "restartCount" | "nextRetryAt" | "logs">
  >;

type WireCompanion = Omit<
  CompanionStatus,
  "workbenchVersion" | "versionMismatch" | "tunnel" | "attention"
> & {
  workbenchVersion?: string | null;
  versionMismatch?: boolean;
  tunnel: WireTunnel;
  attention?: Partial<CompanionAttention>;
};

/** A snapshot as it may arrive from an older Companion or a synthetic fixture. */
export type WireDesktopSnapshot = Omit<
  DesktopSnapshot,
  "version" | "sequence" | "versionMismatch" | "companion"
> & {
  version?: string;
  sequence?: number;
  versionMismatch?: boolean;
  companion: WireCompanion | null;
};

const UNKNOWN_ATTENTION: CompanionAttention = {
  pending: null,
  grants: null,
  grantsKnown: false,
  lastMcpRequestAt: null,
  pairedPanels: null,
};

/**
 * Fills fields an older Companion does not send yet, so the UI can read every field of
 * DesktopSnapshot without guarding. Unknown values stay null, never optimistic.
 */
export function normalizeDesktopSnapshot(snapshot: WireDesktopSnapshot): DesktopSnapshot {
  const companion = snapshot.companion;
  const sequence = snapshot.sequence;
  return {
    ...snapshot,
    version: typeof snapshot.version === "string" ? snapshot.version : "",
    sequence: typeof sequence === "number" && Number.isSafeInteger(sequence) ? sequence : 0,
    versionMismatch: snapshot.versionMismatch === true,
    companion: companion
      ? {
          ...companion,
          workbenchVersion: companion.workbenchVersion ?? null,
          versionMismatch: companion.versionMismatch === true,
          tunnel: {
            ...companion.tunnel,
            logs: companion.tunnel.logs ?? [],
            startedAt: companion.tunnel.startedAt ?? null,
            reason: companion.tunnel.reason ?? null,
            restartCount: companion.tunnel.restartCount ?? 0,
            nextRetryAt: companion.tunnel.nextRetryAt ?? null,
          },
          attention: {
            ...UNKNOWN_ATTENTION,
            ...companion.attention,
            grantsKnown: companion.attention?.grantsKnown === true,
          },
        }
      : null,
  };
}

/** Keeps the newer of two snapshots, so a late response never overwrites a pushed update. */
export function newerSnapshot(current: DesktopSnapshot, next: DesktopSnapshot): DesktopSnapshot {
  return next.sequence >= current.sequence ? next : current;
}

/** Milliseconds from now until an ISO time (negative once passed); null when absent or invalid. */
export function msUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (typeof iso !== "string") return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time - now : null;
}

/** A grant with less time left than this is shown as expiring soon. */
export const GRANT_EXPIRING_SOON_MS = 15 * 60_000;

export type AttentionGrant = {
  workspaceId: string;
  /** Null when the workspace is no longer mounted. */
  workspaceName: string | null;
  level: CompanionGrantSummary["level"];
  /** ISO 8601 expiry; null for a grant kept until the user revokes it. */
  expiresAt: string | null;
  /** Null for a grant kept until revoked. */
  remainingMs: number | null;
  expiringSoon: boolean;
};

export type PendingGroup = {
  /** Null when an older Companion reports counts per workspace only. */
  kind: CompanionPendingKind | null;
  workspaceId: string;
  /** Null when the workspace is no longer mounted. */
  workspaceName: string | null;
  count: number;
};

export type DesktopAttention = {
  /** Pending approvals; null when the workbench could not be read. */
  pending: number | null;
  pendingByWorkspace: { workspaceId: string; workspaceName: string | null; count: number }[];
  /** Pending counts per kind and workspace (per workspace only from an older Companion). */
  pendingGroups: PendingGroup[];
  /** Time left on the request that expires first; null when unknown or none. */
  pendingRemainingMs: number | null;
  /** Active autonomy grants, soonest expiry first; null means 權限待確認. */
  grants: AttentionGrant[] | null;
  lastMcpRequestAt: string | null;
  /** Milliseconds since the last MCP request; null when none was seen. */
  lastMcpAgoMs: number | null;
  /** Valid side-panel pairings; null when unknown. */
  pairedPanels: number | null;
};

/**
 * Dashboard facts from the Companion's counts and grant metadata. Nothing here carries
 * fingerprints, argv, cwd or diffs, and Desktop cannot change a grant.
 */
export function deriveAttention(
  snapshot: DesktopSnapshot | null,
  now = Date.now(),
): DesktopAttention {
  const companion = snapshot?.companion;
  if (!companion)
    return {
      pending: null,
      pendingByWorkspace: [],
      pendingGroups: [],
      pendingRemainingMs: null,
      grants: null,
      lastMcpRequestAt: null,
      lastMcpAgoMs: null,
      pairedPanels: null,
    };
  const names = new Map(companion.workspaces.map((workspace) => [workspace.id, workspace.name]));
  const attention = companion.attention;
  const grants = attention.grantsKnown
    ? (attention.grants ?? [])
        .map((grant): AttentionGrant => {
          const remainingMs = msUntil(grant.expires_at, now);
          return {
            workspaceId: grant.workspace_id,
            workspaceName: names.get(grant.workspace_id) ?? null,
            level: grant.level,
            expiresAt: grant.expires_at,
            remainingMs,
            expiringSoon: remainingMs !== null && remainingMs <= GRANT_EXPIRING_SOON_MS,
          };
        })
        .filter((grant) => grant.expiresAt === null || (grant.remainingMs ?? 0) > 0)
        .sort(
          (a, b) =>
            (a.remainingMs ?? Number.POSITIVE_INFINITY) -
              (b.remainingMs ?? Number.POSITIVE_INFINITY) ||
            a.workspaceId.localeCompare(b.workspaceId),
        )
    : null;
  const ago = msUntil(attention.lastMcpRequestAt, now);
  const pending = attention.pending;
  const pendingByWorkspace = (pending?.byWorkspace ?? []).map((entry) => ({
    workspaceId: entry.workspace_id,
    workspaceName: names.get(entry.workspace_id) ?? null,
    count: entry.count,
  }));
  const pendingGroups: PendingGroup[] = Array.isArray(pending?.byKind)
    ? pending.byKind.map((entry) => ({
        kind: entry.kind,
        workspaceId: entry.workspace_id,
        workspaceName: names.get(entry.workspace_id) ?? null,
        count: entry.count,
      }))
    : pendingByWorkspace.map((entry) => ({ ...entry, kind: null }));
  return {
    pending: pending?.total ?? null,
    pendingByWorkspace,
    pendingGroups,
    pendingRemainingMs: pending?.total ? msUntil(pending.earliestExpiresAt, now) : null,
    grants,
    lastMcpRequestAt: attention.lastMcpRequestAt,
    lastMcpAgoMs: ago === null ? null : Math.max(0, -ago),
    pairedPanels: attention.pairedPanels,
  };
}

export type VersionIssue = {
  /** The side that differs from Desktop; the local service is named first when both do. */
  side: "companion" | "workbench";
  /** Its version; null when it did not report one. */
  version: string | null;
  /** The one fix, as the Companion's diagnostics suggest it. */
  action: "restart_runtime" | "retry_workbench";
};

/**
 * Which part runs another version than Desktop, and its one fix: a different local service is
 * restarted; a workbench another program started is taken over (重試工作台); one the service
 * started restarts with it. Null while the versions agree.
 */
export function versionIssue(snapshot: DesktopSnapshot): VersionIssue | null {
  const companion = snapshot.companion;
  if (!companion) return null;
  const companionDiffers = snapshot.versionMismatch && companion.version !== snapshot.version;
  if (!companionDiffers && companion.versionMismatch)
    return {
      side: "workbench",
      version: companion.workbenchVersion,
      action: companion.workbench.state === "external" ? "retry_workbench" : "restart_runtime",
    };
  if (!snapshot.versionMismatch) return null;
  return { side: "companion", version: companion.version || null, action: "restart_runtime" };
}

/** The single fix each failure offers. Labels live in ACTION_LABELS; nothing else acts. */
export type ViewAction =
  | "configure_key"
  | "show_profile_setup"
  | "restart_tunnel"
  | "start_tunnel"
  | "stop_tunnel"
  | "retry_workbench"
  | "restart_runtime"
  | "open_tunnel_releases"
  | "open_connectors"
  | "open_workbench"
  | "none";

export const ACTION_LABELS: Record<Exclude<ViewAction, "none">, string> = {
  configure_key: "更新金鑰",
  show_profile_setup: "建立 Tunnel profile",
  restart_tunnel: "重新啟動安全通道",
  start_tunnel: "啟動安全通道",
  stop_tunnel: "停止安全通道",
  retry_workbench: "重試工作台",
  restart_runtime: "重新啟動本機服務…",
  open_tunnel_releases: "下載 tunnel-client",
  open_connectors: "開啟 ChatGPT 設定",
  open_workbench: "開啟工作台",
};

/**
 * One recovery per Tunnel failure class (A2), as the Companion's diagnostics suggest (tunnelFix).
 * A rejected key never restarts the same failing Tunnel (X8). A workbench failure restarts the
 * local service through its confirmation: the workbench may still be running, and replacing it
 * ends its commands, terminals, grants, pairings and pending requests.
 */
export function tunnelReasonAction(reason: TunnelReason | null): Exclude<ViewAction, "none"> {
  switch (reason) {
    case "auth":
      return "configure_key";
    case "profile_missing":
      return "show_profile_setup";
    case "not_installed":
      return "open_tunnel_releases";
    case "workbench":
      return "restart_runtime";
    default:
      return "restart_tunnel";
  }
}

export type SetupStepId = "workspace" | "tunnel_client" | "profile" | "key" | "panel" | "verify";
export type SetupStep = {
  id: SetupStepId;
  title: string;
  state: "done" | "current" | "todo";
  /** Done: the result. Todo: what the step needs. Current: null (the description says it). */
  meta: string | null;
};
export type SetupProgress = {
  steps: SetupStep[];
  done: number;
  remaining: number;
  current: SetupStepId | null;
  /** The Tunnel ran and could not find the profile, so the profile step asks for a restart. */
  profileMissing: boolean;
};

export const PROFILE_NAME = "kairomes";
/** The Tunnel's profile as a row fact, in the words of the first-run checklist. */
export const PROFILE_FACT = `使用 ${PROFILE_NAME} profile`;

/**
 * True once the Tunnel has run with the profile: it is running, ChatGPT has called, or it got
 * far enough to fail for another reason. Desktop remembers this, so the step stays done.
 */
export function profileEvidence(snapshot: DesktopSnapshot): boolean {
  const companion = snapshot.companion;
  const tunnel = companion?.tunnel;
  return (
    tunnel?.state === "running" ||
    companion?.connector.state === "connected" ||
    (tunnel?.state === "error" &&
      (tunnel.reason === "auth" || tunnel.reason === "network" || tunnel.reason === "workbench"))
  );
}

/**
 * The six first-run steps (A5). Each step is done only on evidence from the snapshot; the
 * Tunnel profile cannot be read before the Tunnel runs, so `profileAcknowledged` (the user said
 * they created it) also counts until the Tunnel reports the profile missing.
 */
export function deriveSetupSteps(
  snapshot: DesktopSnapshot,
  options: { profileAcknowledged?: boolean } = {},
): SetupProgress {
  const companion = snapshot.companion;
  const tunnel = companion?.tunnel;
  const reason = tunnel && ["error", "missing"].includes(tunnel.state) ? tunnel.reason : null;
  const workspaces = companion?.workspaces ?? [];
  const clientFound =
    snapshot.tunnelClientInstalled && tunnel?.state !== "missing" && reason !== "not_installed";
  const profileMissing = reason === "profile_missing";
  const profileSeen = profileEvidence(snapshot);
  const panelConnected = (companion?.attention.pairedPanels ?? 0) > 0;
  const facts: [SetupStepId, string, boolean, string, string][] = [
    [
      "workspace",
      "加入專案",
      workspaces.length > 0,
      workspaces.length === 1
        ? `已加入 ${workspaces[0]?.name ?? ""}`
        : `已加入 ${workspaces.length} 個專案`,
      "選擇 ChatGPT 可以讀取的資料夾",
    ],
    ["tunnel_client", "安裝 tunnel-client", clientFound, "已找到", "OpenAI 官方安全通道程式"],
    [
      "profile",
      "建立 Tunnel profile",
      !profileMissing && (profileSeen || options.profileAcknowledged === true),
      PROFILE_NAME,
      `名稱為 ${PROFILE_NAME}`,
    ],
    [
      "key",
      "設定 Runtime API Key",
      snapshot.credentialConfigured && reason !== "auth",
      "已由作業系統保管",
      "安全通道用它連上 ChatGPT",
    ],
    [
      "panel",
      "配對側欄",
      companion?.extension.configured === true,
      panelConnected ? "側欄已連線" : "已設定",
      "在 Chrome 或 Edge 側欄開啟配對連結",
    ],
    [
      "verify",
      "在 ChatGPT 驗證",
      companion?.connector.state === "connected",
      "已收到 ChatGPT 呼叫",
      "請 ChatGPT 列出你的專案",
    ],
  ];
  let current: SetupStepId | null = null;
  const steps = facts.map(([id, title, done, doneMeta, hint]): SetupStep => {
    if (done) return { id, title, state: "done", meta: doneMeta };
    if (current) return { id, title, state: "todo", meta: hint };
    current = id;
    return { id, title, state: "current", meta: null };
  });
  const done = steps.filter((step) => step.state === "done").length;
  return { steps, done, remaining: steps.length - done, current, profileMissing };
}

/** Whether the first-run checklist still owns 總覽: an essential step is open, or nothing links ChatGPT yet. */
function setupIncomplete(progress: SetupProgress) {
  const open = new Set(
    progress.steps.filter((step) => step.state !== "done").map((step) => step.id),
  );
  return (
    open.has("workspace") ||
    open.has("tunnel_client") ||
    open.has("profile") ||
    open.has("key") ||
    (open.has("panel") && open.has("verify"))
  );
}

/** `data-tone` of the status line and the sidebar chip (spec §3.3). */
export type DesktopTone = "neutral" | "brand" | "running" | "danger" | "success";
export type DesktopStatusIcon =
  | "ListChecks"
  | "Hand"
  | "PauseCircle"
  | "CircleNotch"
  | "WarningCircle"
  | "CheckCircle";
export type DesktopHop = "local" | "tunnel";

export type DesktopView = {
  state: "setup" | "attention" | "paused" | "running" | "error" | "ready";
  tone: DesktopTone;
  icon: DesktopStatusIcon;
  /** Sidebar footer chip: the only place the connection is stated. */
  chip: string;
  /** One status sentence. */
  title: string;
  /** One supporting fact; the ready line builds its own from uptime and the last check. */
  meta: string;
  action: ViewAction;
  /** Error lines only: the hop the pathway marks as failing. */
  failingHop: DesktopHop | null;
  /** True while ChatGPT cannot reach Kairomes, so project cards must not look healthy. */
  chatgptUnavailable: boolean;
  /** Present while the first-run checklist owns 總覽. */
  setup: SetupProgress | null;
};

type ViewParts = Omit<DesktopView, "chatgptUnavailable" | "setup" | "failingHop"> & {
  failingHop?: DesktopHop;
};

function view(parts: ViewParts, setup: SetupProgress | null = null): DesktopView {
  return {
    ...parts,
    failingHop: parts.failingHop ?? null,
    chatgptUnavailable: !["attention", "ready"].includes(parts.state),
    setup,
  };
}

const UNAVAILABLE = "ChatGPT 目前無法讀取你的專案。";

function failure(chip: string, title: string, meta: string, action: ViewAction, hop: DesktopHop) {
  return view({
    state: "error",
    tone: "danger",
    icon: "WarningCircle",
    chip,
    title,
    meta,
    action,
    failingHop: hop,
  });
}

function running(chip: string, title: string, meta: string) {
  return view({
    state: "running",
    tone: "running",
    icon: "CircleNotch",
    chip,
    title,
    meta,
    action: "none",
  });
}

/**
 * One status and one action for 總覽 and the sidebar chip (spec §3.3). Order: local service,
 * workbench, version, Tunnel failures, first-run steps, then the Tunnel and ChatGPT link.
 * Raw host messages (runtime stderr, Companion text) are never shown; every sentence is fixed.
 */
export function deriveDesktopView(
  snapshot: DesktopSnapshot,
  options: { now?: number; profileAcknowledged?: boolean } = {},
): DesktopView {
  const now = options.now ?? Date.now();
  const companion = snapshot.companion;
  if (snapshot.runtime.state === "error" || snapshot.runtime.state === "stopped")
    return failure("本機服務已停止", "本機服務已停止", UNAVAILABLE, "restart_runtime", "local");
  if (!companion) return running("正在啟動…", "正在啟動本機服務…", "通常只要幾秒。");
  if (companion.workbench.state === "starting")
    return running("正在啟動…", "正在啟動本機工作台…", "通常只要幾秒。");
  // The project cards already say ChatGPT cannot reach them; the meta says what happens next.
  // Nothing is lost by this retry: the workbench is stopped or not answering.
  if (!["running", "external"].includes(companion.workbench.state)) {
    const stopped = companion.workbench.state === "stopped";
    return failure(
      stopped ? "本機工作台已停止" : "本機工作台無回應",
      stopped ? "本機工作台已停止" : "本機工作台沒有回應",
      "重試後，安全通道會自動重新連線。",
      "retry_workbench",
      "local",
    );
  }

  const skew = versionIssue(snapshot);
  if (skew) {
    const side = skew.side === "companion" ? "本機服務" : "工作台";
    return view({
      state: "attention",
      tone: "brand",
      icon: "Hand",
      chip: "需要你處理",
      title: `${side}版本不同`,
      meta: `${side} ${skew.version || "版本不明"} · Desktop ${snapshot.version || "版本不明"}`,
      action: skew.action,
    });
  }

  const tunnel = companion.tunnel;
  if (tunnel.state === "error" && snapshot.credentialConfigured) {
    const retryIn = secondsUntil(tunnel.nextRetryAt, now);
    if (retryIn !== null)
      return running("正在連線…", "安全通道中斷，正在自動重新連線", `將於 ${retryIn} 秒後重試`);
    const action = tunnelReasonAction(tunnel.reason);
    if (tunnel.reason === "auth")
      return failure(
        "安全通道中斷",
        "ChatGPT 拒絕了 Runtime API Key",
        "更新金鑰後會自動重新連線。",
        action,
        "tunnel",
      );
    if (tunnel.reason === "network")
      return failure(
        "安全通道中斷",
        "安全通道連不上 ChatGPT",
        "確認網路連線後再重新啟動。",
        action,
        "tunnel",
      );
    if (tunnel.reason === "workbench")
      return failure(
        "安全通道中斷",
        "安全通道接不上本機工作台",
        "本機服務重新啟動後，安全通道會重新連線。",
        action,
        "local",
      );
    if (tunnel.reason !== "profile_missing" && tunnel.reason !== "not_installed")
      return failure(
        "安全通道中斷",
        "安全通道意外停止",
        "通常重新啟動就能連上。",
        action,
        "tunnel",
      );
  }

  // With a key saved the Tunnel starts on its own; wait for it instead of flashing the checklist.
  if (tunnel.state === "starting" && snapshot.credentialConfigured)
    return running("正在連線…", "正在啟動安全通道…", "通常幾秒內完成。");

  const setup = deriveSetupSteps(snapshot, options);
  if (setupIncomplete(setup))
    return view(
      {
        state: "setup",
        tone: "neutral",
        icon: "ListChecks",
        chip: "尚未連上 ChatGPT",
        title: `還差 ${setup.remaining} 步，就能讓 ChatGPT 讀取你的專案`,
        meta: "完成的步驟會自動打勾",
        action: "none",
      },
      setup,
    );

  if (tunnel.state === "stopped" || tunnel.state === "error" || tunnel.state === "missing")
    return view({
      state: "paused",
      tone: "neutral",
      icon: "PauseCircle",
      chip: "安全通道已暫停",
      title: "安全通道已暫停",
      meta: "啟動後，ChatGPT 就能再讀取你的專案。",
      action: "start_tunnel",
    });
  if (companion.connector.state !== "connected")
    return view({
      state: "attention",
      tone: "brand",
      icon: "Hand",
      chip: "需要你處理",
      title: "請在 ChatGPT 重新整理連接器",
      meta: "收到 ChatGPT 的呼叫後，這裡會自動更新。",
      action: "open_connectors",
    });
  return view({
    state: "ready",
    tone: "success",
    icon: "CheckCircle",
    chip: "已連上 ChatGPT",
    title: "本機服務與安全通道運作正常",
    meta: "",
    action: "open_workbench",
  });
}

export type PathwayNode = "ok" | "fail" | "off";
export type PathwayLink = "ok" | "broken" | "off";
export type PathwayStates = {
  nodes: [PathwayNode, PathwayNode, PathwayNode];
  links: [PathwayLink, PathwayLink];
};

/**
 * 本機 → 安全通道 → ChatGPT, for error lines and 疑難排解 only (never the ready line). A hop is
 * ok only on evidence from the snapshot, the failing hop is marked, and every hop after one
 * that is not ok is off. The link leaving a failing hop is broken.
 */
export function pathwayStates(
  snapshot: DesktopSnapshot,
  failingHop: DesktopHop | null,
): PathwayStates {
  const companion = snapshot.companion;
  const local: PathwayNode =
    failingHop === "local"
      ? "fail"
      : snapshot.runtime.state === "running" &&
          companion !== null &&
          ["running", "external"].includes(companion.workbench.state)
        ? "ok"
        : "off";
  const tunnel: PathwayNode =
    local !== "ok"
      ? "off"
      : failingHop === "tunnel"
        ? "fail"
        : companion?.tunnel.state === "running"
          ? "ok"
          : "off";
  const chatgpt: PathwayNode =
    tunnel === "ok" && companion?.connector.state === "connected" ? "ok" : "off";
  const link = (from: PathwayNode, to: PathwayNode): PathwayLink =>
    from === "fail" ? "broken" : from === "ok" && to !== "off" ? "ok" : "off";
  return { nodes: [local, tunnel, chatgpt], links: [link(local, tunnel), link(tunnel, chatgpt)] };
}

const MCP_LOGIN = "MCP 登入需重新進行";

/** What ends with the workbench: running work always, grants and requests when counted. */
function workbenchStops(attention: DesktopAttention) {
  const stops = ["停止執行中的命令與終端機"];
  if (attention.grants?.length) stops.push(`收回 ${attention.grants.length} 個自主授權`);
  if (attention.pending) stops.push(`取消 ${attention.pending} 件待確認的請求`);
  return stops;
}

/**
 * The consequence line of the restart confirmation (A11), built only from counts Desktop has:
 * an unknown count is left out rather than guessed. Pairings, grants and MCP logins live in the
 * runtime's memory, so a restart ends them; nothing is brought back, and the copy never says so.
 */
export function restartConsequence(snapshot: DesktopSnapshot | null, now = Date.now()): string {
  // The dialog title already says what restarts; without a status only the after-effects are known.
  if (!snapshot?.companion) return `瀏覽器側欄需重新配對，${MCP_LOGIN}。`;
  const attention = deriveAttention(snapshot, now);
  const after = attention.pairedPanels === 0 ? [MCP_LOGIN] : ["瀏覽器側欄需重新配對", MCP_LOGIN];
  const takeover = snapshot.runtime.owned ? "" : "接管由其他程式啟動的本機服務，";
  return `會${takeover}${workbenchStops(attention).join("、")}；${after.join("，")}。`;
}

/**
 * The consequence line before 更換 Extension ID: saving it restarts the workbench, which ends
 * the same in-memory state as a restart, and every side panel pairs again with the new link.
 */
export function extensionChangeConsequence(snapshot: DesktopSnapshot | null, now = Date.now()) {
  const stops = workbenchStops(deriveAttention(snapshot, now));
  return `會重新啟動本機工作台並${stops.join("、")}；瀏覽器側欄要用新的配對連結重新配對，${MCP_LOGIN}。`;
}

/** Longest project name the workspace registry accepts. */
export const PROJECT_NAME_MAX = 80;

export type ProjectNameCheck = { ok: true; name: string } | { ok: false; error: string };

function invisibleCharacter(code: number) {
  return (
    code < 32 ||
    code === 127 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Mirrors the registry's name rule (trimmed, 1–80 characters, no control or bidi characters),
 * so the rename dialog can explain a problem before asking the host. The host still decides.
 */
export function validateProjectName(raw: string): ProjectNameCheck {
  const name = raw.trim();
  if (!name) return { ok: false, error: "請輸入專案名稱。" };
  if (name.length > PROJECT_NAME_MAX)
    return { ok: false, error: `專案名稱最多 ${PROJECT_NAME_MAX} 個字元。` };
  if (Array.from(name).some((character) => invisibleCharacter(character.charCodeAt(0))))
    return { ok: false, error: "專案名稱不能包含換行或不可見字元。" };
  return { ok: true, name };
}

/** Access mode a project card shows: the strongest active grant, or 權限待確認 when unknown. */
export function workspaceAccess(
  attention: DesktopAttention,
  workspace: WorkspaceSummary,
): "read" | "step" | "files" | "full" | "unknown" {
  if (!workspace.capabilities.includes("write_request")) return "read";
  if (attention.grants === null) return "unknown";
  const levels = attention.grants
    .filter((grant) => grant.workspaceId === workspace.id)
    .map((grant) => grant.level);
  if (levels.includes("full")) return "full";
  return levels.includes("files") ? "files" : "step";
}

/** What ChatGPT may do in a project, in one short line. */
export function capabilitySummary(capabilities: WorkspaceSummary["capabilities"]) {
  return capabilities.includes("write_request") ? "讀寫・命令・終端機" : "讀取・搜尋";
}
