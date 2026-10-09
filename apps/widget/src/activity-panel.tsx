import {
  type ActivityEntry,
  type ActivitySnapshot,
  artifactImportAwaitingDecision,
} from "@kairomes/protocol";
import {
  ArrowUpIcon,
  ChatCircleDotsIcon,
  FolderIcon,
  FunnelSimpleIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PencilSimpleIcon,
  TrayIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import {
  ACTIVITY_FILTERS,
  type ActivityFilter,
  activityFilterCounts,
  filterActivity,
  visibleActivity,
} from "./activity-model.ts";
import type { WorkbenchBridge } from "./bridge.ts";
import {
  isEditableTarget,
  liveStatus,
  timelineScrollPauses,
  workbenchShortcut,
} from "./follow-model.ts";
import { RowBody, useRovingList } from "./record-list.tsx";
import { groupByTime } from "./time-format.ts";
import {
  newActivityLabel,
  TIMELINE_PAGE,
  ticksEverySecond,
  timelineRow,
} from "./timeline-model.ts";
import { iconProps } from "./ui-icons.tsx";
import { useNow } from "./use-now.ts";

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

export function ActivityPanel({
  snapshot,
  error,
  emptyWorkspace,
  following,
  unread = 0,
  onResume,
  onSelect,
  onFiles,
  onSearch,
  onChanges,
  changeCount = 0,
  onReadingScroll,
  onToggleFollow,
  workspaceName,
  workspaceId,
  nativeControls = false,
  currentId,
  now: fixedNow,
  defaultFilter = "all",
}: {
  snapshot?: ActivitySnapshot;
  error: string;
  emptyWorkspace: boolean;
  following: boolean;
  /** New focus-worthy entries since following paused (unfiltered list). */
  unread?: number;
  onResume(): void;
  onSelect(entry: ActivityEntry): void;
  onFiles?(): void;
  onSearch?(): void;
  /** 變更 N (C2): opens the session change summary; hidden while nothing changed. */
  onChanges?(): void;
  changeCount?: number;
  /** Scrolling the timeline away from the top is reading; the workbench pauses following. */
  onReadingScroll?(): void;
  /** `f` inside the timeline pauses following (resuming goes through onResume). */
  onToggleFollow?(): void;
  workspaceName(id?: string): string;
  workspaceId?: string | null;
  nativeControls?: boolean;
  /** The entry shown in the inspector, marked with aria-current. */
  currentId?: string;
  /** Fixed clock for static rendering in tests. */
  now?: number;
  defaultFilter?: ActivityFilter;
}) {
  const [filter, setFilter] = useState<ActivityFilter>(defaultFilter);
  const scope = `${filter}:${workspaceId ?? ""}`;
  const [paging, setPaging] = useState({ scope, limit: TIMELINE_PAGE });
  const limit = paging.scope === scope ? paging.limit : TIMELINE_PAGE;
  const list = useRef<HTMLDivElement>(null);
  const visible = visibleActivity(snapshot, workspaceId);
  const counts = activityFilterCounts(visible);
  const matching = filterActivity(visible, filter);
  const page = matching.slice(0, limit);
  const now = useNow(ticksEverySecond(page, snapshot), fixedNow);
  const rows = page.map((entry) =>
    timelineRow(entry, {
      snapshot,
      now,
      workspaceName: workspaceId ? undefined : (id) => workspaceName(id),
    }),
  );
  const groups = groupByTime(rows, (row) => row.entry.updatedAt, now);
  const pending = [
    ...(snapshot?.imports ?? []),
    ...(snapshot?.changes ?? []),
    ...(snapshot?.sessions ?? []),
    ...(snapshot?.commands ?? []),
  ].filter(
    (item) =>
      // Same 需確認 as the side panel: an image import waiting for its image counts too.
      (item.state === "pending" ||
        ("source_file_id" in item && artifactImportAwaitingDecision(item))) &&
      (!workspaceId || item.workspace_id === workspaceId),
  ).length;
  const live = liveStatus(following);
  const titleId = useId();
  const rovingKeys = useRovingList(list);

  function chooseFilter(next: ActivityFilter) {
    setFilter(next);
    list.current?.scrollTo?.({ top: 0 });
  }

  function resume() {
    onResume();
    list.current?.scrollTo?.({ top: 0 });
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(".k-row")?.focus());
  }

  return (
    <section
      className="wb-timeline"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        rovingKeys(event);
        if (event.defaultPrevented) return;
        const shortcut = workbenchShortcut(
          {
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            editable: isEditableTarget(event.target as Element | null),
          },
          { detailOpen: false },
        );
        if (shortcut !== "toggle-follow" || !onToggleFollow) return;
        event.preventDefault();
        // Resuming takes the same path as the 回到最新 pill: back to the top of the list, so
        // the next small scroll does not read as reading again.
        if (following) onToggleFollow();
        else resume();
      }}
    >
      <div className="wb-bar">
        <h1 id={titleId} className="k-toolbar__title wb-title">
          動態
        </h1>
        <span className="k-live" data-state={live.state} role="status">
          {following ? (
            <span className="k-dot" data-pulse="" />
          ) : (
            <PauseIcon {...iconProps("sm")} weight="fill" />
          )}
          {live.label}
        </span>
        <div className="wb-bar__actions">
          {onChanges && changeCount > 0 && (
            // Changed files, not change entries: the 變更 chip below counts those.
            <button
              type="button"
              className="k-btn k-btn--quiet k-btn--sm wb-changes"
              aria-label={`本次變更的 ${changeCount} 個檔案`}
              title="本次變更的檔案"
              onClick={onChanges}
            >
              <PencilSimpleIcon {...iconProps("md")} />
              {changeCount} 個檔案
            </button>
          )}
          {onSearch && (
            <button
              type="button"
              className="k-btn k-btn--quiet k-btn--icon"
              aria-label="搜尋專案內容"
              title="搜尋專案內容"
              onClick={onSearch}
            >
              <MagnifyingGlassIcon {...iconProps("lg")} />
            </button>
          )}
          {onFiles && (
            <button
              type="button"
              className="k-btn k-btn--quiet k-btn--icon"
              aria-label="檔案"
              title="檔案"
              onClick={onFiles}
            >
              <FolderIcon {...iconProps("lg")} />
            </button>
          )}
        </div>
      </div>
      {visible.length > 0 && (
        <fieldset className="wb-chips k-chips">
          <legend className="k-sr-only">篩選動態</legend>
          {ACTIVITY_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className="k-chip"
              aria-pressed={filter === id}
              data-tone={id === "failed" ? "danger" : undefined}
              onClick={() => chooseFilter(id)}
            >
              {label}
              {id !== "all" && counts[id] > 0 && (
                <span className="k-chip__count">{counts[id]}</span>
              )}
            </button>
          ))}
        </fieldset>
      )}
      <span className="k-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {!following && unread > 0 ? `有 ${unread} 則新動態` : ""}
      </span>
      <div
        ref={list}
        className="wb-list"
        onScroll={(event) => {
          if (timelineScrollPauses(event.currentTarget.scrollTop)) onReadingScroll?.();
        }}
      >
        {!following && unread > 0 && (
          <button type="button" className="k-newpill" onClick={resume}>
            <ArrowUpIcon {...iconProps("md")} />
            {newActivityLabel(unread)}
          </button>
        )}
        {error && (
          <div className="k-notice wb-notice" data-tone="danger" role="alert">
            <WarningCircleIcon {...iconProps("lg")} />
            <span className="k-notice__body">{error}</span>
          </div>
        )}
        {pending > 0 && !nativeControls && (
          <div className="k-notice wb-notice" data-tone="brand" role="status">
            <TrayIcon {...iconProps("lg")} />
            <span className="k-notice__body">
              <span className="k-notice__title">{pending} 件需確認</span> · 請在側欄審核
            </span>
          </div>
        )}
        {emptyWorkspace && visible.length > 0 && (
          <p className="k-notice wb-notice" role="status">
            <FolderIcon {...iconProps("lg")} />
            <span className="k-notice__body">尚未加入專案，請在 Kairomes Desktop 加入資料夾。</span>
          </p>
        )}
        {!visible.length ? (
          <div className="k-empty wb-empty">
            <span className="k-empty__icon" aria-hidden="true">
              {emptyWorkspace ? (
                <FolderIcon {...iconProps("xl")} />
              ) : (
                <ChatCircleDotsIcon {...iconProps("xl")} />
              )}
            </span>
            <h2 className="k-empty__title">
              {emptyWorkspace ? "還沒有專案" : workspaceId ? "這個專案還沒有動態" : "還沒有動態"}
            </h2>
            <p className="k-empty__text">
              {emptyWorkspace
                ? "在 Kairomes Desktop 加入一個資料夾，ChatGPT 才能讀取。"
                : "ChatGPT 讀取或修改專案時會列在這裡。"}
            </p>
          </div>
        ) : !matching.length ? (
          <div className="k-empty wb-empty">
            <span className="k-empty__icon" aria-hidden="true">
              <FunnelSimpleIcon {...iconProps("xl")} />
            </span>
            <h2 className="k-empty__title">沒有符合的動態</h2>
            <button
              type="button"
              className="k-btn k-btn--secondary"
              onClick={() => chooseFilter("all")}
            >
              顯示全部
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.group} className="wb-group" aria-label={group.label}>
              <h2 className="k-group-label">{group.label}</h2>
              <ul className="k-list k-card">
                {group.items.map((item) => {
                  // Under 剛剛 a row's own 剛剛 would only repeat the label.
                  const row = item.time === group.label ? { ...item, time: "" } : item;
                  return (
                    <li key={row.entry.id}>
                      {row.actionable ? (
                        <button
                          type="button"
                          className="k-row"
                          aria-current={row.entry.id === currentId ? "true" : undefined}
                          data-activity-id={row.entry.id}
                          data-roving-item=""
                          onClick={() => onSelect(row.entry)}
                        >
                          <RowBody row={row} />
                        </button>
                      ) : (
                        <div className="k-row" data-static="">
                          <RowBody row={row} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
        {matching.length > page.length && (
          <button
            type="button"
            className="k-btn k-btn--secondary wb-more"
            onClick={() =>
              setPaging({ scope, limit: Math.min(matching.length, limit + TIMELINE_PAGE) })
            }
          >
            顯示更早
          </button>
        )}
      </div>
    </section>
  );
}
