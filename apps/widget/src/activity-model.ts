import {
  type ActivityEntry,
  type ActivitySnapshot,
  artifactImportLabels,
  commandLabels,
  fileChangeLabels,
  terminalLabels,
} from "@kairomes/protocol";
import { toneFor, type UiState } from "@kairomes/protocol/ui-state";

const observedTools = new Set([
  "artifact_preview",
  "file_read",
  "file_read_many",
  "file_search",
  "file_find",
  "workspace_snapshot",
  "mcp_tool_call",
  "mcp_read_call",
  "git_status",
  "git_diff",
  "git_log",
  "artifact_import_request",
]);

/** Polling and local browsing are observations, not new agent work. */
export function visibleActivity(snapshot?: ActivitySnapshot, workspaceId?: string | null) {
  const entries = snapshot?.entries ?? [];
  const latest = new Map<string, ActivityEntry>();
  for (const entry of entries) {
    if (entry.source !== "mcp" || (workspaceId && entry.workspaceId !== workspaceId)) continue;
    if (entry.kind === "tool" && !observedTools.has(entry.tool ?? "")) continue;
    const key = entry.commandId ?? entry.changeId ?? entry.sessionId ?? entry.importId ?? entry.id;
    const prior = latest.get(`${entry.kind}:${key}`);
    if (!prior || entry.seq > prior.seq) latest.set(`${entry.kind}:${key}`, entry);
  }
  return [...latest.values()].sort((a, b) => b.seq - a.seq);
}

/** One status system (design spec §3): tone, icon and label come from toneFor. */
export function activityState(entry: ActivityEntry): UiState {
  return toneFor(entry.kind, entry.state);
}

const own = (table: Record<string, string>, key: string) =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** The status suffix the daemon appends to tracked work (activity.ts in apps/daemon). */
function daemonStatusLabel(entry: ActivityEntry) {
  if (entry.kind === "command") return own(commandLabels, entry.state);
  if (entry.kind === "terminal") return own(terminalLabels, entry.state);
  if (entry.kind === "file_change") return own(fileChangeLabels, entry.state);
  if (entry.kind === "artifact_import") return own(artifactImportLabels, entry.state);
  return undefined;
}

/** Current daemon titles include their status suffix. Render that status once. */
export function activityTitle(entry: ActivityEntry) {
  const label = daemonStatusLabel(entry);
  const suffix = label ? ` · ${label}` : "";
  return suffix && entry.title.endsWith(suffix)
    ? entry.title.slice(0, -suffix.length)
    : entry.title;
}

export type ActivityFilter = "all" | "changes" | "commands" | "failed";
export const ACTIVITY_FILTERS: readonly { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "changes", label: "變更" },
  { id: "commands", label: "命令" },
  { id: "failed", label: "失敗" },
];

/** 變更 writes the workspace; 命令 runs on the host; 失敗 is any danger-toned result. */
export function matchesActivityFilter(entry: ActivityEntry, filter: ActivityFilter) {
  if (filter === "changes") return entry.kind === "file_change" || entry.kind === "artifact_import";
  if (filter === "commands") return entry.kind === "command" || entry.kind === "terminal";
  if (filter === "failed") return activityState(entry).tone === "danger";
  return true;
}

/** Filters an already visible list. Unread and follow math stay on the unfiltered list. */
export function filterActivity(entries: readonly ActivityEntry[], filter: ActivityFilter) {
  return filter === "all"
    ? [...entries]
    : entries.filter((entry) => matchesActivityFilter(entry, filter));
}

export function activityFilterCounts(entries: readonly ActivityEntry[]) {
  const counts: Record<ActivityFilter, number> = { all: 0, changes: 0, commands: 0, failed: 0 };
  for (const entry of entries)
    for (const { id } of ACTIVITY_FILTERS) if (matchesActivityFilter(entry, id)) counts[id]++;
  return counts;
}

export function focusSequence(snapshot?: ActivitySnapshot, workspaceId?: string | null) {
  return visibleActivity(snapshot, workspaceId).reduce(
    (seq, entry) => Math.max(seq, entry.focusSeq),
    0,
  );
}

export function unreadActivity(
  snapshot: ActivitySnapshot | undefined,
  after: number,
  workspaceId?: string | null,
) {
  return visibleActivity(snapshot, workspaceId).filter((entry) => entry.focusSeq > after).length;
}

export function workspaceFilterMessage(value: unknown): { workspaceId: string | null } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !["type", "version", "workspaceId"].includes(key))) return;
  if (data.type !== "kairomes:workspace-filter" || data.version !== 1) return;
  if (
    data.workspaceId !== null &&
    (typeof data.workspaceId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.workspaceId))
  )
    return;
  return { workspaceId: data.workspaceId as string | null };
}
