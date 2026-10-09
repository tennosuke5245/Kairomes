import type { Command, CommandResult, TerminalSession } from "@kairomes/protocol";
import { toneFor, type UiDataTone } from "@kairomes/protocol/ui-state";
import { formatBytes, utf8Bytes } from "./file-model.ts";
import { clockDuration, clockTime, countdown, formatDuration } from "./time-format.ts";
import type { TimelineMeta } from "./timeline-model.ts";

// Pure presentation of commands and their output (C6, C8). Output is untrusted text: it is
// only ever rendered through React text nodes.

/** Each argv element as typed in a shell; quoting keeps spaces inside one element visible. */
export function argvParts(argv: readonly string[]) {
  return argv.map((part) => (part === "" || /[\s"'\\]/.test(part) ? JSON.stringify(part) : part));
}

/** Shell-like display of argv on one line. */
export function formatArgv(argv: readonly string[]) {
  return argvParts(argv).join(" ");
}

export type WorkspaceCwd = { kind: "root" } | { kind: "path"; path: string } | { kind: "hidden" };

/**
 * The working directory, workspace-relative only: "" or "." is the project root. An
 * absolute or escaping value is never displayed (the daemon should never send one).
 */
export function workspaceCwd(cwd: string): WorkspaceCwd {
  const value = cwd
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  if (!value || value === ".") return { kind: "root" };
  if (/^(?:[A-Za-z]:|\/|~)/.test(value) || value.split("/").includes(".."))
    return { kind: "hidden" };
  return { kind: "path", path: value };
}

export function cwdLabel(cwd: WorkspaceCwd) {
  return cwd.kind === "root" ? "專案根目錄" : cwd.kind === "path" ? cwd.path : "專案內的資料夾";
}

// CSI, OSC and other escape sequences, then any remaining control character except tab.
const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are stripped on purpose.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Output text as display lines: escapes removed, CR handled, no phantom final line. */
export function outputLines(text: string) {
  if (!text) return [];
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  if (rows.at(-1) === "") rows.pop();
  // A bare CR redraws the line (progress bars); keep what was drawn last.
  return rows.map((row) => (row.split("\r").at(-1) ?? "").replace(ESCAPES, ""));
}

/**
 * The last `limit` characters of retained output, starting at a line: the cut moves forward
 * to just after the next newline, so the first row is never half a line, and never splits a
 * surrogate pair. Only a single line longer than the limit is cut inside the line.
 */
export function tailText(text: string, limit: number) {
  if (text.length <= limit) return { text, cut: false };
  let cut = text.length - limit;
  if (text[cut - 1] !== "\n") {
    const newline = text.indexOf("\n", cut);
    if (newline >= 0 && newline + 1 < text.length) cut = newline + 1;
  }
  const first = text.charCodeAt(cut);
  if (first >= 0xdc00 && first <= 0xdfff) cut++;
  return { text: text.slice(cut), cut: true };
}

export type OutputFilter = "all" | "stderr";
export interface OutputRow {
  key: string;
  /** Line number within its stream; label rows have none. */
  number?: number;
  text: string;
  kind?: "err" | "label";
}

export interface OutputView {
  rows: OutputRow[];
  /** Rows hidden above the tail. */
  hidden: number;
  /** Lines in the filtered streams (label rows excluded). */
  total: number;
  /** Both streams have content, so 只看 stderr means something. */
  hasStderr: boolean;
  /** Text for copy: the filtered streams in full, never just the visible tail. */
  text: string;
}

/**
 * stdout and stderr arrive as separate streams, so their interleaving is unknown: 全部 shows
 * stdout, then a labelled stderr block. Each stream is numbered on its own.
 */
export function outputView(
  streams: { stdout: string; stderr: string },
  options: { filter?: OutputFilter; tail?: number } = {},
): OutputView {
  const out = outputLines(streams.stdout);
  const err = outputLines(streams.stderr);
  const hasStderr = err.length > 0;
  const filter = hasStderr ? (options.filter ?? "all") : "all";
  const content: OutputRow[] = [
    ...(filter === "all" ? out : []).map((text, index) => ({
      key: `o${index}`,
      number: index + 1,
      text,
    })),
    ...err.map((text, index) => ({
      key: `e${index}`,
      number: index + 1,
      text,
      kind: "err" as const,
    })),
  ];
  const tail = options.tail;
  const cut = tail !== undefined && content.length > tail ? content.length - tail : 0;
  const rows: OutputRow[] = [];
  for (const row of content.slice(cut)) {
    // In 全部, a label marks where stderr starts; the tail counts output lines only.
    if (row.kind === "err" && filter === "all" && out.length && !rows.some((item) => item.kind))
      rows.push({ key: "label", text: "stderr", kind: "label" });
    rows.push(row);
  }
  return {
    rows,
    hidden: cut,
    total: (filter === "all" ? out.length : 0) + err.length,
    hasStderr,
    text: (filter === "all" ? [...out, ...err] : err).join("\n"),
  };
}

/** Rejected, expired or cancelled before it started: there was no run and no output. */
export function commandNeverRan(command: Pick<Command, "state" | "started_at">) {
  return command.started_at === null && !["pending", "starting", "running"].includes(command.state);
}

/** Shown instead of output for a command that never ran: the daemon's reason, else one line. */
export function notRunReason(command: Pick<Command, "message">) {
  return command.message?.trim() || "命令沒有執行。";
}

export interface Fact {
  label: string;
  value: string;
  tone?: UiDataTone;
  mono?: boolean;
}

/** 2.1 KiB · 52 行 for the retained output; 最近 … when the daemon or the client clipped it. */
export function outputSize(result: CommandResult) {
  const text = result.stdout + result.stderr;
  if (!text) return result.output_complete ? "沒有輸出" : undefined;
  const lines = outputLines(result.stdout).length + outputLines(result.stderr).length;
  const clipped = result.stdout_truncated || result.stderr_truncated;
  return `${clipped ? "最近 " : ""}${formatBytes(utf8Bytes(text))} · ${lines.toLocaleString("en-US")} 行`;
}

/**
 * The stats strip under a command title: exit code (danger when non-zero), run time and
 * output size. Exit 0 is a run result only; nothing here says verified or safe.
 */
export function commandFacts(command: Command, result: CommandResult | undefined, now: number) {
  const facts: Fact[] = [];
  if (command.exit_code !== null)
    facts.push({
      label: "結束碼",
      value: String(command.exit_code),
      tone: command.exit_code === 0 ? undefined : "danger",
      mono: true,
    });
  else if (command.signal)
    facts.push({ label: "結束訊號", value: command.signal, tone: "danger", mono: true });
  if (command.started_at !== null) {
    if (command.ended_at !== null)
      facts.push({ label: "耗時", value: formatDuration(command.ended_at - command.started_at) });
    else facts.push({ label: "已執行", value: clockDuration(now - command.started_at) });
  }
  if (["pending", "starting", "running"].includes(command.state))
    facts.push({ label: "時間上限", value: formatDuration(command.timeout_ms) });
  const size = result && !commandNeverRan(command) ? outputSize(result) : undefined;
  if (size) facts.push({ label: "輸出", value: size });
  return facts;
}

/** Overview facts for a terminal: elapsed time and authorisation while open, else the exit. */
export function terminalFacts(session: TerminalSession, now: number): Fact[] {
  if (session.state === "pending") {
    const left = countdown(session.expires_at, now);
    return [{ label: "審核期限", value: left.text, tone: left.urgency ? "warning" : undefined }];
  }
  if (session.state === "running")
    return [
      { label: "已開啟", value: clockDuration(now - session.created_at) },
      { label: "授權至", value: clockTime(session.expires_at) },
    ];
  if (session.exit_code !== null)
    return [
      {
        label: "結束碼",
        value: String(session.exit_code),
        tone: session.exit_code === 0 ? undefined : "danger",
        mono: true,
      },
    ];
  return [];
}

/** Footer of a terminal: 主機終端機 · state on the left, authorisation or exit on the right. */
export function terminalFooter(session: TerminalSession, readOnly: boolean) {
  if (readOnly) return "唯讀";
  if (session.state === "running") return `授權至 ${clockTime(session.expires_at)}`;
  if (session.exit_code !== null) return `結束碼 ${session.exit_code}`;
  return undefined;
}

/** 剩 m:ss while pending, 已執行 m:ss while running, then the run time. */
export function commandMeta(command: Command, now: number): TimelineMeta | undefined {
  if (command.state === "pending") {
    const { text, urgency } = countdown(command.expires_at, now);
    return { kind: "countdown", text, urgency };
  }
  if (command.started_at === null) return undefined;
  if (command.ended_at === null)
    return { kind: "elapsed", text: `已執行 ${clockDuration(now - command.started_at)}` };
  return { kind: "duration", text: formatDuration(command.ended_at - command.started_at) };
}

/** 結束碼 1 · 1 個測試未通過 / 超過 120 秒，已停止; daemon messages are user-facing copy. */
export function commandReason(command: Command, message?: string | null) {
  const text = message?.trim() || undefined;
  if (command.state === "failed" && command.exit_code !== null)
    return [`結束碼 ${command.exit_code}`, text].filter(Boolean).join(" · ");
  if (command.state === "timed_out")
    return text ?? `超過 ${Math.round(command.timeout_ms / 1000)} 秒，已停止`;
  if (toneFor("command", command.state).tone === "danger") return text;
  return undefined;
}
