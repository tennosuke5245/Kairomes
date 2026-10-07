import { expect, test } from "bun:test";
import type { ArtifactImportApproval, FileChangeApproval } from "@kairomes/protocol";
import {
  ARM_DELAY_MS,
  approvalDecisionBlock,
  approvalDecisionObserved,
  approvalsInWorkspace,
  armedUntil,
  awaitingDecision,
  canStopOngoing,
  checkDenialReason,
  decisionArming,
  importReviewFollows,
  nextPending,
  normalizeReasonInput,
  pendingQueue,
  queuePosition,
  splitApprovalItems,
} from "./approval-state.ts";

test("only requests awaiting a decision enter the review queue; finished ones are recent", () => {
  const items = [
    { id: "pending", state: "pending" },
    { id: "applying", state: "applying" },
    { id: "starting", state: "starting" },
    { id: "running", state: "running" },
    { id: "exited", state: "exited" },
    { id: "stopped", state: "stopped" },
    { id: "denied", state: "denied" },
    { id: "succeeded", state: "succeeded" },
  ];
  const { pending, ongoing, recent } = splitApprovalItems(items);
  expect(pending.map((item) => item.id)).toEqual(["pending"]);
  expect(ongoing.map((item) => item.id)).toEqual(["applying", "starting", "running"]);
  expect(recent.map((item) => item.id)).toEqual(["exited", "stopped", "denied", "succeeded"]);
});

test("the queue puts the soonest deadline first and ignores decided requests", () => {
  const queue = pendingQueue([
    { id: "late", state: "pending", expires_at: 300, created_at: 1 },
    { id: "done", state: "denied", expires_at: 10, created_at: 1 },
    { id: "soon", state: "pending", expires_at: 100, created_at: 5 },
    { id: "tie", state: "pending", expires_at: 100, created_at: 2 },
  ]);
  expect(queue.map((item) => item.id)).toEqual(["tie", "soon", "late"]);
});

test("auto-advance opens the request after the decided one, then wraps; never the decided one", () => {
  const order = ["a", "b", "c"];
  const queue = (...ids: string[]) => ids.map((id) => ({ id }));
  expect(nextPending(order, "a", queue("a", "b", "c"))?.id).toBe("b");
  // The decided request may still be listed until the next snapshot; it is skipped.
  expect(nextPending(order, "b", queue("a", "b", "c"))?.id).toBe("c");
  expect(nextPending(order, "c", queue("a", "c"))?.id).toBe("a");
  // A request that arrived during the decision counts as following it.
  expect(nextPending(order, "c", queue("a", "new"))?.id).toBe("new");
  expect(nextPending(order, "a", queue("a"))).toBeUndefined();
  expect(nextPending(order, "a", [])).toBeUndefined();
});

test("the position counts requests already decided in this review run", () => {
  expect(queuePosition(0, 1, 3)).toBe("2／3");
  expect(queuePosition(1, 0, 2)).toBe("2／3");
  expect(queuePosition(2, 0, 1)).toBe("3／3");
});

test("a freshly opened request refuses decisions until the arming delay has passed", () => {
  expect(ARM_DELAY_MS).toBe(700);
  const until = armedUntil(1_000);
  expect(until).toBe(1_700);
  expect(decisionArming(until, 1_000)).toBe(true);
  // The second click of a double click lands well inside the window.
  expect(decisionArming(until, 1_250)).toBe(true);
  expect(decisionArming(until, 1_699)).toBe(true);
  expect(decisionArming(until, 1_700)).toBe(false);
  expect(decisionArming(undefined, 1_000)).toBe(false);
});

test("a denial reason is optional, single-line and at most 200 characters", () => {
  expect(checkDenialReason("")).toEqual({ ok: true, reason: undefined });
  expect(checkDenialReason("   ")).toEqual({ ok: true, reason: undefined });
  expect(checkDenialReason("  請先跑單元測試 ")).toEqual({ ok: true, reason: "請先跑單元測試" });
  expect(checkDenialReason("喵".repeat(200))).toEqual({ ok: true, reason: "喵".repeat(200) });
  expect(checkDenialReason("喵".repeat(201))).toEqual({
    ok: false,
    message: "原因最多 200 個字。",
  });
  expect(checkDenialReason("a\u202eb")).toEqual({
    ok: false,
    message: "原因不能包含控制字元或換行。",
  });
  expect(checkDenialReason("a\nb").ok).toBe(false);
  expect(normalizeReasonInput("第一行\r\n第二行\n第三行\u2028")).toBe("第一行 第二行 第三行 ");
});

const review: FileChangeApproval = {
  id: "change-1",
  request_id: "request-1",
  workspace_id: "project-1",
  workspace_name: "測試專案",
  summary: "更新測試",
  state: "pending",
  created_at: 1,
  applied_at: null,
  expires_at: 100,
  message: null,
  fingerprint: "fingerprint-1",
  files: [{ operation: "write", path: "test.ts", before_version: null, after_version: "next" }],
  diff: "+export const value = 1",
  diff_truncated: false,
  diff_available: true,
};

test("the reviewed request cannot authorize changed content or a replaced identity", () => {
  expect(
    approvalDecisionBlock(review, structuredClone(review), true, "approve", 50),
  ).toBeUndefined();
  for (const current of [
    { ...review, fingerprint: "fingerprint-2" },
    { ...review, diff: "+export const value = 2" },
    { ...review, expires_at: 200 },
    { ...review, id: "change-2" },
  ])
    expect(approvalDecisionBlock(review, current, true, "approve", 50)).toBe("changed");
  const updated = { ...review, fingerprint: "fingerprint-2", diff: "+export const value = 2" };
  expect(
    approvalDecisionBlock(structuredClone(updated), updated, true, "approve", 50),
  ).toBeUndefined();
});

test("offline, expired, cancelled and completed reviews block both decisions", () => {
  for (const action of ["approve", "deny"] as const) {
    expect(approvalDecisionBlock(review, review, false, action, 50)).toBe("unavailable");
    expect(approvalDecisionBlock(review, review, true, action, 100)).toBe("expired");
    expect(approvalDecisionBlock(review, undefined, true, action, 50)).toBe("gone");
    expect(approvalDecisionBlock(review, { ...review, state: "cancelled" }, true, action, 50)).toBe(
      "gone",
    );
    expect(approvalDecisionBlock(review, { ...review, state: "applying" }, true, action, 50)).toBe(
      "gone",
    );
  }
});

test("an incomplete diff cannot be approved but can still be rejected", () => {
  const incomplete = { ...review, diff_truncated: true };
  expect(approvalDecisionBlock(incomplete, incomplete, true, "approve", 50)).toBe("incomplete");
  expect(approvalDecisionBlock(incomplete, incomplete, true, "deny", 50)).toBeUndefined();
});

test("workspace browsing filters a copy without changing grants or hiding the global queue", () => {
  const other = { ...review, id: "change-2", workspace_id: "project-2" };
  const items = [review, other];
  expect(approvalsInWorkspace(items, "project-1")).toEqual([review]);
  expect(approvalsInWorkspace(items, "missing")).toEqual([]);
  expect(approvalsInWorkspace(items, null)).toEqual(items);
  expect(items).toEqual([review, other]);
});

test("only starting or running commands and terminals offer a stop action", () => {
  expect(canStopOngoing({ state: "starting", shell: "cmd" })).toBe(true);
  expect(canStopOngoing({ state: "running", argv: ["bun", "test"] })).toBe(true);
  expect(canStopOngoing({ state: "applying" })).toBe(false);
  expect(canStopOngoing({ state: "pending", shell: "cmd" })).toBe(false);
  expect(canStopOngoing({ state: "exited", shell: "cmd" })).toBe(false);
});

test("a lost decision response is resolved by the same ID and fingerprint, never by queue removal", () => {
  expect(approvalDecisionObserved(review, { ...review, state: "applying" }, "approve")).toBe(true);
  expect(approvalDecisionObserved(review, { ...review, state: "applied" }, "approve")).toBe(true);
  expect(approvalDecisionObserved(review, { ...review, state: "denied" }, "deny")).toBe(true);
  expect(approvalDecisionObserved(review, { ...review, state: "cancelled" }, "stop")).toBe(true);
  for (const current of [
    undefined,
    review,
    { ...review, state: "expired" as const },
    { ...review, state: "applied" as const, id: "another-request" },
    { ...review, state: "applied" as const, fingerprint: "changed" },
  ])
    expect(approvalDecisionObserved(review, current, "approve")).toBe(false);
  expect(approvalDecisionObserved(review, { ...review, state: "denied" }, "approve")).toBe(false);
  expect(approvalDecisionObserved(review, { ...review, state: "applied" }, "deny")).toBe(false);
  expect(approvalDecisionObserved(review, { ...review, state: "failed" }, "stop")).toBe(false);
});

const waitingImport = {
  id: "import-1",
  request_id: "request-import-1",
  workspace_id: "project-1",
  workspace_name: "測試專案",
  path: "design/placeholders/figure-default.png",
  summary: "保存示意圖",
  source_file_id: null,
  source_file_name: null,
  claimed_mime_type: null,
  mime_type: null,
  byte_size: null,
  width: null,
  height: null,
  version: null,
  sha256_short: null,
  state: "awaiting_file",
  write_outcome: "not_written",
  created_at: 1,
  applied_at: null,
  expires_at: 100,
  error_code: null,
  message: null,
  artifact: null,
  fingerprint: "waiting",
  delivery: "user_supplied",
  origin: "tool",
  upload_id: null,
} satisfies ArtifactImportApproval;
const pendingImport: ArtifactImportApproval = {
  ...waitingImport,
  state: "pending",
  mime_type: "image/png",
  byte_size: 10,
  width: 2,
  height: 2,
  version: "a".repeat(64),
  sha256_short: "a".repeat(12),
  fingerprint: "content",
  upload_id: "upload-1",
};

test("an image import that waits for or receives its image belongs in 需確認", () => {
  const items = [
    waitingImport,
    { ...waitingImport, id: "preparing", state: "preparing" as const },
    { ...pendingImport, id: "applying", state: "applying" as const },
    { ...pendingImport, id: "applied", state: "applied" as const },
    // A non-import never counts its own odd states as waiting.
    { id: "other", state: "awaiting_file" },
  ];
  expect(items.map((item) => awaitingDecision(item))).toEqual([true, true, false, false, false]);
  const { pending, ongoing, recent } = splitApprovalItems(items);
  expect(pending.map((item) => item.id)).toEqual(["import-1", "preparing"]);
  expect(ongoing.map((item) => item.id)).toEqual(["applying"]);
  expect(recent.map((item) => item.id)).toEqual(["applied", "other"]);
  expect(pendingQueue([pendingImport, waitingImport]).map((item) => item.id)).toEqual([
    "import-1",
    "import-1",
  ]);
});

test("a waiting import can be denied but never approved; preparing has no deadline of its own", () => {
  expect(approvalDecisionBlock(waitingImport, waitingImport, true, "deny", 50)).toBeUndefined();
  expect(approvalDecisionBlock(waitingImport, waitingImport, true, "approve", 50)).toBe("waiting");
  expect(approvalDecisionBlock(waitingImport, waitingImport, true, "deny", 100)).toBe("expired");
  const preparing = { ...waitingImport, state: "preparing" as const };
  expect(approvalDecisionBlock(preparing, preparing, true, "deny", 500)).toBeUndefined();
  expect(approvalDecisionBlock(preparing, preparing, true, "approve", 500)).toBe("waiting");
});

test("a pending image needs this panel's verified preview before 匯入圖片", () => {
  expect(approvalDecisionBlock(pendingImport, pendingImport, true, "approve", 50)).toBe("preview");
  expect(
    approvalDecisionBlock(pendingImport, pendingImport, true, "approve", 50, false, true),
  ).toBeUndefined();
  expect(approvalDecisionBlock(pendingImport, pendingImport, true, "deny", 50)).toBeUndefined();
  // An unconfirmed earlier decision still locks it, preview or not.
  expect(approvalDecisionBlock(pendingImport, pendingImport, true, "approve", 50, true, true)).toBe(
    "unknown",
  );
});

test("a waiting review follows its own import as the image arrives, then locks", () => {
  expect(importReviewFollows(waitingImport, pendingImport)).toBe(true);
  expect(
    importReviewFollows(waitingImport, { ...waitingImport, error_code: "INVALID_IMAGE" }),
  ).toBe(true);
  expect(importReviewFollows(waitingImport, waitingImport)).toBe(false);
  // Another target, another request or a finished import is never followed.
  expect(importReviewFollows(waitingImport, { ...pendingImport, path: "other.png" })).toBe(false);
  expect(importReviewFollows(waitingImport, { ...pendingImport, request_id: "x" })).toBe(false);
  expect(importReviewFollows(waitingImport, { ...pendingImport, state: "applied" })).toBe(false);
  // Once pending bytes were shown, a change needs 重新審閱.
  expect(importReviewFollows(pendingImport, { ...pendingImport, version: "b".repeat(64) })).toBe(
    false,
  );
  expect(
    approvalDecisionBlock(
      pendingImport,
      { ...pendingImport, fingerprint: "new" },
      true,
      "approve",
      50,
      false,
      true,
    ),
  ).toBe("changed");
});

test("an approved import's write result settles a lost answer", () => {
  for (const state of ["applying", "applied", "conflict", "failed"] as const)
    expect(approvalDecisionObserved(pendingImport, { ...pendingImport, state }, "approve")).toBe(
      true,
    );
  expect(approvalDecisionObserved(pendingImport, pendingImport, "approve")).toBe(false);
  expect(
    approvalDecisionObserved(waitingImport, { ...waitingImport, state: "cancelled" }, "stop"),
  ).toBe(true);
  // A file change conflict is not an import: unchanged rule.
  expect(approvalDecisionObserved(review, { ...review, state: "conflict" }, "approve")).toBe(false);
});
