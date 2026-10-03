import {
  type ActivityEntry,
  type ActivitySnapshot,
  artifactImportLabels,
  commandLabels,
  fileChangeLabels,
  terminalLabels,
} from "@kairomes/protocol";

const observedTools = new Set([
  "artifact_preview",
  "file_read",
  "file_search",
  "workspace_snapshot",
  "mcp_tool_call",
  "mcp_read_call",
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

export function activityLabel(entry: ActivityEntry) {
  if (entry.kind === "command" && entry.state in commandLabels)
    return entry.state === "succeeded"
      ? "已結束"
      : commandLabels[entry.state as keyof typeof commandLabels];
  if (entry.kind === "terminal" && entry.state in terminalLabels)
    return terminalLabels[entry.state as keyof typeof terminalLabels];
  if (entry.kind === "file_change" && entry.state in fileChangeLabels)
    return fileChangeLabels[entry.state as keyof typeof fileChangeLabels];
  if (entry.kind === "artifact_import" && entry.state in artifactImportLabels)
    return artifactImportLabels[entry.state as keyof typeof artifactImportLabels];
  return entry.state === "working" ? "處理中" : entry.state === "failed" ? "未完成" : "已完成";
}

/** Current daemon titles include their status suffix. Render that status once. */
export function activityTitle(entry: ActivityEntry) {
  const label =
    entry.kind === "command" && entry.state === "succeeded"
      ? commandLabels.succeeded
      : activityLabel(entry);
  const suffix = ` · ${label}`;
  return entry.title.endsWith(suffix) ? entry.title.slice(0, -suffix.length) : entry.title;
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
