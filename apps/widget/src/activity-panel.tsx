import type { ActivityEntry, ActivitySnapshot } from "@kairomes/protocol";
import {
  CaretRightIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  ClockIcon,
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
import type { WorkbenchBridge } from "./bridge.ts";

export function latestFocus(snapshot?: ActivitySnapshot): ActivityEntry | undefined {
  return snapshot?.entries
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
  if (["failed", "denied", "expired", "cancelled"].includes(entry.state)) return "failed";
  return "done";
}

function EntryIcon({ entry }: { entry: ActivityEntry }) {
  const state = entryState(entry);
  if (state === "working") return <CircleNotchIcon weight="bold" className="spinning" />;
  if (state === "failed") return <WarningCircleIcon weight="fill" />;
  if (state === "done") return <CheckCircleIcon weight="fill" />;
  if (entry.kind === "terminal" || entry.kind === "command") return <TerminalWindowIcon />;
  if (entry.kind === "file_change") return <PencilSimpleIcon />;
  if (entry.kind === "artifact_import" || entry.tool === "artifact_preview") return <ImageIcon />;
  if (entry.tool === "mcp_tool_call" || entry.tool === "mcp_read_call")
    return <PlugsConnectedIcon />;
  if (entry.tool === "file_search") return <MagnifyingGlassIcon />;
  return <FileTextIcon />;
}

function description(entry: ActivityEntry) {
  if (entry.kind === "file_change") return "檔案變更";
  if (entry.kind === "command") return "一次性命令";
  if (entry.kind === "terminal") return "本機終端機";
  if (entry.kind === "artifact_import") return `匯入 ${entry.path ?? "圖片"}`;
  if (entry.tool === "artifact_preview") return `預覽 ${entry.path ?? "工作區圖片"}`;
  if (entry.tool === "file_read") return `讀取 ${entry.path ?? "工作區檔案"}`;
  if (entry.tool === "file_search") return "搜尋專案內容";
  if (entry.tool === "workspace_snapshot") return "查看專案檔案";
  if (entry.tool === "mcp_tool_call" || entry.tool === "mcp_read_call") return "";
  return entry.path ? `處理 ${entry.path}` : "處理專案內容";
}

function stateLabel(entry: ActivityEntry) {
  const state = entryState(entry);
  if (state === "pending") return "待確認";
  if (state === "working") return "進行中";
  if (state === "failed") return "未完成";
  return "完成";
}

export function ActivityPanel({
  snapshot,
  error,
  emptyWorkspace,
  following,
  onFollow,
  onSelect,
  workspaceName,
}: {
  snapshot?: ActivitySnapshot;
  error: string;
  emptyWorkspace: boolean;
  following: boolean;
  onFollow(): void;
  onSelect(entry: ActivityEntry): void;
  workspaceName(id?: string): string;
}) {
  const current = latestFocus(snapshot);
  const entries = snapshot?.entries.filter((entry) => entry.source === "mcp").slice(0, 30) ?? [];
  const pending = [
    ...(snapshot?.imports ?? []),
    ...(snapshot?.changes ?? []),
    ...(snapshot?.sessions ?? []),
    ...(snapshot?.commands ?? []),
  ].filter((item) => item.state === "pending").length;
  return (
    <section className="activity-panel signal-stream" aria-label="ChatGPT 即時操作">
      <header className="stream-heading">
        <h1>動態</h1>
        <button
          type="button"
          className={`follow-button ${following ? "active" : ""}`}
          onClick={onFollow}
          aria-pressed={following}
          aria-label={following ? "暫停即時跟隨" : "回到最新動態"}
        >
          {following ? "即時" : "回到最新"}
        </button>
      </header>
      {error && (
        <div className="stream-alert" role="alert">
          <WarningCircleIcon weight="fill" />
          <span>{error}</span>
        </div>
      )}
      {pending > 0 && (
        <div className="stream-notice" role="status">
          <span>{pending}</span>
          <strong>件待確認 · 請查看上方核准卡</strong>
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
          <h2>{emptyWorkspace ? "尚未掛載專案" : "等待 ChatGPT 操作"}</h2>
          <p>
            {emptyWorkspace
              ? "請在 Kairomes Desktop 新增資料夾。"
              : "在 ChatGPT 提出任務，進度會顯示在這裡。"}
          </p>
        </div>
      )}
      <div className="stream-list">
        {entries.map((entry) => {
          const state = entryState(entry);
          const change = snapshot?.changes?.find((item) => item.id === entry.changeId);
          const artifactImport = snapshot?.imports?.find((item) => item.id === entry.importId);
          const command = snapshot?.commands?.find((item) => item.id === entry.commandId);
          const isCurrent = entry.id === current?.id;
          const summary = entry.message || change?.summary || description(entry);
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
                  <span className={`stream-state state-${state}`}>{stateLabel(entry)}</span>
                  <span>
                    <ClockIcon />
                    {new Date(entry.updatedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <h2>{entry.title}</h2>
                {summary && !entry.title.includes(summary) && <p>{summary}</p>}
                {change && (isCurrent || state === "pending") && (
                  <div className="stream-file-summary">
                    {change.files.slice(0, 2).map((item) => (
                      <span key={`${item.operation}:${item.path}`}>
                        <FileTextIcon /> {item.path}
                      </span>
                    ))}
                    {change.files.length > 2 && <span>另有 {change.files.length - 2} 個檔案</span>}
                  </div>
                )}
                {command && (isCurrent || state === "pending") && (
                  <code className="stream-command">{command.argv.join(" ")}</code>
                )}
                {artifactImport && (isCurrent || state === "pending") && (
                  <div className="stream-file-summary">
                    <span>
                      <ImageIcon /> {artifactImport.path}
                    </span>
                  </div>
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
                      aria-label={`查看「${entry.title}」詳情`}
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
