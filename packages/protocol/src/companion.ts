import type { Workspace } from "./index.ts";

/**
 * Companion control-plane shapes shared by the CLI Companion, Desktop and diagnostics.
 * Everything here is trusted-local only: the Desktop webview may read it, the model and the
 * widget never do. No field carries tokens, private URLs, fingerprints, argv, cwd or diffs.
 */

/** Why the Tunnel stopped, classified from exit codes and log lines; never raw log text. */
export const TUNNEL_REASONS = [
  "auth",
  "profile_missing",
  "network",
  "workbench",
  "not_installed",
  "unknown",
] as const;
export type TunnelReason = (typeof TUNNEL_REASONS)[number];

/** Reasons that a restart cannot fix; the Companion never auto-restarts after these. */
export const PERMANENT_TUNNEL_REASONS: readonly TunnelReason[] = [
  "auth",
  "profile_missing",
  "not_installed",
];

export type CompanionTunnelState = "missing" | "starting" | "running" | "stopped" | "error";
export type CompanionWorkbenchState = "starting" | "running" | "external" | "stopped" | "error";

export type CompanionTunnelStatus = {
  state: CompanionTunnelState;
  label: string;
  message: string;
  meta: string;
  /** Control-stripped, credential-redacted tail of the tunnel-client output. */
  logs: string[];
  /** ISO 8601 start of the running process; null unless state is running. */
  startedAt: string | null;
  /** Failure class; null unless state is error or missing. */
  reason: TunnelReason | null;
  /** Automatic restarts within the current 5-minute window (reset by an explicit start). */
  restartCount: number;
  /** ISO 8601 time of the scheduled automatic restart; null when none is scheduled. */
  nextRetryAt: string | null;
};

/** Pending approval counts only; no ids, fingerprints, argv, cwd or diffs. */
export type CompanionPendingSummary = {
  total: number;
  byWorkspace: { workspace_id: string; count: number }[];
};

/** Autonomy grant metadata only; never the grant id, owner or pairing token. */
export type CompanionGrantSummary = {
  workspace_id: string;
  level: "files" | "full";
  /** ISO 8601 expiry, or null for a grant kept until the user revokes it. */
  expires_at: string | null;
};

export type CompanionAttention = {
  /** Null when the workbench admin list could not be read. */
  pending: CompanionPendingSummary | null;
  /** Null when the workbench is external or unknown: show 權限待確認. */
  grants: CompanionGrantSummary[] | null;
  /** False when grants cannot be read in-process (external or missing workbench). */
  grantsKnown: boolean;
  /** ISO 8601 time of the last successful MCP request in this workbench instance. */
  lastMcpRequestAt: string | null;
  /** Currently valid side-panel pairings; null when the workbench did not report it. */
  pairedPanels: number | null;
};

export type CompanionStatus = {
  version: string;
  /** Version reported by the attached workbench's /healthz; null when unknown. */
  workbenchVersion: string | null;
  /** True when an attached workbench reports a different (or no) version. */
  versionMismatch: boolean;
  overall: { tone: "good" | "warn" | "busy"; label: string };
  workspaces: Workspace[];
  workbench: {
    state: CompanionWorkbenchState;
    label: string;
    message: string;
    meta: string;
  };
  tunnel: CompanionTunnelStatus;
  connector: {
    state: "connected" | "waiting" | "blocked";
    label: string;
    message: string;
    meta: string;
  };
  extension: { configured: boolean };
  attention: CompanionAttention;
};

/** Desktop-only project details. Absolute roots never reach the model, widget or Extension. */
export type WorkspaceDetail = { id: string; name: string; root: string };

const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

/** Accepts only a plain semantic version, so a foreign /healthz cannot inject text. */
export function parseVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
}
