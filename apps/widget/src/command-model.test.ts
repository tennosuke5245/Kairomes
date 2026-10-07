import { expect, test } from "bun:test";
import type { Command, CommandResult, TerminalSession } from "@kairomes/protocol";
import {
  argvParts,
  commandFacts,
  commandNeverRan,
  cwdLabel,
  formatArgv,
  notRunReason,
  outputLines,
  outputSize,
  outputView,
  tailText,
  terminalFacts,
  terminalFooter,
  workspaceCwd,
} from "./command-model.ts";

const command: Command = {
  id: "10000000-0000-4000-8000-000000000001",
  request_id: "10000000-0000-4000-8000-000000000002",
  workspace_id: "10000000-0000-4000-8000-000000000003",
  cwd: "",
  argv: ["bun", "test", "--filter", "render"],
  timeout_ms: 120_000,
  state: "failed",
  created_at: 0,
  started_at: 1_000,
  ended_at: 5_200,
  expires_at: 100_000,
  exit_code: 1,
  signal: null,
  message: null,
};
const result: CommandResult = {
  kind: "command",
  command,
  stdout: "a\nb\n",
  stderr: "",
  stdout_cursor: 4,
  stderr_cursor: 0,
  stdout_truncated: false,
  stderr_truncated: false,
  has_more: false,
  output_complete: true,
};

test("argv reads like a shell line; spaces inside one element stay visible", () => {
  expect(formatArgv(["git", "commit", "-m", "修正 bug", ""])).toBe('git commit -m "修正 bug" ""');
  expect(formatArgv(['say "hi"'])).toBe('"say \\"hi\\""');
  expect(formatArgv(["bun", "test"])).toBe("bun test");
  expect(argvParts(["bun", "test", "--filter", "a b"])).toEqual([
    "bun",
    "test",
    "--filter",
    '"a b"',
  ]);
});

test("the working directory is workspace-relative and never absolute", () => {
  expect(workspaceCwd("")).toEqual({ kind: "root" });
  expect(workspaceCwd(".")).toEqual({ kind: "root" });
  expect(workspaceCwd("./packages/app/")).toEqual({ kind: "path", path: "packages/app" });
  expect(workspaceCwd("src\\lib")).toEqual({ kind: "path", path: "src/lib" });
  for (const value of ["/home/mei/project", "C:\\Users\\mei", "~/x", "../outside", "a/../../b"])
    expect(workspaceCwd(value)).toEqual({ kind: "hidden" });
  expect(cwdLabel(workspaceCwd(""))).toBe("專案根目錄");
  expect(cwdLabel(workspaceCwd("C:\\Users\\mei"))).not.toContain("Users");
});

test("output lines drop escapes, CR redraws and the phantom final line", () => {
  expect(outputLines("")).toEqual([]);
  expect(outputLines("\u001b[31mred\u001b[0m\r\nnext\n")).toEqual(["red", "next"]);
  expect(outputLines("10%\r50%\r100%\ndone")).toEqual(["100%", "done"]);
  expect(outputLines("\u001b]52;c;c2VjcmV0\u0007visible\u0000")).toEqual(["visible"]);
  expect(outputLines("tab\tkept")).toEqual(["tab\tkept"]);
});

test("全部 shows stdout then a labelled stderr block; 只看 stderr filters; copy is complete", () => {
  const streams = { stdout: "o1\no2\no3\n", stderr: "e1\ne2\n" };
  const all = outputView(streams);
  expect(all.rows.map((row) => [row.number, row.text, row.kind])).toEqual([
    [1, "o1", undefined],
    [2, "o2", undefined],
    [3, "o3", undefined],
    [undefined, "stderr", "label"],
    [1, "e1", "err"],
    [2, "e2", "err"],
  ]);
  expect(all.hasStderr).toBe(true);
  expect(all.total).toBe(5);
  expect(all.text).toBe("o1\no2\no3\ne1\ne2");
  const errors = outputView(streams, { filter: "stderr" });
  expect(errors.rows.map((row) => row.text)).toEqual(["e1", "e2"]);
  expect(errors.text).toBe("e1\ne2");
  const tail = outputView(streams, { tail: 2 });
  expect(tail.rows.map((row) => row.text)).toEqual(["stderr", "e1", "e2"]);
  expect(tail.hidden).toBe(3);
  const across = outputView(streams, { tail: 3 });
  expect(across.rows.map((row) => row.text)).toEqual(["o3", "stderr", "e1", "e2"]);
  expect(tail.text).toBe(all.text);
  const onlyOut = outputView({ stdout: "x\n", stderr: "" }, { filter: "stderr" });
  expect(onlyOut.hasStderr).toBe(false);
  expect(onlyOut.rows.map((row) => row.text)).toEqual(["x"]);
});

test("facts: exit code (danger unless 0), duration or elapsed timer, output size", () => {
  expect(commandFacts(command, result, 10_000)).toEqual([
    { label: "結束碼", value: "1", tone: "danger", mono: true },
    { label: "耗時", value: "4.2 秒" },
    { label: "輸出", value: "4 B · 2 行" },
  ]);
  const ok = commandFacts({ ...command, state: "succeeded", exit_code: 0 }, undefined, 0);
  expect(ok[0]).toEqual({ label: "結束碼", value: "0", tone: undefined, mono: true });
  expect(JSON.stringify(ok)).not.toMatch(/驗證|安全/);
  const running = commandFacts(
    { ...command, state: "running", exit_code: null, ended_at: null },
    undefined,
    15_500,
  );
  expect(running).toEqual([
    { label: "已執行", value: "0:14" },
    { label: "時間上限", value: "2 分鐘" },
  ]);
  expect(
    commandFacts(
      { ...command, exit_code: null, signal: "SIGTERM", state: "timed_out" },
      undefined,
      0,
    )[0],
  ).toEqual({ label: "結束訊號", value: "SIGTERM", tone: "danger", mono: true });
});

test("output size says when it is only the most recent part", () => {
  expect(outputSize({ ...result, stdout: "", output_complete: true })).toBe("沒有輸出");
  expect(outputSize({ ...result, stdout: "", output_complete: false })).toBeUndefined();
  expect(outputSize({ ...result, stdout_truncated: true })).toBe("最近 4 B · 2 行");
});

test("terminal footer: authorisation while running, exit code after, 唯讀 when unmounted", () => {
  const session: TerminalSession = {
    id: command.id,
    workspace_id: command.workspace_id,
    cwd: "",
    shell: "powershell",
    mode: "host-pty",
    state: "running",
    created_at: 0,
    expires_at: new Date(2026, 9, 6, 15, 12).getTime(),
    cols: 100,
    rows: 28,
    exit_code: null,
  };
  expect(terminalFooter(session, false)).toBe("授權至 下午 3:12");
  expect(terminalFooter(session, true)).toBe("唯讀");
  expect(terminalFooter({ ...session, state: "exited", exit_code: 0 }, false)).toBe("結束碼 0");
  expect(terminalFooter({ ...session, state: "denied" }, false)).toBeUndefined();
  const opened = session.expires_at - 15 * 60_000;
  expect(terminalFacts({ ...session, created_at: opened }, opened + 74_000)).toEqual([
    { label: "已開啟", value: "1:14" },
    { label: "授權至", value: "下午 3:12" },
  ]);
  expect(terminalFacts({ ...session, state: "exited", exit_code: 2 }, 0)).toEqual([
    { label: "結束碼", value: "2", tone: "danger", mono: true },
  ]);
  expect(terminalFacts({ ...session, state: "pending" }, session.expires_at - 30_000)[0]).toEqual({
    label: "審核期限",
    value: "剩 0:30",
    tone: "warning",
  });
  expect(terminalFacts({ ...session, state: "denied" }, 0)).toEqual([]);
});

test("a command that never ran has no output facts and says why instead", () => {
  const denied: Command = {
    ...command,
    state: "denied",
    started_at: null,
    ended_at: null,
    exit_code: null,
  };
  expect(commandNeverRan(denied)).toBe(true);
  expect(commandNeverRan({ ...denied, state: "expired" })).toBe(true);
  expect(commandNeverRan({ ...denied, state: "cancelled" })).toBe(true);
  expect(commandNeverRan({ ...denied, state: "pending" })).toBe(false);
  expect(commandNeverRan(command)).toBe(false);
  // The empty, complete result of a rejected command is not 沒有輸出: it never ran.
  const empty = { ...result, command: denied, stdout: "", stdout_cursor: 0 };
  expect(commandFacts(denied, empty, 0)).toEqual([]);
  expect(commandFacts({ ...command, started_at: 1_000 }, empty, 0).at(-1)).toEqual({
    label: "輸出",
    value: "沒有輸出",
  });
  expect(notRunReason(denied)).toBe("命令沒有執行。");
  expect(notRunReason({ message: " 使用者拒絕 " })).toBe("使用者拒絕");
});

test("retained output is cut at a line start, never inside a line or a surrogate pair", () => {
  expect(tailText("short", 10)).toEqual({ text: "short", cut: false });
  expect(tailText("one\ntwo\nthree", 8)).toEqual({ text: "three", cut: true });
  expect(tailText("one\ntwo\nthree", 10)).toEqual({ text: "two\nthree", cut: true });
  expect(tailText("x🐱yz", 3)).toEqual({ text: "yz", cut: true });
});
