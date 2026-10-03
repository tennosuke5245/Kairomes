import type { ActivityEntry, ActivitySnapshot } from "@kairomes/protocol";
import {
  CaretRightIcon,
  ChatCircleDotsIcon,
  CircleNotchIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlugsConnectedIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { activityLabel, activityTitle, visibleActivity } from "./activity-model.ts";
import type { WorkbenchBridge } from "./bridge.ts";

export function latestFocus(
  snapshot?: ActivitySnapshot,
  workspaceId?: string | null,
): ActivityEntry | undefined {
  return visibleActivity(snapshot, workspaceId)
    .filter(
      (entry) =>
        entry.source === "mcp" &&
        entry.focusSeq > 0 &&
        (entry.kind === "terminal" ||
          entry.kind === "command" ||
          entry.kind === "file_change" ||
          entry.kind === "artifact_import" ||
          entry.tool === "artifact_preview" ||
          entry.tool === "file_read" ||
          entry.tool === "file_search" ||
          entry.tool === "workspace_snapshot" ||
          entry.tool === "mcp_tool_call" ||
          entry.tool === "mcp_read_call"),
    )
    .reduce<ActivityEntry | undefined>(
      (best, entry) => (!best || entry.focusSeq > best.focusSeq ? entry : best),
      undefined,
    );
}

export function useActivity(bridge: WorkbenchBridge) {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!bridge.activity) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let backoff = 1000;
    const abort = new AbortController();
    const connect = async () => {
      try {
        await bridge.activity?.watch((next) => {
          if (stopped) return;
          setSnapshot((prior) =>
            prior?.instanceId === next.instanceId && prior.seq > next.seq ? prior : next,
          );
          setError("");
          backoff = 1000;
        }, abort.signal);
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : "即時連線中斷。");
      }
      if (!stopped) {
        timer = setTimeout(() => void connect(), backoff);
        backoff = Math.min(backoff * 2, 15000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [bridge]);
  return { snapshot, error };
}

function entryState(entry: ActivityEntry) {
  if (["pending"].includes(entry.state)) return "pending";
  if (["working", "starting", "running", "applying"].includes(entry.state)) return "working";
  if (["failed", "denied", "expired", "cancelled", "timed_out", "conflict"].includes(entry.state))
    return "failed";
  return "done";
}

function EntryIcon({ entry }: { entry: ActivityEntry }) {
  const state = entryState(entry);
  if (state === "working") return <CircleNotchIcon weight="bold" className="spinning" />;
  if (state === "failed") return <WarningCircleIcon weight="fill" />;
  if (entry.kind === "terminal" || entry.kind === "command") return <TerminalWindowIcon />;
  if (entry.kind === "file_change") return <PencilSimpleIcon />;
  if (entry.kind === "artifact_import" || entry.tool === "artifact_preview") return <ImageIcon />;
  if (entry.tool === "mcp_tool_call" || entry.tool === "mcp_read_call")
    return <PlugsConnectedIcon />;
  if (entry.tool === "file_search") return <MagnifyingGlassIcon />;
  return <FileTextIcon />;
}

export function ActivityPanel({
  snapshot,
  error,
  emptyWorkspace,
  following,
  onFollow,
  onSelect,
  workspaceName,
  workspaceId,
  unread = 0,
  nativeControls = false,
  onFiles,
}: {
  snapshot?: ActivitySnapshot;
  error: string;
  emptyWorkspace: boolean;
  following: boolean;
  onFollow(): void;
  onSelect(entry: ActivityEntry): void;
  workspaceName(id?: string): string;
  workspaceId?: string | null;
  unread?: number;
  nativeControls?: boolean;
  onFiles?(): void;
}) {
  const current = latestFocus(snapshot, workspaceId);
  const entries = visibleActivity(snapshot, workspaceId).slice(0, 30);
  const pending = [
    ...(snapshot?.imports ?? []),
    ...(snapshot?.changes ?? []),
    ...(snapshot?.sessions ?? []),
    ...(snapshot?.commands ?? []),
  ].filter((item) => item.state === "pending").length;
  return (
    <section className="activity-panel signal-stream" aria-label="本機操作">
      <header className="stream-heading">
        <h1>動態</h1>
        <div className="stream-actions">
          {onFiles && (
            <button type="button" onClick={onFiles}>
              檔案
            </button>
          )}
          <button
            type="button"
            className={`follow-button ${following ? "active" : ""}`}
            onClick={onFollow}
            aria-pressed={following}
            aria-label={following ? "暫停即時跟隨" : "回到最新動態"}
          >
            {following ? "即時" : unread ? `最新 ${unread}` : "最新"}
          </button>
        </div>
      </header>
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {!following && unread > 0 ? `${unread} 筆新操作` : ""}
      </span>
      {error && (
        <div className="stream-alert" role="alert">
          <WarningCircleIcon weight="fill" />
          <span>{error}</span>
        </div>
      )}
      {pending > 0 && !nativeControls && (
        <div className="stream-notice" role="status">
          <span>{pending}</span>
          <strong>件需確認 · 請開啟原生側欄</strong>
        </div>
      )}
      {emptyWorkspace && entries.length > 0 && (
        <p className="stream-project-hint" role="status">
          尚未掛載專案，請在 Kairomes Desktop 新增資料夾。
        </p>
      )}
      {!entries.length && (
        <div className="stream-empty">
          {emptyWorkspace ? (
            <FolderIcon className="stream-empty-icon" weight="duotone" aria-hidden="true" />
          ) : (
            <ChatCircleDotsIcon className="stream-empty-icon" weight="duotone" aria-hidden="true" />
          )}
          <h2>
            {emptyWorkspace
              ? "請在 Desktop 新增專案"
              : workspaceId
                ? "此專案尚無操作"
                : "尚無本機操作"}
          </h2>
        </div>
      )}
      <div className="stream-list">
        {entries.map((entry) => {
          const state = entryState(entry);
          const command = snapshot?.commands?.find((item) => item.id === entry.commandId);
          const isCurrent = entry.id === current?.id;
          const title = activityTitle(entry);
          const actionable = !!(
            entry.resultId ||
            entry.sessionId ||
            entry.commandId ||
            entry.changeId ||
            entry.importId
          );
          return (
            <article
              className={`stream-entry state-${state} ${isCurrent ? "current" : ""} ${actionable ? "actionable" : ""}`}
              key={entry.id}
            >
              <div className="stream-node" aria-hidden="true">
                <EntryIcon entry={entry} />
              </div>
              <div className="stream-card">
                <div className="stream-meta">
                  <span className={`stream-state state-${state}`}>{activityLabel(entry)}</span>
                  <span>
                    {command?.exit_code !== null && command?.exit_code !== undefined
                      ? `Exit ${command.exit_code} · `
                      : ""}
                    {new Date(entry.updatedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <h2>{title}</h2>
                {entry.path && !title.includes(entry.path) && (
                  <p className="stream-path">{entry.path}</p>
                )}
                <div className="stream-card-footer">
                  <small>
                    {entry.tool === "mcp_tool_call" || entry.tool === "mcp_read_call"
                      ? "MCP 工具"
                      : workspaceName(entry.workspaceId)}
                  </small>
                  {actionable && (
                    <button
                      type="button"
                      aria-label={`查看「${title}」詳情`}
                      data-activity-id={entry.id}
                      onClick={() => onSelect(entry)}
                    >
                      查看
                      <CaretRightIcon weight="bold" />
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
