import type {
  CompanionAttention,
  CompanionGrantSummary,
  CompanionStatus,
  CompanionTunnelStatus,
  TunnelReason,
} from "../../../packages/protocol/src/companion.ts";
import type { Workspace } from "../../../packages/protocol/src/index.ts";

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

export type DesktopAttention = {
  /** Pending approvals; null when the workbench could not be read. */
  pending: number | null;
  pendingByWorkspace: { workspaceId: string; workspaceName: string | null; count: number }[];
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
export function deriveAttention(snapshot: DesktopSnapshot, now = Date.now()): DesktopAttention {
  const companion = snapshot.companion;
  if (!companion)
    return {
      pending: null,
      pendingByWorkspace: [],
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
  return {
    pending: attention.pending?.total ?? null,
    pendingByWorkspace: (attention.pending?.byWorkspace ?? []).map((entry) => ({
      workspaceId: entry.workspace_id,
      workspaceName: names.get(entry.workspace_id) ?? null,
      count: entry.count,
    })),
    grants,
    lastMcpRequestAt: attention.lastMcpRequestAt,
    lastMcpAgoMs: ago === null ? null : Math.max(0, -ago),
    pairedPanels: attention.pairedPanels,
  };
}

export type VersionMismatch = {
  desktop: string;
  /** Null when the Companion did not answer. */
  companion: string | null;
  /** Null when the attached workbench did not report a version. */
  workbench: string | null;
};

/** Versions to show when Desktop, the Companion and the workbench disagree; otherwise null. */
export function versionMismatchDetail(snapshot: DesktopSnapshot): VersionMismatch | null {
  if (!snapshot.versionMismatch) return null;
  return {
    desktop: snapshot.version,
    companion: snapshot.companion?.version ?? null,
    workbench: snapshot.companion?.workbenchVersion ?? null,
  };
}

export type PrimaryAction =
  | "configure_key"
  | "start_tunnel"
  | "restart_runtime"
  | "open_connectors"
  | "open_workbench"
  | "show_tunnel_help"
  | "add_workspace"
  | "none";

type DesktopView = {
  tone: "ready" | "focus" | "waiting" | "error";
  title: string;
  description: string;
  action: PrimaryAction;
  actionLabel: string;
  localState: "done" | "current" | "pending" | "error";
  tunnelState: "done" | "current" | "pending" | "error";
  chatgptState: "done" | "current" | "pending" | "error";
};

export function deriveDesktopView(snapshot: DesktopSnapshot): DesktopView {
  if (snapshot.runtime.state === "error") {
    return {
      tone: "error",
      title: "本機服務未啟動",
      description: snapshot.runtime.message || "重新啟動本機服務，Kairomes 會保留你的設定。",
      action: "restart_runtime",
      actionLabel: "重新啟動",
      localState: "error",
      tunnelState: "pending",
      chatgptState: "pending",
    };
  }

  if (!snapshot.credentialConfigured) {
    return {
      tone: "focus",
      title: "連上 ChatGPT",
      description: "設定 Runtime API Key；金鑰會由作業系統保管。",
      action: "configure_key",
      actionLabel: "設定安全連線",
      localState: snapshot.companion ? "done" : "current",
      tunnelState: "current",
      chatgptState: "pending",
    };
  }

  if (!snapshot.companion || snapshot.runtime.state === "starting") {
    return {
      tone: "waiting",
      title: "正在啟動本機服務",
      description: "通常只需要幾秒。",
      action: "none",
      actionLabel: "正在啟動",
      localState: "current",
      tunnelState: "pending",
      chatgptState: "pending",
    };
  }

  if (!["running", "external"].includes(snapshot.companion.workbench.state)) {
    return {
      tone: "error",
      title: "工作台暫時無法使用",
      description: snapshot.companion.workbench.message,
      action: "restart_runtime",
      actionLabel: "重新啟動",
      localState: "error",
      tunnelState: "pending",
      chatgptState: "pending",
    };
  }

  if (snapshot.companion.workspaces?.length === 0) {
    return {
      tone: "focus",
      title: "加入第一個專案",
      description: "選擇本機資料夾；檔案不會被搬移或上傳。",
      action: "add_workspace",
      actionLabel: "選擇專案資料夾",
      localState: "current",
      tunnelState: "pending",
      chatgptState: "pending",
    };
  }

  if (snapshot.companion.tunnel.state === "missing" || !snapshot.tunnelClientInstalled) {
    return {
      tone: "error",
      title: "找不到 ChatGPT Tunnel",
      description: "Kairomes 已經在本機準備好，但還需要官方 tunnel-client 才能交給 ChatGPT 使用。",
      action: "show_tunnel_help",
      actionLabel: "查看安裝說明",
      localState: "done",
      tunnelState: "error",
      chatgptState: "pending",
    };
  }

  if (["error", "stopped"].includes(snapshot.companion.tunnel.state)) {
    return {
      tone: snapshot.companion.tunnel.state === "error" ? "error" : "focus",
      title: snapshot.companion.tunnel.state === "error" ? "Tunnel 連線失敗" : "安全連線已暫停",
      description: snapshot.companion.tunnel.message,
      action: "start_tunnel",
      actionLabel: "啟動安全連線",
      localState: "done",
      tunnelState: snapshot.companion.tunnel.state === "error" ? "error" : "current",
      chatgptState: "pending",
    };
  }

  if (snapshot.companion.tunnel.state === "starting") {
    return {
      tone: "waiting",
      title: "正在連線 ChatGPT",
      description: "完成後會自動更新。",
      action: "none",
      actionLabel: "正在連線",
      localState: "done",
      tunnelState: "current",
      chatgptState: "pending",
    };
  }

  if (snapshot.companion.connector.state !== "connected") {
    return {
      tone: "waiting",
      title: "重新整理 Kairomes Connector",
      description: "到 ChatGPT 設定中重新整理，讓新工具出現。",
      action: "open_connectors",
      actionLabel: "開啟 ChatGPT 設定",
      localState: "done",
      tunnelState: "done",
      chatgptState: "current",
    };
  }

  return {
    tone: "ready",
    title: "已連上 ChatGPT",
    description: "Kairomes 會在背景守著連線；有事需要你決定時，系統匣圖示會出現紅點。",
    action: "open_workbench",
    actionLabel: "開啟工作台",
    localState: "done",
    tunnelState: "done",
    chatgptState: "done",
  };
}
