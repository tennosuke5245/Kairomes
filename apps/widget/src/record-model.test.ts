import { expect, test } from "bun:test";
import type { Command, FileChange, TerminalSession } from "@kairomes/protocol";
import { summarizeChanges } from "./change-summary.ts";
import { changeReason, commandRecord, terminalRecord } from "./record-model.ts";

const now = new Date(2026, 9, 6, 15, 30).getTime();
const one = "10000000-0000-4000-8000-000000000001";
const two = "10000000-0000-4000-8000-000000000002";
const command: Command = {
  id: "20000000-0000-4000-8000-000000000001",
  request_id: "20000000-0000-4000-8000-000000000002",
  workspace_id: one,
  cwd: "",
  argv: ["bun", "test"],
  timeout_ms: 120_000,
  state: "failed",
  created_at: now - 60_000,
  started_at: now - 50_000,
  ended_at: now - 45_800,
  expires_at: now + 60_000,
  exit_code: 1,
  signal: null,
  message: "1 個測試未通過",
};
const change: FileChange = {
  id: "30000000-0000-4000-8000-000000000001",
  request_id: "30000000-0000-4000-8000-000000000002",
  workspace_id: one,
  summary: "調整歡迎訊息",
  state: "pending",
  created_at: now - 30_000,
  applied_at: null,
  expires_at: now + 252_000,
  message: null,
  files: [
    { operation: "edit", path: "src/main.ts", before_version: "a".repeat(64), after_version: null },
    { operation: "write", path: "src/new.ts", before_version: null, after_version: null },
  ],
};
const session: TerminalSession = {
  id: "40000000-0000-4000-8000-000000000001",
  workspace_id: two,
  cwd: "",
  shell: "powershell",
  mode: "host-pty",
  state: "running",
  created_at: now - 3 * 60_000,
  expires_at: now + 15 * 60_000,
  cols: 100,
  rows: 28,
  exit_code: null,
};
const names = (id: string) => ({ [one]: "Kairomes", [two]: "docs-site" })[id];

test("records show a title, one meta line and a pill, never an 8-character id", () => {
  const row = commandRecord(command, { now, workspaceName: names });
  expect([row.verb, row.code, row.state.label, row.time]).toEqual([
    "執行",
    "bun test",
    "失敗",
    "40 秒前",
  ]);
  expect(row.meta?.text).toBe("4.2 秒");
  expect(row.reason).toBe("結束碼 1 · 1 個測試未通過");
  expect(row.workspace?.name).toBe("Kairomes");
  const terminal = terminalRecord(session, { now });
  expect([terminal.code, terminal.state.label, terminal.time, terminal.workspace]).toEqual([
    "powershell",
    "可接收輸入",
    "3 分鐘前",
    undefined,
  ]);
  for (const record of [row, terminal])
    expect(
      [record.verb, record.code, record.title, record.time, record.meta?.text, record.reason].join(
        " ",
      ),
    ).not.toContain(record.id.slice(0, 8));
});

test("pending and running commands show a countdown or an elapsed timer", () => {
  expect(
    commandRecord(
      { ...command, state: "pending", started_at: null, ended_at: null, exit_code: null },
      { now },
    ).meta,
  ).toEqual({
    kind: "countdown",
    text: "剩 1:00",
    urgency: undefined,
  });
  expect(
    commandRecord({ ...command, state: "running", ended_at: null, exit_code: null }, { now }).meta
      ?.text,
  ).toBe("已執行 0:50");
  expect(
    commandRecord({ ...command, state: "timed_out", exit_code: null, message: null }, { now })
      .reason,
  ).toBe("超過 120 秒，已停止");
  expect(changeReason({ ...change, state: "conflict" })).toBe("檔案已被修改，沒有寫入");
  expect(changeReason({ ...change, state: "failed", message: "磁碟已滿" })).toBe("磁碟已滿");
  expect(changeReason({ ...change, state: "applied", message: "不顯示" })).toBeUndefined();
});

test("the change summary has one row per path with the latest state and a change count", () => {
  const applied: FileChange = {
    ...change,
    id: "30000000-0000-4000-8000-000000000003",
    state: "applied",
    created_at: now - 90_000,
    applied_at: now - 80_000,
    files: [{ operation: "edit", path: "src/main.ts", before_version: null, after_version: null }],
  };
  const other: FileChange = {
    ...applied,
    id: "30000000-0000-4000-8000-000000000004",
    workspace_id: two,
    files: [
      { operation: "delete", path: "src/main.ts", before_version: null, after_version: null },
    ],
  };
  const rows = summarizeChanges([applied, change, other]);
  expect(
    rows.map((row) => [
      row.path,
      row.workspaceId === one,
      row.state.label,
      row.operation,
      row.changes,
    ]),
  ).toEqual([
    ["src/main.ts", true, "需確認", "修改", 2],
    ["src/new.ts", true, "需確認", "新檔案", 1],
    ["src/main.ts", false, "已套用", "刪除", 1],
  ]);
  expect(rows[0]?.changeId).toBe(change.id);
  expect(rows[0]?.pending).toBe(true);
  expect(rows[0]?.name).toBe("main.ts");
  expect(summarizeChanges([applied, change, other], two).length).toBe(1);
  expect(summarizeChanges(undefined)).toEqual([]);
});

test("a newer pending change is never hidden behind an older change applied later", () => {
  const appliedLate: FileChange = {
    ...change,
    id: "30000000-0000-4000-8000-000000000005",
    state: "applied",
    created_at: 1000,
    applied_at: 10_000,
    files: [{ operation: "edit", path: "src/main.ts", before_version: null, after_version: null }],
  };
  const waiting: FileChange = {
    ...appliedLate,
    id: change.id,
    state: "pending",
    created_at: 5000,
    applied_at: null,
  };
  for (const order of [
    [appliedLate, waiting],
    [waiting, appliedLate],
  ]) {
    const [row] = summarizeChanges(order);
    expect(row).toMatchObject({ changeId: waiting.id, pending: true, changes: 2, updatedAt: 5000 });
    expect(row?.state.label).toBe("需確認");
  }
  // An older pending change still wins over a newer one that finished.
  const newer: FileChange = { ...appliedLate, created_at: 9000, applied_at: 9500 };
  expect(summarizeChanges([newer, waiting])[0]?.changeId).toBe(waiting.id);
  // Without a pending change, the most recently created one decides the row.
  const failed: FileChange = { ...waiting, state: "failed" };
  expect(summarizeChanges([appliedLate, failed])[0]).toMatchObject({
    changeId: failed.id,
    pending: false,
  });
});
