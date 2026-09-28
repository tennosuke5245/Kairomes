import {
  type FileChange,
  type FileChangeResult,
  fileChangeActive,
  fileChangeLabels,
} from "@kairomes/protocol";
import { FileIcon, FilesIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";

function useFileChange(bridge: WorkbenchBridge, id: string) {
  const [result, setResult] = useState<FileChangeResult>();
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let backoff = 1000;
    const poll = async () => {
      try {
        const next = await bridge.call("file_change_poll", { change_id: id });
        if (stopped || next.kind !== "file_change") return;
        setResult(next);
        setError("");
        backoff = 1000;
        if (fileChangeActive(next.change)) timer = setTimeout(() => void poll(), 1000);
      } catch (cause) {
        if (stopped) return;
        setError(cause instanceof Error ? cause.message : "無法讀取檔案變更狀態。");
        timer = setTimeout(() => void poll(), backoff);
        backoff = Math.min(5000, backoff * 2);
      }
    };
    if (id) void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, id]);
  return { result: result?.change.id === id ? result : undefined, error };
}

function StyledDiff({ value }: { value: string }) {
  const occurrences = new Map<string, number>();
  const lines = value.split("\n").map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return { key: `${line}:${occurrence}`, line };
  });
  return (
    <section className="full-diff" aria-label="檔案差異">
      {lines.map(({ key, line }, index) => (
        <div
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "added"
              : line.startsWith("-") && !line.startsWith("---")
                ? "removed"
                : line.startsWith("@@")
                  ? "range"
                  : "context"
          }
          key={key}
        >
          <span>{index + 1}</span>
          <code>{line || " "}</code>
        </div>
      ))}
    </section>
  );
}

const operationLabel = { edit: "修改", write: "寫入", delete: "刪除" } as const;

export function FileChangePanel({
  bridge,
  workspaceId,
  liveChanges,
  focus,
}: {
  bridge: WorkbenchBridge;
  workspaceId: string;
  liveChanges?: FileChange[];
  focus?: { id: string; seq: number };
}) {
  const [listed, setListed] = useState<FileChange[]>([]);
  const [selected, setSelected] = useState(focus?.id ?? "");
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (focus) setSelected(focus.id);
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
        if (!stopped)
          setListError(cause instanceof Error ? cause.message : "無法讀取檔案變更清單。");
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, hasLive]);

  const changes = (liveChanges ?? listed)
    .filter((change) => change.workspace_id === workspaceId)
    .sort((a, b) => b.created_at - a.created_at);
  const selectedChange = changes.find((change) => change.id === selected) ?? changes[0];
  const id = selectedChange?.id ?? "";
  const { result, error } = useFileChange(bridge, id);
  const current = result?.change ?? selectedChange;

  return (
    <section className="file-change-panel" aria-label="檔案變更">
      <div className="file-change-toolbar">
        <select
          aria-label="選擇檔案變更"
          value={id}
          disabled={!changes.length}
          onChange={(event) => {
            setSelected(event.target.value);
            setActionError("");
          }}
        >
          {!changes.length && <option value="">尚無檔案變更</option>}
          {changes.map((change) => (
            <option key={change.id} value={change.id}>
              {change.summary} · {change.id.slice(0, 8)} · {fileChangeLabels[change.state]}
            </option>
          ))}
        </select>
        {current?.state === "pending" && (
          <button
            type="button"
            className="file-change-cancel"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setActionError("");
              try {
                await bridge.call("file_change_cancel", { change_id: current.id });
              } catch (cause) {
                setActionError(
                  cause instanceof Error ? cause.message : "取消結果尚未確認，請等待狀態更新。",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <TrashIcon /> {busy ? "取消中…" : "取消"}
          </button>
        )}
      </div>
      <div className="file-change-content">
        {(listError || actionError || error) && (
          <div className="file-change-error" role="alert">
            <WarningCircleIcon weight="fill" /> {listError || actionError || error}
          </div>
        )}
        {!current ? (
          <div className="file-change-empty">
            <FilesIcon />
            <h2>尚無檔案變更</h2>
            <p>ChatGPT 提出變更後會顯示在這裡。</p>
          </div>
        ) : (
          <>
            <div className="file-change-hero">
              <span className={`change-status state-${current.state}`}>
                {fileChangeLabels[current.state]}
              </span>
              <h2>{current.summary}</h2>
              <p>
                {current.files.length} 個檔案
                {current.applied_at
                  ? ` · ${new Date(current.applied_at).toLocaleTimeString()} 套用`
                  : ""}
              </p>
            </div>
            <section className="file-change-section">
              <h3>檔案</h3>
              <div className="file-change-files">
                {current.files.map((file) => (
                  <div key={file.path}>
                    <FileIcon />
                    <span>{file.path}</span>
                    <small>{operationLabel[file.operation]}</small>
                  </div>
                ))}
              </div>
            </section>
            {current.message && <p className="file-change-error">{current.message}</p>}
            <section className="file-change-section">
              <h3>差異</h3>
              <StyledDiff value={result?.diff || "正在取得差異…"} />
              {result?.diff_truncated && <p>顯示內容已達上限；核准卡會標示截斷。</p>}
            </section>
            {current.state === "pending" && (
              <p className="file-change-footnote">
                核准時會再次比對版本；檔案若已改變，整批變更會停止。
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
