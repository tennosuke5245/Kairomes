import { expect, test } from "bun:test";
import type { FileChangeApproval } from "@kairomes/protocol";
import {
  ARM_DELAY_MS,
  approvalDecisionBlock,
  approvalDecisionObserved,
  approvalsInWorkspace,
  armedUntil,
  canStopOngoing,
  checkDenialReason,
  decisionArming,
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
