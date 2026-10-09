import { type FileChange, type FileChangeResult, fileChangeActive } from "@kairomes/protocol";
import { toneFor } from "@kairomes/protocol/ui-state";
import { PencilSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";
import { summarizeChanges } from "./change-summary.ts";
import type { Fact } from "./command-model.ts";
import {
  FactsStrip,
  InspectorHead,
  PendingNotice,
  StatusLine,
  TechDetails,
  WorkspaceTag,
} from "./detail-parts.tsx";
import { diffCounts, parseChangeDiff } from "./diff-model.ts";
import { DiffView } from "./diff-view.tsx";
import { friendlyError } from "./errors.ts";
import { RecordList, type SubBack, SubBar, useListReturn } from "./record-list.tsx";
import { changeReason } from "./record-model.ts";
import { requireFileChangeResult } from "./result-identity.ts";
import { clockTime, countdown, relativeTime } from "./time-format.ts";
import { workspaceHue } from "./timeline-model.ts";
import { ResultError } from "./tool-result.ts";
import { iconProps } from "./ui-icons.tsx";
import { useNow } from "./use-now.ts";

function useFileChange(bridge: WorkbenchBridge, id: string, workspaceId: string) {
  const identity = `${workspaceId}:${id}`;
  const [state, setState] = useState<{
    identity: string;
    result?: FileChangeResult;
    error: string;
  }>({ identity, error: "" });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let backoff = 1000;
    setState({ identity, error: "" });
    const poll = async () => {
      try {
        const data = await bridge.call("file_change_poll", { change_id: id });
        if (stopped) return;
        const next = requireFileChangeResult(data, { id, workspaceId });
        setState({ identity, result: next, error: "" });
        backoff = 1000;
        if (fileChangeActive(next.change)) timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (stopped) return;
        setState((previous) => ({
          identity,
          result: previous.identity === identity ? previous.result : undefined,
          error: friendlyError(cause, "無法讀取檔案變更狀態。"),
        }));
        if (cause instanceof ResultError && cause.code === "FILE_CHANGE_NOT_FOUND") return;
        timer = setTimeout(() => void poll(), backoff);
        backoff = Math.min(5000, backoff * 2);
      }
    };
    if (id) void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, id, workspaceId, identity]);
  return state.identity === identity
    ? { result: state.result, error: state.error }
    : { result: undefined, error: "" };
}

export function currentFileChange(selected?: FileChange, result?: FileChangeResult) {
  if (!selected) return;
  // Terminal SSE is authoritative even while an older poll response is in flight.
  if (!fileChangeActive(selected)) return selected;
  return result?.change.id === selected.id ? result.change : selected;
}

const shortVersion = (version: string | null) => (version ? version.slice(0, 12) : "不存在");

/**
 * 檔案 N, +A −D once the diff is loaded (至少 +A −D when it was cut), then the review deadline
 * or the applied time.
 */
export function changeFacts(
  change: FileChange,
  diff: { additions: number; deletions: number; truncated?: boolean } | undefined,
  now: number,
): Fact[] {
  const facts: Fact[] = [{ label: "檔案", value: `${change.files.length} 個` }];
  if (diff) facts.push({ label: "差異", value: diffCounts(diff), mono: true });
  if (change.state === "pending") {
    const left = countdown(change.expires_at, now);
    facts.push({ label: "審核期限", value: left.text, tone: left.urgency ? "warning" : undefined });
  } else if (change.applied_at !== null)
    facts.push({ label: "套用時間", value: clockTime(change.applied_at) });
  return facts;
}

function ChangeDetail({
  change,
  result,
  error,
  now,
  workspaceName,
  actionError,
  cancelBusy,
  onCancel,
  focusPath,
}: {
  change: FileChange;
  /** The file chosen in the 變更 list: the diff opens at its section. */
  focusPath?: string;
  result?: FileChangeResult;
  error: string;
  now: number;
  workspaceName?: (id: string) => string | undefined;
  actionError: string;
  cancelBusy: boolean;
  /** Cancel is the only negative action the workbench offers for a change. */
  onCancel?(): void;
}) {
  const workspace = workspaceName?.(change.workspace_id);
  const state = toneFor("file_change", change.state);
  const reason = changeReason(change);
  const parsed = useMemo(
    () => (result?.diff ? parseChangeDiff(result.diff, result.diff_truncated) : undefined),
    [result?.diff, result?.diff_truncated],
  );
  return (
    <>
      <InspectorHead
        icon="change"
        verb={change.summary || `修改 ${change.files.length} 個檔案`}
        state={state}
        meta={[
          workspace && <WorkspaceTag name={workspace} hue={workspaceHue(change.workspace_id)} />,
          relativeTime(change.applied_at ?? change.created_at, now),
        ]}
        actions={
          onCancel && (
            <button
              type="button"
              className="k-btn k-btn--danger-quiet k-btn--sm"
              disabled={cancelBusy}
              onClick={onCancel}
            >
              {cancelBusy ? "取消中…" : "取消變更"}
            </button>
          )
        }
      />
      <div className="insp-body">
        {(actionError || error) && (
          <p className="k-notice" data-tone="danger" role="alert">
            <WarningCircleIcon {...iconProps("lg")} />
            <span className="k-notice__body">{actionError || error}</span>
          </p>
        )}
        {change.state === "pending" && (
          <>
            <PendingNotice />
            <p className="insp-note">套用前核對檔案版本；檔案已變動就停止，不會覆寫。</p>
          </>
        )}
        {reason && (
          <p className="insp-reason" data-tone={state.dataTone}>
            {reason}
          </p>
        )}
        <FactsStrip facts={changeFacts(change, parsed, now)} />
        {result ? (
          result.diff ? (
            <DiffView
              diff={result.diff}
              truncated={result.diff_truncated}
              totals={false}
              focusPath={focusPath}
            />
          ) : (
            <StatusLine>沒有可顯示的差異。</StatusLine>
          )
        ) : (
          !error && <StatusLine>正在取得差異…</StatusLine>
        )}
        <TechDetails
          rows={[
            ["變更編號", change.id],
            ...change.files.map((file): [string, string] => [
              file.path,
              `${shortVersion(file.before_version)} → ${shortVersion(file.after_version)}`,
            ]),
          ]}
        />
      </div>
    </>
  );
}

export function FileChangePanel({
  bridge,
  workspaceId,
  liveChanges,
  focus,
  workspaceName,
  onSubBack,
}: {
  bridge: WorkbenchBridge;
  /** Scope of the 變更 list; null lists every project (rows then carry a workspace tag). */
  workspaceId: string | null;
  liveChanges?: FileChange[];
  /** An empty id opens the list (C2 summary); any other id opens that change. */
  focus?: { id: string; seq: number };
  workspaceName?: (id: string) => string | undefined;
  /** The workbench heading takes over the way back to 全部變更. */
  onSubBack?(value: SubBack | undefined): void;
}) {
  const [listed, setListed] = useState<FileChange[]>([]);
  const [selected, setSelected] = useState(focus?.id ?? "");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [listMode, setListMode] = useState(!focus?.id);
  const [fromList, setFromList] = useState(false);
  const listReturn = useListReturn({
    open: fromList && !listMode,
    label: "返回全部變更",
    back: () => setListMode(true),
    onSubBack,
  });
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState({ id: "", message: "" });
  const [busyId, setBusyId] = useState("");
  useEffect(() => {
    if (!focus) return;
    setSelected(focus.id);
    setSelectedPath(undefined);
    setListMode(!focus.id);
    setFromList(false);
  }, [focus]);
  const hasLive = liveChanges !== undefined;
  useEffect(() => {
    if (hasLive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await bridge.call("file_change_list");
        if (stopped) return;
        if (data.kind === "file_changes") setListed(data.changes);
        setListError("");
      } catch (cause) {
        if (!stopped) setListError(friendlyError(cause, "無法讀取檔案變更清單。"));
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, hasLive]);

  const all = liveChanges ?? listed;
  const selectedChange = selected ? all.find((change) => change.id === selected) : undefined;
  const id = listMode ? "" : (selectedChange?.id ?? "");
  const currentActionError = actionError.id === id ? actionError.message : "";
  const { result, error } = useFileChange(bridge, id, selectedChange?.workspace_id ?? "");
  const current = currentFileChange(selectedChange, result);
  const rows = summarizeChanges(all, workspaceId);
  const now = useNow(!listMode && current?.state === "pending");
  const cancel = async () => {
    if (!current) return;
    setBusyId(current.id);
    setActionError({ id: current.id, message: "" });
    try {
      await bridge.call("file_change_cancel", { change_id: current.id });
    } catch (cause) {
      setActionError({
        id: current.id,
        message: friendlyError(cause, "取消結果尚未確認，請等待狀態更新。"),
      });
    } finally {
      setBusyId("");
    }
  };

  return (
    <section ref={listReturn.container} className="wb-panel" aria-label="檔案變更">
      {listError && (
        <p className="k-notice wb-panel__notice" data-tone="danger" role="alert">
          <WarningCircleIcon {...iconProps("lg")} />
          <span className="k-notice__body">{listError}</span>
        </p>
      )}
      {listMode ? (
        <div className="insp-body">
          {rows.length ? (
            <RecordList
              label="本次變更"
              items={rows.map((row) => ({
                id: row.key,
                row: {
                  icon: "change",
                  verb: "",
                  code: row.name,
                  title: row.path,
                  directory: row.directory || undefined,
                  state: row.state,
                  time: relativeTime(row.updatedAt, now),
                  workspace:
                    !workspaceId && workspaceName?.(row.workspaceId)
                      ? {
                          id: row.workspaceId,
                          name: workspaceName(row.workspaceId) ?? "",
                          hue: workspaceHue(row.workspaceId),
                        }
                      : undefined,
                  meta: {
                    kind: "files",
                    text: row.changes > 1 ? `${row.operation} · ${row.changes} 次` : row.operation,
                  },
                },
              }))}
              currentId={rows.find((row) => row.changeId === selected)?.key}
              onOpen={(key) => {
                const row = rows.find((item) => item.key === key);
                if (!row) return;
                listReturn.opened(key);
                setSelected(row.changeId);
                setSelectedPath(row.path);
                setListMode(false);
                setFromList(true);
                setActionError({ id: row.changeId, message: "" });
              }}
            />
          ) : (
            <div className="k-empty wb-empty">
              <span className="k-empty__icon" aria-hidden="true">
                <PencilSimpleIcon {...iconProps("xl")} />
              </span>
              <h3 className="k-empty__title">還沒有變更</h3>
              <p className="k-empty__text">ChatGPT 要修改檔案時會列在這裡。</p>
            </div>
          )}
        </div>
      ) : (
        <>
          {listReturn.subBar && <SubBar {...listReturn.subBar} />}
          {!current ? (
            <div className="insp-body">
              <StatusLine>變更詳情已無法取得。</StatusLine>
            </div>
          ) : (
            <ChangeDetail
              change={current}
              result={result?.change.id === current.id ? result : undefined}
              error={error}
              now={now}
              workspaceName={workspaceName}
              actionError={currentActionError}
              cancelBusy={!!busyId}
              onCancel={current.state === "pending" ? () => void cancel() : undefined}
              focusPath={selectedPath}
            />
          )}
        </>
      )}
    </section>
  );
}
