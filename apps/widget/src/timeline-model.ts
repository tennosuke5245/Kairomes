import type { ActivityEntry, ActivitySnapshot } from "@kairomes/protocol";
import type { UiState } from "@kairomes/protocol/ui-state";
import { activityState, activityTitle } from "./activity-model.ts";
import { commandMeta, commandReason, formatArgv } from "./command-model.ts";
import { type CountdownUrgency, countdown, formatDuration, relativeTime } from "./time-format.ts";

/** Kind tiles are neutral in lists; state is shown once, by the pill (design spec §6). */
export type KindIcon =
  | "command"
  | "terminal"
  | "file"
  | "files"
  | "change"
  | "image"
  | "search"
  | "folder"
  | "git"
  | "mcp";

export interface TimelineMeta {
  kind: "countdown" | "elapsed" | "duration" | "files";
  text: string;
  urgency?: CountdownUrgency;
}

export interface TimelineRow {
  entry: ActivityEntry;
  state: UiState;
  icon: KindIcon;
  /** Plain words, then an optional verbatim value rendered in mono (argv, path, shell). */
  verb: string;
  code?: string;
  /** Accessible and tooltip text for the whole title. */
  title: string;
  time: string;
  workspace?: { id: string; name: string; hue: number };
  meta?: TimelineMeta;
  /** Failure or uncertainty reason, only for danger and warning rows. */
  reason?: string;
  /** True when a detail can be opened; otherwise the row is a static record. */
  actionable: boolean;
}

/** Number of rows added per 顯示更早; every retained entry is reachable by paging. */
export const TIMELINE_PAGE = 40;

/** Decorative workspace hue 1–5 (FNV-1a over UTF-16 units); the name is always beside it. */
export function workspaceHue(id: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 5) + 1;
}

const readVerbs: Partial<Record<NonNullable<ActivityEntry["tool"]>, [string, string]>> = {
  // [daemon default title, verb used when the path is known]
  file_read: ["讀取檔案", "讀取"],
  artifact_preview: ["預覽圖片", "預覽"],
  workspace_snapshot: ["瀏覽資料夾", "瀏覽"],
};

function kindIcon(entry: ActivityEntry): KindIcon {
  if (entry.kind === "command") return "command";
  if (entry.kind === "terminal") return "terminal";
  if (entry.kind === "file_change") return "change";
  if (entry.kind === "artifact_import") return "image";
  switch (entry.tool) {
    case "artifact_preview":
      return "image";
    case "file_search":
    case "file_find":
      return "search";
    case "workspace_snapshot":
    case "workspace_list":
      return "folder";
    case "file_read_many":
      return "files";
    case "git_status":
    case "git_diff":
    case "git_log":
      return "git";
    case "mcp_tool_call":
    case "mcp_read_call":
      return "mcp";
    default:
      return "file";
  }
}

/** The headline shared by the timeline row and the inspector: plain verb, verbatim value. */
export function activityHeadline(entry: ActivityEntry, snapshot?: ActivitySnapshot) {
  const title = activityTitle(entry);
  if (entry.kind === "command") {
    const argv = snapshot?.commands?.find((item) => item.id === entry.commandId)?.argv;
    if (argv?.length) return { verb: "執行", code: formatArgv(argv) };
    return { verb: "執行", code: title };
  }
  if (entry.kind === "terminal") {
    const shell = snapshot?.sessions.find((item) => item.id === entry.sessionId)?.shell;
    return { verb: "終端機", code: shell ?? title };
  }
  // An image import names its target once, verbatim: 匯入圖片 design/cover.png.
  if (entry.kind === "artifact_import" && entry.path) return { verb: title, code: entry.path };
  const read = entry.tool ? readVerbs[entry.tool] : undefined;
  if (entry.path && read && title === read[0]) return { verb: read[1], code: entry.path };
  // A title that already ends with the path ("讀取 src/main.ts") shows that path verbatim once.
  if (entry.path && title.endsWith(` ${entry.path}`) && title.length > entry.path.length + 1)
    return { verb: title.slice(0, -entry.path.length - 1), code: entry.path };
  if (entry.path && entry.kind === "tool" && !title.includes(entry.path))
    return { verb: title, code: entry.path };
  return { verb: title };
}

/** Plain text of the headline, for comparisons and accessible names. */
export function headlineText({ verb, code }: { verb: string; code?: string }) {
  return code ? `${verb} ${code}` : verb;
}

function pendingExpiry(entry: ActivityEntry, snapshot?: ActivitySnapshot) {
  if (entry.commandId)
    return snapshot?.commands?.find((item) => item.id === entry.commandId)?.expires_at;
  if (entry.changeId)
    return snapshot?.changes?.find((item) => item.id === entry.changeId)?.expires_at;
  if (entry.sessionId)
    return snapshot?.sessions.find((item) => item.id === entry.sessionId)?.expires_at;
  if (entry.importId)
    return snapshot?.imports?.find((item) => item.id === entry.importId)?.expires_at;
  return undefined;
}

/** Waiting on the local user: a pending decision, or an image import that needs its image. */
function waitsForUser(entry: ActivityEntry) {
  return (
    entry.state === "pending" ||
    (entry.kind === "artifact_import" && entry.state === "awaiting_file")
  );
}

function rowMeta(entry: ActivityEntry, snapshot: ActivitySnapshot | undefined, now: number) {
  if (waitsForUser(entry)) {
    const expires = pendingExpiry(entry, snapshot);
    if (expires === undefined) return undefined;
    const { text, urgency } = countdown(expires, now);
    return { kind: "countdown", text, urgency } satisfies TimelineMeta;
  }
  const command = entry.commandId
    ? snapshot?.commands?.find((item) => item.id === entry.commandId)
    : undefined;
  if (command?.started_at != null) return commandMeta(command, now);
  if (entry.kind === "terminal" && ["exited", "stopped"].includes(entry.state)) {
    const session = snapshot?.sessions.find((item) => item.id === entry.sessionId);
    if (session && entry.updatedAt > session.created_at)
      return {
        kind: "duration",
        text: `用了 ${formatDuration(entry.updatedAt - session.created_at)}`,
      } satisfies TimelineMeta;
  }
  const change = entry.changeId
    ? snapshot?.changes?.find((item) => item.id === entry.changeId)
    : undefined;
  if (change?.files.length)
    return { kind: "files", text: `${change.files.length} 個檔案` } satisfies TimelineMeta;
  return undefined;
}

/** One line under failed and uncertain rows. Daemon messages are already user-facing copy. */
function rowReason(entry: ActivityEntry, state: UiState, snapshot?: ActivitySnapshot) {
  if (state.tone !== "danger" && state.tone !== "warning") return undefined;
  const message = entry.message?.trim() || undefined;
  const command = entry.commandId
    ? snapshot?.commands?.find((item) => item.id === entry.commandId)
    : undefined;
  if (command && ["failed", "timed_out"].includes(command.state))
    return commandReason(command, message);
  if (entry.kind === "file_change" && entry.state === "conflict")
    return message ?? "檔案已被修改，沒有寫入";
  return message;
}

export function timelineRow(
  entry: ActivityEntry,
  options: {
    snapshot?: ActivitySnapshot;
    now: number;
    /** Name for a workspace tag; undefined hides the tag (one workspace is filtered). */
    workspaceName?: (id: string) => string | undefined;
  },
): TimelineRow {
  const { snapshot, now, workspaceName } = options;
  const state = activityState(entry);
  const { verb, code } = activityHeadline(entry, snapshot);
  const name = entry.workspaceId ? workspaceName?.(entry.workspaceId) : undefined;
  return {
    entry,
    state,
    icon: kindIcon(entry),
    verb,
    code,
    title: headlineText({ verb, code }),
    time: relativeTime(entry.updatedAt, now),
    workspace:
      entry.workspaceId && name
        ? { id: entry.workspaceId, name, hue: workspaceHue(entry.workspaceId) }
        : undefined,
    meta: rowMeta(entry, snapshot, now),
    reason: rowReason(entry, state, snapshot),
    actionable: !!(
      entry.resultId ||
      entry.sessionId ||
      entry.commandId ||
      entry.changeId ||
      entry.importId
    ),
  };
}

/** Rows that change every second (countdown, running timer) need a 1 s tick; others 10 s. */
export function ticksEverySecond(entries: readonly ActivityEntry[], snapshot?: ActivitySnapshot) {
  return entries.some((entry) => {
    if (waitsForUser(entry)) return true;
    const command = entry.commandId
      ? snapshot?.commands?.find((item) => item.id === entry.commandId)
      : undefined;
    return command?.started_at != null && command.ended_at == null;
  });
}

export function newActivityLabel(count: number) {
  return `有 ${count} 則新動態 · 回到最新`;
}
