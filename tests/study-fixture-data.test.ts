import { expect, test } from "bun:test";
import { splitApprovalItems } from "../apps/extension/src/approval-state.ts";
import type { ApprovalSession, CommandApproval } from "../packages/protocol/src/index.ts";
import {
  studyApprovalDecision,
  studyApprovalItems,
  studyWorkspaces,
} from "./study-fixture-data.ts";

const command: CommandApproval = {
  id: "00000001-0000-4000-8000-000000000001",
  request_id: "00000001-0000-4000-8000-000000000001",
  workspace_id: studyWorkspaces[0].id,
  workspace_name: studyWorkspaces[0].name,
  cwd: "",
  absolute_cwd: "C:\\Synthetic\\project",
  executable: "C:\\Synthetic\\tool.exe",
  argv: ["synthetic-check"],
  state: "pending",
  created_at: 0,
  started_at: null,
  ended_at: null,
  expires_at: 2000,
  timeout_ms: 1000,
  exit_code: null,
  signal: null,
  message: null,
  fingerprint: "a".repeat(64),
};
const shell: ApprovalSession = {
  id: "00000002-0000-4000-8000-000000000001",
  workspace_id: studyWorkspaces[0].id,
  workspace_name: studyWorkspaces[0].name,
  cwd: "",
  absolute_cwd: "C:\\Synthetic\\project",
  command: ["synthetic-shell"],
  shell: "cmd",
  mode: "host-pty",
  state: "pending",
  created_at: 0,
  expires_at: 2000,
  cols: 80,
  rows: 24,
  exit_code: null,
  fingerprint: "b".repeat(64),
};

test("ten independent approvals are split across two consistent long project identities", () => {
  const items = studyApprovalItems([command, shell], 10, 1000);
  expect(new Set(items.map((item) => item.id)).size).toBe(10);
  expect(
    new Set(items.filter((item) => "request_id" in item).map((item) => item.request_id)).size,
  ).toBe(5);
  for (const workspace of studyWorkspaces) {
    const selected = items.filter((item) => item.workspace_id === workspace.id);
    expect(selected).toHaveLength(5);
    expect(selected.every((item) => item.workspace_name === workspace.name)).toBe(true);
  }
  expect(command.state).toBe("pending");
  expect(() => studyApprovalItems([command], 999)).toThrow();
});

test("a completed one-shot command cannot be replayed or stopped, while the finite shell remains available", () => {
  const items = studyApprovalItems([command, shell], 3, 1000);
  const once = items.find((item): item is CommandApproval => "argv" in item);
  const terminal = items.find((item): item is ApprovalSession => "shell" in item);
  if (!once || !terminal) throw new Error("Missing fixed study samples");
  studyApprovalDecision(once, "approve", 1100);
  studyApprovalDecision(terminal, "approve", 1100);
  expect(once.state).toBe("succeeded");
  expect(once.exit_code).toBe(0);
  expect(splitApprovalItems([once, terminal]).ongoing).toEqual([terminal]);
  expect(terminal.expires_at).toBe(901000);
  expect(() => studyApprovalDecision(once, "approve", 1200)).toThrow();
  expect(() => studyApprovalDecision(once, "stop", 1200)).toThrow();
  studyApprovalDecision(terminal, "stop", 1200);
  expect(terminal.state).toBe("stopped");
});

test("expired requests cannot be approved or denied in the synthetic study", () => {
  for (const action of ["approve", "deny"] as const) {
    const expired = structuredClone(command);
    expect(() => studyApprovalDecision(expired, action, expired.expires_at)).toThrow();
    expect(expired.state).toBe("pending");
  }
});
