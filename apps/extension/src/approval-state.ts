import {
  type ApprovalSession,
  type ArtifactImportApproval,
  type CommandApproval,
  DenialReasonSchema,
  type FileChangeApproval,
} from "@kairomes/protocol";

export type ApprovalItem =
  | ApprovalSession
  | CommandApproval
  | FileChangeApproval
  | ArtifactImportApproval;

const ONGOING_STATES = ["applying", "starting", "running"];

/** 需確認 (awaiting a decision), 執行中 (approved and still working) and 最近 (finished). */
export function splitApprovalItems<T extends { state: string }>(items: T[]) {
  return {
    pending: items.filter((item) => item.state === "pending"),
    ongoing: items.filter((item) => ONGOING_STATES.includes(item.state)),
    recent: items.filter(
      (item) => item.state !== "pending" && !ONGOING_STATES.includes(item.state),
    ),
  };
}

/** The 需確認 queue: soonest deadline first, so the most urgent request is at the top. */
export function pendingQueue<T extends { state: string; expires_at: number; created_at: number }>(
  items: readonly T[],
) {
  return items
    .filter((item) => item.state === "pending")
    .sort((a, b) => a.expires_at - b.expires_at || a.created_at - b.created_at);
}

/**
 * After a decision, the request to open next in the same queue: the first one that followed
 * the decided request (or arrived since), otherwise the first one still waiting. Nothing is
 * decided for the user; this only chooses what to show.
 */
export function nextPending<T extends { id: string }>(
  order: readonly string[],
  decidedId: string,
  queue: readonly T[],
) {
  const decidedAt = order.indexOf(decidedId);
  const candidates = queue.filter((item) => item.id !== decidedId);
  return (
    candidates.find((item) => {
      const at = order.indexOf(item.id);
      return at === -1 || at > decidedAt;
    }) ?? candidates[0]
  );
}

/** `2／3`: the request's place in this review run, counting the ones already decided. */
export function queuePosition(decided: number, index: number, total: number) {
  return `${decided + index + 1}／${decided + total}`;
}

/**
 * Approve and deny stay disabled this long after a request opens (including an automatic
 * advance), so the second click of a double click cannot decide the next request.
 */
export const ARM_DELAY_MS = 700;

export function armedUntil(now = Date.now()) {
  return now + ARM_DELAY_MS;
}

/** True while a freshly opened request must not accept a decision yet. */
export function decisionArming(until: number | undefined, now = Date.now()) {
  return until !== undefined && now < until;
}

export type DenialReasonCheck =
  | { ok: true; reason: string | undefined }
  | { ok: false; message: string };

/**
 * Validates the optional reason typed with 拒絕並說明原因… using the protocol schema, so the
 * panel never sends a reason the daemon would reject. An empty field means no reason.
 */
export function checkDenialReason(text: string): DenialReasonCheck {
  if (!text.trim()) return { ok: true, reason: undefined };
  const parsed = DenialReasonSchema.safeParse(text);
  if (parsed.success) return { ok: true, reason: parsed.data };
  return {
    ok: false,
    message: [...text.trim()].length > 200 ? "原因最多 200 個字。" : "原因不能包含控制字元或換行。",
  };
}

/** A typed line break becomes a space: the reason is single-line by contract. */
export function normalizeReasonInput(text: string) {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
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
