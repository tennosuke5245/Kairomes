import { expect, test } from "bun:test";
import type { FileChange, FileChangeResult } from "@kairomes/protocol";
import { currentFileChange } from "./file-change-panel.tsx";

const pending: FileChange = {
  id: "change",
  request_id: "request",
  workspace_id: "workspace",
  summary: "合成變更",
  state: "pending",
  created_at: 0,
  applied_at: null,
  expires_at: 100,
  message: null,
  files: [
    {
      operation: "edit",
      path: "README.md",
      before_version: "a".repeat(64),
      after_version: "b".repeat(64),
    },
  ],
};
const result: FileChangeResult = {
  kind: "file_change",
  change: pending,
  diff: "+fixture",
  diff_truncated: false,
};

test("final change snapshots supersede stale polling without replacing the reviewed diff identity", () => {
  for (const state of [
    "applied",
    "cancelled",
    "conflict",
    "expired",
    "denied",
    "failed",
  ] as const) {
    const final = { ...pending, state };
    expect(currentFileChange(final, result)).toBe(final);
    expect(currentFileChange(final, result)?.state).not.toBe("pending");
  }
  expect(
    currentFileChange(pending, { ...result, change: { ...pending, state: "applying" } })?.state,
  ).toBe("applying");
  expect(currentFileChange(pending, { ...result, change: { ...pending, id: "another" } })).toBe(
    pending,
  );
  expect(currentFileChange(undefined, result)).toBeUndefined();
  expect(result.diff).toBe("+fixture");
});
