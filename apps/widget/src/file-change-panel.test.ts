import { expect, test } from "bun:test";
import type { FileChange, FileChangeResult } from "@kairomes/protocol";
import { changeFacts, currentFileChange } from "./file-change-panel.tsx";

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

const now = new Date(2026, 9, 6, 15, 30).getTime();
const change: FileChange = {
  ...pending,
  files: [
    ...pending.files,
    { ...pending.files[0], path: "src/new.ts" } as FileChange["files"][number],
  ],
  expires_at: now + 252_000,
};

test("change facts: files, +A −D once loaded, then the review deadline or the applied time", () => {
  expect(changeFacts(change, undefined, now)).toEqual([
    { label: "檔案", value: "2 個" },
    { label: "審核期限", value: "剩 4:12", tone: undefined },
  ]);
  expect(changeFacts(change, { additions: 7, deletions: 1 }, change.expires_at - 30_000)).toEqual([
    { label: "檔案", value: "2 個" },
    { label: "差異", value: "+7 −1", mono: true },
    { label: "審核期限", value: "剩 0:30", tone: "warning" },
  ]);
  expect(changeFacts(change, { additions: 5003, deletions: 6, truncated: true }, now)[1]).toEqual({
    label: "差異",
    value: "至少 +5003 −6",
    mono: true,
  });
  const applied = {
    ...change,
    state: "applied" as const,
    applied_at: new Date(2026, 9, 6, 15, 12).getTime(),
  };
  expect(changeFacts(applied, undefined, now).at(-1)).toEqual({
    label: "套用時間",
    value: "下午 3:12",
  });
});
