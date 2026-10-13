import { expect, test } from "bun:test";
import type { FileChangeApproval } from "@kairomes/protocol";
import { ApprovalMutationTracker, RevertRequests } from "./approval-mutation.ts";
import { approvalDecisionBlock } from "./approval-state.ts";

const source = "http://127.0.0.1:4000:instance-one";
const request: FileChangeApproval = {
  id: "change-1",
  request_id: "request-1",
  workspace_id: "workspace-1",
  workspace_name: "合成專案",
  state: "pending",
  summary: "合成變更",
  created_at: 1,
  expires_at: 100,
  applied_at: null,
  message: null,
  fingerprint: "fingerprint-1",
  files: [],
  diff: "",
  diff_truncated: false,
  diff_available: true,
};

function unresolved() {
  const tracker = new ApprovalMutationTracker();
  tracker.bind(source);
  tracker.markUnknown(source, request);
  return tracker;
}

test("fresh pending lists and unrelated stream snapshots cannot authorize a second decision", () => {
  const tracker = unresolved();
  for (const snapshot of [
    [structuredClone(request)],
    [structuredClone(request), { ...request, id: "unrelated", request_id: "unrelated-request" }],
  ]) {
    tracker.observe(source, snapshot, 50);
    expect(tracker.hasUnknown).toBe(true);
    for (const action of ["approve", "deny"] as const)
      expect(
        approvalDecisionBlock(
          request,
          request,
          true,
          action,
          50,
          tracker.isLocked(source, request),
        ),
      ).toBe("unknown");
  }
});

test("only the tracked request's authoritative identity, state, expiry or removal settles its lock", () => {
  for (const current of [
    { ...request, fingerprint: "changed" },
    { ...request, request_id: "replacement" },
    { ...request, state: "applying" as const },
    { ...request, state: "denied" as const },
    { ...request, expires_at: 50 },
    undefined,
  ]) {
    const tracker = unresolved();
    tracker.observe(source, current ? [current] : [], 50);
    expect(tracker.hasUnknown).toBe(false);
    expect(tracker.isLocked(source, request)).toBe(false);
  }
});

test("a replacement source cannot be affected by late failures or snapshots from the old source", () => {
  const tracker = unresolved();
  const replacementSource = "http://127.0.0.1:4000:instance-two";
  tracker.bind(replacementSource);
  expect(tracker.hasUnknown).toBe(false);
  tracker.markUnknown(replacementSource, request);
  tracker.observe(source, [], 50);
  tracker.markUnknown(source, { ...request, id: "old-request" });
  expect(tracker.isLocked(replacementSource, request)).toBe(true);
  expect(tracker.isLocked(source, request)).toBe(false);
  tracker.observe(replacementSource, [{ ...request, state: "applied" }], 50);
  expect(tracker.hasUnknown).toBe(false);
  tracker.bind(undefined);
  tracker.markUnknown(replacementSource, request);
  expect(tracker.hasUnknown).toBe(false);
});

test("terminal requests without a separate request ID remain locked until their state changes", () => {
  const tracker = new ApprovalMutationTracker();
  const terminal = {
    id: "terminal-1",
    fingerprint: "shell-1",
    state: "running" as const,
    expires_at: 100,
  };
  tracker.bind(source);
  tracker.markUnknown(source, terminal);
  tracker.observe(source, [{ ...terminal }], 50);
  expect(tracker.isLocked(source, terminal)).toBe(true);
  tracker.observe(source, [{ ...terminal }], 100);
  expect(tracker.isLocked(source, terminal)).toBe(true);
  tracker.observe(source, [{ ...terminal }], 150);
  expect(tracker.isLocked(source, terminal)).toBe(true);
  tracker.observe(source, [{ ...terminal, state: "stopped" }], 50);
  expect(tracker.hasUnknown).toBe(false);
});

test("a revert keeps one request_id per record until it is confirmed", () => {
  let next = 0;
  const requests = new RevertRequests(() => `request-${++next}`);
  const first = requests.idFor(source, "change-1");
  // A lost or refused answer: the manual retry reuses the same id.
  expect(requests.idFor(source, "change-1")).toBe(first);
  expect(requests.idFor(source, "change-2")).not.toBe(first);
  requests.settle(source, "change-1");
  expect(requests.idFor(source, "change-1")).not.toBe(first);
  // Another paired instance starts empty, and settling a stale source changes nothing.
  const other = "http://127.0.0.1:4000:instance-two";
  const fresh = requests.idFor(other, "change-2");
  expect(fresh).toBe(`request-${next}`);
  requests.settle(source, "change-2");
  expect(requests.idFor(other, "change-2")).toBe(fresh);
});

test("a revert seen in a snapshot frees its record for a new 復原這批…", () => {
  let next = 0;
  const requests = new RevertRequests(() => `request-${++next}`);
  const first = requests.idFor(source, "change-1");
  const second = requests.idFor(source, "change-2");
  // The response was lost, but the stream shows the revert (later denied or expired).
  const revert = { ...request, id: "revert-1", request_id: first, reverts_change_id: "change-1" };
  // Another instance's snapshot changes nothing.
  requests.observe("http://127.0.0.1:4000:instance-two", [revert]);
  expect(requests.idFor(source, "change-1")).toBe(first);
  requests.observe(source, [request, revert]);
  expect(requests.idFor(source, "change-1")).not.toBe(first);
  expect(requests.idFor(source, "change-2")).toBe(second);
});
