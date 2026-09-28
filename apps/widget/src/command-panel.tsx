import { type Command, type CommandResult, commandActive, commandLabels } from "@kairomes/protocol";
import { useEffect, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";

export function useCommandOutput(bridge: WorkbenchBridge, id: string, limit = 65536) {
  const [result, setResult] = useState<CommandResult>();
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let out = 0,
      err = 0,
      stdout = "",
      stderr = "";
    let clippedOut = false,
      clippedErr = false,
      backoff = 1000;
    setResult(undefined);
    setError("");
    const tail = (text: string) => {
      const cut = Math.max(0, text.length - limit);
      const first = text.charCodeAt(cut);
      return text.slice(cut + (first >= 0xdc00 && first <= 0xdfff ? 1 : 0));
    };
    const poll = async () => {
      try {
        const next = await bridge.call("command_poll", {
          command_id: id,
          stdout_cursor: out,
          stderr_cursor: err,
        });
        if (stopped) return;
        if (next.kind !== "command") throw new Error("命令回應格式不符。");
        out = next.stdout_cursor;
        err = next.stderr_cursor;
        clippedOut ||= next.stdout_truncated || stdout.length + next.stdout.length > limit;
        clippedErr ||= next.stderr_truncated || stderr.length + next.stderr.length > limit;
        stdout = tail(stdout + next.stdout);
        stderr = tail(stderr + next.stderr);
        setResult({
          ...next,
          stdout,
          stderr,
          stdout_truncated: clippedOut,
          stderr_truncated: clippedErr,
        });
        setError("");
        backoff = 1000;
        if (next.has_more || !next.output_complete)
          timer = setTimeout(() => void poll(), next.has_more ? 50 : 750);
      } catch (cause) {
        if (stopped) return;
        setError(cause instanceof Error ? cause.message : "無法讀取命令結果。");
        timer = setTimeout(() => void poll(), backoff);
        backoff = Math.min(5000, backoff * 2);
      }
    };
    if (id) void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, id, limit]);
  return { result: result?.command.id === id ? result : undefined, error };
}

export function CommandOutput({ result, error }: { result?: CommandResult; error: string }) {
  const hasStdout = Boolean(result?.stdout || result?.stdout_truncated);
  const hasStderr = Boolean(result?.stderr || result?.stderr_truncated);
  return (
    <>
      {error && <p role="alert">{error} 正在重試讀取，命令不會重跑。</p>}
      {result?.command.message && <p role="status">{result.command.message}</p>}
      {!hasStdout && !hasStderr && result?.command.state !== "pending" && (
        <p className="muted">{result ? "沒有輸出。" : "正在讀取輸出…"}</p>
      )}
      {hasStdout && (
        <section aria-label="標準輸出">
          <h3>輸出</h3>
          {result?.stdout_truncated && <p className="muted">僅顯示最近輸出。</p>}
          <pre className="command-output">{result?.stdout || " "}</pre>
        </section>
      )}
      {hasStderr && (
        <section aria-label="錯誤輸出">
          <h3>錯誤輸出</h3>
          {result?.stderr_truncated && <p className="muted">僅顯示最近錯誤輸出。</p>}
          <pre className="command-output command-stderr">{result?.stderr || " "}</pre>
        </section>
      )}
    </>
  );
}

export function CommandPanel({
  bridge,
  workspaceId,
  liveCommands,
  focus,
}: {
  bridge: WorkbenchBridge;
  workspaceId: string;
  liveCommands?: Command[];
  focus?: { id: string; seq: number };
}) {
  const [listed, setListed] = useState<Command[]>([]);
  const [selected, setSelected] = useState(focus?.id ?? "");
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (focus) setSelected(focus.id);
  }, [focus]);
  const hasLive = liveCommands !== undefined;
  useEffect(() => {
    if (hasLive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await bridge.call("command_list");
        if (stopped) return;
        if (data.kind === "commands") setListed(data.commands);
        setListError("");
      } catch (cause) {
        if (!stopped) setListError(cause instanceof Error ? cause.message : "無法讀取命令清單。");
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, hasLive]);
  const commands = (liveCommands ?? listed)
    .filter((c) => c.workspace_id === workspaceId)
    .sort((a, b) => b.created_at - a.created_at);
  const selectedCommand = commands.find((c) => c.id === selected) ?? commands[0];
  const id = selectedCommand?.id ?? "";
  const { result, error } = useCommandOutput(bridge, id);
  // A final SSE snapshot can arrive before the next output page. Never briefly
  // show "waiting for approval" again after cancellation has been confirmed.
  const current =
    selectedCommand && !commandActive(selectedCommand)
      ? selectedCommand
      : (result?.command ?? selectedCommand);
  return (
    <section className="command-panel" aria-label="一次性命令">
      <div className="command-toolbar">
        <select
          aria-label="選擇命令"
          value={id}
          disabled={!commands.length}
          onChange={(e) => {
            setSelected(e.target.value);
            setActionError("");
          }}
        >
          {!commands.length && <option value="">尚無命令</option>}
          {commands.map((c) => (
            <option key={c.id} value={c.id}>
              {c.argv[0]} · {c.id.slice(0, 8)} · {commandLabels[c.state]}
            </option>
          ))}
        </select>
        {current && commandActive(current) && (
          <button
            type="button"
            className="text-button danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setActionError("");
              try {
                await bridge.call("command_cancel", { command_id: id });
              } catch (cause) {
                setActionError(
                  cause instanceof Error ? cause.message : "取消結果尚未確認，請等待狀態更新。",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "取消中…" : "取消命令"}
          </button>
        )}
      </div>
      <div className="command-content">
        {(listError || actionError) && <p role="alert">{listError || actionError}</p>}
        {!current ? (
          <>
            <h2>尚無命令</h2>
            <p>ChatGPT 執行命令時，結果會顯示在這裡。</p>
          </>
        ) : (
          <>
            <h2 role="status">
              {commandLabels[current.state]}
              {current.exit_code !== null ? ` · Exit ${current.exit_code}` : ""}
            </h2>
            <p className="muted">
              起始位置：{current.cwd || "工作區根目錄"} · 最多 {current.timeout_ms / 1000} 秒
              {current.started_at && current.ended_at
                ? ` · 耗時 ${((current.ended_at - current.started_at) / 1000).toFixed(2)} 秒`
                : ""}
            </p>
            <pre className="command-argv">{JSON.stringify(current.argv, null, 2)}</pre>
            {current.state === "pending" && (
              <p className="pending-indicator">請在側欄核准；未配對時可使用本機審批頁。</p>
            )}
            <CommandOutput result={result} error={error} />
            <p className="muted">請以結束碼判斷結果；取消不會復原已執行的動作。</p>
          </>
        )}
      </div>
    </section>
  );
}
