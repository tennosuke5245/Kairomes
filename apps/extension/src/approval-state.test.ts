import { expect, test } from "bun:test";
import type { FileChangeApproval } from "@kairomes/protocol";
import {
  approvalDecisionBlock,
  approvalDecisionObserved,
  approvalsInWorkspace,
  canStopOngoing,
  splitApprovalItems,
} from "./approval-state.ts";

test("only requests awaiting a decision enter the review queue", () => {
  const items = [
    { id: "pending", state: "pending" },
    { id: "applying", state: "applying" },
    { id: "starting", state: "starting" },
    { id: "running", state: "running" },
    { id: "exited", state: "exited" },
    { id: "stopped", state: "stopped" },
  ];
  const { pending, ongoing } = splitApprovalItems(items);
  expect(pending.map((item) => item.id)).toEqual(["pending"]);
  expect(ongoing.map((item) => item.id)).toEqual(["applying", "starting", "running"]);
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
