import type {
  ApprovalSession,
  ArtifactImportApproval,
  CommandApproval,
  FileChangeApproval,
} from "@kairomes/protocol";

export type ApprovalItem =
  | ApprovalSession
  | CommandApproval
  | FileChangeApproval
  | ArtifactImportApproval;

export function splitApprovalItems<T extends { state: string }>(items: T[]) {
  return {
    pending: items.filter((item) => item.state === "pending"),
    ongoing: items.filter((item) => ["applying", "starting", "running"].includes(item.state)),
  };
}

export function canStopOngoing(item: { state: string; argv?: unknown; shell?: unknown }) {
  return (
    (item.state === "starting" || item.state === "running") && ("argv" in item || "shell" in item)
  );
}

/** A lost response is resolved only by the same reviewed request's authoritative state. */
export function approvalDecisionObserved(
  reviewed: Pick<ApprovalItem, "id" | "fingerprint">,
  current: Pick<ApprovalItem, "id" | "fingerprint" | "state"> | undefined,
  action: "approve" | "deny" | "stop",
) {
  if (!current || current.id !== reviewed.id || current.fingerprint !== reviewed.fingerprint)
    return false;
  if (action === "deny") return current.state === "denied";
  if (action === "stop") return current.state === "stopped" || current.state === "cancelled";
  return ["applying", "applied", "starting", "running", "succeeded", "exited"].includes(
    current.state,
  );
}

/** A review stays attached to the exact content the user opened. */
export function approvalReviewIdentity(item: ApprovalItem) {
  return JSON.stringify(item);
}

export function approvalDecisionBlock(
  reviewed: ApprovalItem,
  current: ApprovalItem | undefined,
  available: boolean,
  action: "approve" | "deny",
  now = Date.now(),
  uncertain = false,
): "unavailable" | "gone" | "expired" | "changed" | "incomplete" | "unknown" | undefined {
  if (!available) return "unavailable";
  if (current?.state !== "pending") return "gone";
  if (current.expires_at <= now) return "expired";
  if (approvalReviewIdentity(reviewed) !== approvalReviewIdentity(current)) return "changed";
  if (uncertain) return "unknown";
  if (action === "approve" && "files" in current && current.diff_truncated) return "incomplete";
  return undefined;
}

export function approvalsInWorkspace<T extends { workspace_id: string }>(
  items: T[],
  workspaceId: string | null,
) {
  return workspaceId === null ? items : items.filter((item) => item.workspace_id === workspaceId);
}
