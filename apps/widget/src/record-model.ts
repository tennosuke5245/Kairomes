import type { Command, FileChange, TerminalSession } from "@kairomes/protocol";
import { toneFor, type UiState } from "@kairomes/protocol/ui-state";
import { commandMeta, commandReason, formatArgv } from "./command-model.ts";
import { countdown, relativeTime } from "./time-format.ts";
import { type KindIcon, type TimelineMeta, workspaceHue } from "./timeline-model.ts";

// Record rows for the command, change and terminal lists (C6): title, one meta line and a
// tone pill. They replace native <select> pickers that showed 8-character ids.

export interface RecordRow {
  id: string;
  icon: KindIcon;
  /** Plain words, then an optional verbatim value rendered in mono. */
  verb: string;
  code?: string;
  title: string;
  state: UiState;
  time: string;
  workspace?: { id: string; name: string; hue: number };
  meta?: TimelineMeta;
  reason?: string;
}

type Options = {
  now: number;
  /** Name for a workspace tag; undefined hides the tag (one workspace is in view). */
  workspaceName?: (id: string) => string | undefined;
};

function workspaceTag(id: string, options: Options) {
  const name = options.workspaceName?.(id);
  return name ? { id, name, hue: workspaceHue(id) } : undefined;
}

export function commandRecord(command: Command, options: Options): RecordRow {
  const code = formatArgv(command.argv);
  return {
    id: command.id,
    icon: "command",
    verb: "執行",
    code,
    title: `執行 ${code}`,
    state: toneFor("command", command.state),
    time: relativeTime(command.ended_at ?? command.started_at ?? command.created_at, options.now),
    workspace: workspaceTag(command.workspace_id, options),
    meta: commandMeta(command, options.now),
    reason: commandReason(command, command.message),
  };
}

export function changeReason(change: FileChange) {
  const text = change.message?.trim() || undefined;
  if (change.state === "conflict") return text ?? "檔案已被修改，沒有寫入";
  const tone = toneFor("file_change", change.state).tone;
  return tone === "danger" || tone === "warning" ? text : undefined;
}

/** powershell · 可接收輸入 · 3 分鐘前 (the pill carries the state). */
export function terminalRecord(session: TerminalSession, options: Options): RecordRow {
  const pending =
    session.state === "pending" ? countdown(session.expires_at, options.now) : undefined;
  return {
    id: session.id,
    icon: "terminal",
    verb: "終端機",
    code: session.shell,
    title: `終端機 ${session.shell}`,
    state: toneFor("terminal", session.state),
    time: relativeTime(session.created_at, options.now),
    workspace: workspaceTag(session.workspace_id, options),
    meta: pending ? { kind: "countdown", text: pending.text, urgency: pending.urgency } : undefined,
  };
}
