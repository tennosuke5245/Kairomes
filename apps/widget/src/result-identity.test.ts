import { expect, test } from "bun:test";
import type { CommandResult, FileChangeResult } from "@kairomes/protocol";
import { requireCommandResult, requireFileChangeResult } from "./result-identity.ts";

const command: CommandResult = {
  kind: "command",
  command: {
    id: "command-a",
    request_id: "request-a",
    workspace_id: "workspace-a",
    cwd: "",
    argv: ["synthetic"],
    timeout_ms: 1000,
    state: "succeeded",
    created_at: 0,
    started_at: 1,
    ended_at: 2,
    expires_at: 100,
    exit_code: 0,
    signal: null,
    message: null,
  },
  stdout: "only-a",
  stderr: "",
  stdout_cursor: 6,
  stderr_cursor: 0,
  stdout_truncated: false,
  stderr_truncated: false,
  has_more: false,
  output_complete: true,
};

const change: FileChangeResult = {
  kind: "file_change",
  change: {
    id: "change-a",
    request_id: "request-a",
    workspace_id: "workspace-a",
    summary: "合成變更 A",
    state: "applied",
    created_at: 0,
    applied_at: 2,
    expires_at: 100,
    message: null,
    files: [],
  },
  diff: "+only-a",
  diff_truncated: false,
};

test("a command page cannot contribute output or cursors to another selected operation", () => {
  expect(requireCommandResult(command, "command-a")).toBe(command);
  for (const other of [command, change, { kind: "workspaces" as const, workspaces: [] }])
    expect(() => requireCommandResult(other, "command-b")).toThrow("不符");
  expect(command.stdout).toBe("only-a");
  expect(command.stdout_cursor).toBe(6);
});

test("a diff response must match both the selected change and its workspace", () => {
  const expected = { id: "change-a", workspaceId: "workspace-a" };
  expect(requireFileChangeResult(change, expected)).toBe(change);
  for (const other of [
    { ...change, change: { ...change.change, id: "change-b" } },
    { ...change, change: { ...change.change, workspace_id: "workspace-b" } },
    command,
    { kind: "workspaces" as const, workspaces: [] },
  ])
    expect(() => requireFileChangeResult(other, expected)).toThrow("不符");
});
