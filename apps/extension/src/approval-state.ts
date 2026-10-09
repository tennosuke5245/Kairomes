import {
  type ApprovalSession,
  type ArtifactImportApproval,
  artifactImportAwaitingDecision,
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

/** An image import is told apart by its always-present source_file_id key. */
export function isImportItem<T extends object>(
  item: T,
): item is Extract<T, { source_file_id: unknown }> {
  return "source_file_id" in item;
}

/**
 * Still before a decision: `pending`, plus an image import that waits for its image
 * (awaiting_file: it needs the user) or is still receiving it (preparing). Those two can be
 * denied or cancelled but never approved; they belong in 需確認 all the same.
 */
export function awaitingDecision(item: { state: string } & object) {
  return item.state === "pending" || (isImportItem(item) && artifactImportAwaitingDecision(item));
}

/** 需確認 (awaiting a decision), 執行中 (approved and still working) and 最近 (finished). */
export function splitApprovalItems<T extends { state: string } & object>(items: T[]) {
  return {
    pending: items.filter((item) => awaitingDecision(item)),
    ongoing: items.filter((item) => ONGOING_STATES.includes(item.state)),
    recent: items.filter((item) => !awaitingDecision(item) && !ONGOING_STATES.includes(item.state)),
  };
}

/** The 需確認 queue: soonest deadline first, so the most urgent request is at the top. */
export function pendingQueue<
  T extends { state: string; expires_at: number; created_at: number } & object,
>(items: readonly T[]) {
  return items
    .filter((item) => awaitingDecision(item))
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
  // An approved import ends in a write result: written, refused at the target, or unknown.
  if ("source_file_id" in current && ["conflict", "failed"].includes(current.state)) return true;
  return ["applying", "applied", "starting", "running", "succeeded", "exited"].includes(
    current.state,
  );
}

/** A review stays attached to the exact content the user opened. */
export function approvalReviewIdentity(item: ApprovalItem) {
  return JSON.stringify(item);
}

export type ApprovalBlock =
  | "unavailable"
  | "gone"
  | "expired"
  | "changed"
  | "incomplete"
  | "unknown"
  /** An image import without verified bytes yet (awaiting_file or preparing). */
  | "waiting"
  /** A pending image whose bytes this panel has not loaded and verified yet. */
  | "preview";

/**
 * Why a decision on the reviewed copy is not allowed now, or undefined. Approve needs the
 * exact pending content (and, for an image, this panel's verified preview of it); deny also
 * accepts an image import that is still waiting for its image.
 */
export function approvalDecisionBlock(
  reviewed: ApprovalItem,
  current: ApprovalItem | undefined,
  available: boolean,
  action: "approve" | "deny",
  now = Date.now(),
  uncertain = false,
  previewReady = false,
): ApprovalBlock | undefined {
  if (!available) return "unavailable";
  if (!current || !awaitingDecision(current)) return "gone";
  // The daemon keeps no deadline for a receiving import; its 60 s is a safety net only.
  if (current.state !== "preparing" && current.expires_at <= now) return "expired";
  if (approvalReviewIdentity(reviewed) !== approvalReviewIdentity(current)) return "changed";
  if (uncertain) return "unknown";
  if (action !== "approve") return undefined;
  if (current.state !== "pending") return "waiting";
  if ("files" in current && current.diff_truncated) return "incomplete";
  if ("source_file_id" in current && !previewReady) return "preview";
  return undefined;
}

/**
 * An import under review moves on by itself while it waits for its image: awaiting_file →
 * preparing → pending (or back to awaiting_file after a refused image). The review may follow
 * the same import, same target, only while nothing reviewable was shown yet; once the review
 * holds pending bytes, any change needs 重新審閱.
 */
export function importReviewFollows(reviewed: ApprovalItem, current: ApprovalItem | undefined) {
  return (
    current !== undefined &&
    "source_file_id" in reviewed &&
    "source_file_id" in current &&
    reviewed.state !== "pending" &&
    awaitingDecision(current) &&
    current.id === reviewed.id &&
    current.request_id === reviewed.request_id &&
    current.workspace_id === reviewed.workspace_id &&
    current.path === reviewed.path &&
    approvalReviewIdentity(current) !== approvalReviewIdentity(reviewed)
  );
}

export function approvalsInWorkspace<T extends { workspace_id: string }>(
  items: T[],
  workspaceId: string | null,
) {
  return workspaceId === null ? items : items.filter((item) => item.workspace_id === workspaceId);
}
