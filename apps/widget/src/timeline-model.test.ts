import { expect, test } from "bun:test";
import type { ActivityEntry, ActivitySnapshot, Command } from "@kairomes/protocol";
import { workspaceHue as sharedWorkspaceHue } from "@kairomes/protocol/ui-state";
import { newActivityLabel, ticksEverySecond, timelineRow, workspaceHue } from "./timeline-model.ts";

const one = "10000000-0000-4000-8000-000000000001";
const now = new Date(2026, 9, 6, 15, 30).getTime();
const base: ActivityEntry = {
  id: "read",
  seq: 1,
  focusSeq: 1,
  source: "mcp",
  kind: "tool",
  tool: "file_read",
  title: "讀取檔案",
  state: "completed",
  updatedAt: now - 30_000,
  workspaceId: one,
  path: "src/main.ts",
  resultId: "result",
};
const command: Command = {
  id: "20000000-0000-4000-8000-000000000001",
  request_id: "20000000-0000-4000-8000-000000000002",
  workspace_id: one,
  cwd: "",
  argv: ["bun", "test", "--filter", "render page"],
  timeout_ms: 120_000,
  state: "running",
  created_at: now - 20_000,
  started_at: now - 14_000,
  ended_at: null,
  expires_at: now + 252_000,
  exit_code: null,
  signal: null,
  message: null,
};
const commandEntry: ActivityEntry = {
  ...base,
  id: "command",
  kind: "command",
  tool: undefined,
  path: undefined,
  resultId: undefined,
  commandId: command.id,
  title: "bun · 執行中",
  state: "running",
};
const snapshot = (commands: Command[] = [command]): ActivitySnapshot => ({
  instanceId: "fixture",
  seq: 9,
  entries: [],
  sessions: [],
  commands,
});
const named = (id: string) => (id === one ? "Kairomes" : undefined);

test("rows read as a verb plus the verbatim value, with one state from toneFor", () => {
  const read = timelineRow(base, { now, workspaceName: named });
  expect([read.verb, read.code, read.icon]).toEqual(["讀取", "src/main.ts", "file"]);
  expect(read.state.label).toBe("已完成");
  expect(read.time).toBe("30 秒前");
  expect(read.workspace).toEqual({ id: one, name: "Kairomes", hue: workspaceHue(one) });
  expect(read.actionable).toBe(true);
  // A title that already names the path shows it once, verbatim.
  const titled = timelineRow(
    { ...base, tool: "artifact_preview", title: "預覽 out/a.png", path: "out/a.png" },
    { now },
  );
  expect([titled.verb, titled.code, titled.icon]).toEqual(["預覽", "out/a.png", "image"]);
  // A custom title keeps its words; an unknown path-less tool stays plain.
  expect(
    timelineRow(
      { ...base, title: "讀取 3 個檔案", tool: "file_read_many", path: undefined },
      { now },
    ).verb,
  ).toBe("讀取 3 個檔案");
  const running = timelineRow(commandEntry, { snapshot: snapshot(), now });
  expect([running.verb, running.code, running.icon]).toEqual([
    "執行",
    'bun test --filter "render page"',
    "command",
  ]);
  expect(running.state).toMatchObject({ label: "執行中", dataTone: "running", spin: true });
  expect(running.meta).toEqual({ kind: "elapsed", text: "已執行 0:14" });
  expect(running.reason).toBeUndefined();
});

test("a filtered workspace hides the tag; entries without a workspace never get one", () => {
  expect(timelineRow(base, { now }).workspace).toBeUndefined();
  expect(
    timelineRow({ ...base, workspaceId: undefined }, { now, workspaceName: named }).workspace,
  ).toBeUndefined();
});

test("pending work counts down; finished commands show their duration", () => {
  const pending = timelineRow(
    { ...commandEntry, state: "pending" },
    { snapshot: snapshot([{ ...command, state: "pending", started_at: null }]), now },
  );
  expect(pending.state).toMatchObject({ label: "需確認", dataTone: "brand" });
  expect(pending.meta).toEqual({ kind: "countdown", text: "剩 4:12", urgency: undefined });
  const soon = timelineRow(
    { ...commandEntry, state: "pending" },
    {
      snapshot: snapshot([
        { ...command, state: "pending", started_at: null, expires_at: now + 30_000 },
      ]),
      now,
    },
  );
  expect(soon.meta?.urgency).toBe("soon");
  const done = timelineRow(
    { ...commandEntry, state: "succeeded" },
    {
      snapshot: snapshot([{ ...command, state: "succeeded", ended_at: now - 9_800, exit_code: 0 }]),
      now,
    },
  );
  expect(done.state.label).toBe("已完成");
  expect(done.meta).toEqual({ kind: "duration", text: "4.2 秒" });
  expect(done.reason).toBeUndefined();
});

test("failures carry one reason line: exit code first, then the daemon's message", () => {
  const failedCommand = { ...command, state: "failed" as const, ended_at: now, exit_code: 1 };
  const failed = timelineRow(
    { ...commandEntry, state: "failed", message: "1 個測試未通過" },
    { snapshot: snapshot([failedCommand]), now },
  );
  expect(failed.state).toMatchObject({ label: "失敗", dataTone: "danger" });
  expect(failed.reason).toBe("結束碼 1 · 1 個測試未通過");
  const timedOut = timelineRow(
    { ...commandEntry, state: "timed_out" },
    { snapshot: snapshot([{ ...command, state: "timed_out", ended_at: now }]), now },
  );
  expect(timedOut.reason).toBe("超過 120 秒，已停止");
  const conflict = timelineRow(
    { ...base, kind: "file_change", tool: undefined, state: "conflict", changeId: "c" },
    { now },
  );
  expect(conflict.reason).toBe("檔案已被修改，沒有寫入");
  const mcp = timelineRow(
    { ...base, tool: "mcp_tool_call", state: "failed", message: "  遠端工具回報錯誤  " },
    { now },
  );
  expect([mcp.icon, mcp.reason]).toEqual(["mcp", "遠端工具回報錯誤"]);
  // Unknown states are uncertain (warning) and keep their reason; denials have none.
  const uncertain = timelineRow(
    { ...base, state: "unknown" as never, message: "連線中斷" },
    { now },
  );
  expect([uncertain.state.label, uncertain.reason]).toEqual(["結果待確認", "連線中斷"]);
  const denied = timelineRow({ ...commandEntry, state: "denied", message: "不需要" }, { now });
  expect([denied.state.label, denied.reason]).toEqual(["已拒絕", undefined]);
});

test("terminal and file-change rows show the shell, session length and file count", () => {
  const terminal = timelineRow(
    {
      ...base,
      kind: "terminal",
      tool: undefined,
      sessionId: "s",
      title: "powershell · 已結束",
      state: "exited",
      updatedAt: now - 60_000,
    },
    {
      snapshot: {
        ...snapshot(),
        sessions: [
          {
            id: "s",
            workspace_id: one,
            cwd: "",
            shell: "powershell",
            mode: "host-pty",
            state: "exited",
            created_at: now - 7 * 60_000,
            expires_at: 0,
            cols: 80,
            rows: 24,
            exit_code: 0,
          },
        ],
      },
      now,
    },
  );
  expect([terminal.verb, terminal.code, terminal.state.label]).toEqual([
    "終端機",
    "powershell",
    "已結束",
  ]);
  expect(terminal.meta?.text).toBe("用了 6 分鐘");
  const change = timelineRow(
    {
      ...base,
      kind: "file_change",
      tool: undefined,
      changeId: "c",
      title: "調整設定 · 已套用",
      state: "applied",
    },
    {
      snapshot: {
        ...snapshot(),
        changes: [
          {
            id: "c",
            request_id: "r",
            workspace_id: one,
            summary: "調整設定",
            state: "applied",
            created_at: 0,
            applied_at: 1,
            expires_at: 2,
            message: null,
            files: [
              { operation: "edit", path: "a.ts", before_version: null, after_version: null },
              { operation: "write", path: "b.ts", before_version: null, after_version: null },
            ],
          },
        ],
      },
      now,
    },
  );
  expect([change.verb, change.code, change.icon, change.meta?.text]).toEqual([
    "調整設定",
    undefined,
    "change",
    "2 個檔案",
  ]);
  const unknown = timelineRow(
    {
      ...base,
      id: "x",
      resultId: undefined,
      tool: "workspace_list",
      path: undefined,
      title: "列出工作區",
    },
    { now },
  );
  expect([unknown.icon, unknown.actionable]).toEqual(["folder", false]);
});

test("workspace hue is stable, in 1–5, and spreads ids", () => {
  expect(workspaceHue(one)).toBe(workspaceHue(one));
  const hues = new Set(
    Array.from({ length: 40 }, (_, index) => workspaceHue(`${index}-workspace`)),
  );
  for (const hue of hues) expect(hue >= 1 && hue <= 5).toBe(true);
  expect(hues.size).toBe(5);
  // Same function as the side panel and Desktop, so a project keeps its colour everywhere.
  expect(workspaceHue).toBe(sharedWorkspaceHue);
});

test("a one-second tick only while a countdown or running timer is visible", () => {
  expect(ticksEverySecond([base], snapshot())).toBe(false);
  expect(ticksEverySecond([commandEntry], snapshot())).toBe(true);
  expect(ticksEverySecond([{ ...base, state: "pending" }])).toBe(true);
  expect(
    ticksEverySecond([commandEntry], snapshot([{ ...command, ended_at: now, state: "succeeded" }])),
  ).toBe(false);
  expect(newActivityLabel(3)).toBe("有 3 則新動態 · 回到最新");
});
