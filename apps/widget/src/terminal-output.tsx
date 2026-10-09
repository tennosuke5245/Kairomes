import type { TerminalResult, TerminalSession } from "@kairomes/protocol";
import { useEffect, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";
import { tailText } from "./command-model.ts";
import { StatusLine } from "./detail-parts.tsx";
import { friendlyError } from "./errors.ts";
import { DONE_TAIL, LIVE_TAIL, OutputView } from "./output-view.tsx";
import { terminalActive } from "./terminal-state.ts";

/** Keeps the newest output, cut at a line start; clipped once anything was dropped. */
export function appendTerminalText(
  previous: { text: string; clipped: boolean },
  next: TerminalResult,
  limit = 4000,
) {
  const tail = tailText((next.truncated ? "" : previous.text) + next.text, limit);
  return { text: tail.text, clipped: previous.clipped || next.truncated || tail.cut };
}

export function terminalOutputEvidence(result?: TerminalResult, clipped = false, failed = false) {
  if (failed) return "輸出待確認";
  if (!result) return "讀取輸出…";
  if (result.has_more) return "輸出尚未讀完";
  if (clipped || result.truncated) return "輸出部分保留";
  if (result.session.state === "pending") return "尚未執行";
  return terminalActive(result.session) ? "輸出持續更新" : "輸出已讀完";
}

export function TerminalOutput({
  result,
  error = "",
  clipped = false,
}: {
  result?: TerminalResult;
  error?: string;
  clipped?: boolean;
}) {
  const running = !!result && terminalActive(result.session);
  return (
    <>
      {error && (
        <p className="k-notice" data-tone="danger" role="alert">
          <span className="k-notice__body">{error}</span>
        </p>
      )}
      {!result ? (
        !error && <StatusLine>正在讀取輸出…</StatusLine>
      ) : result.session.state === "pending" ? null : (
        <OutputView
          stdout={result.text}
          stderr=""
          tail={running ? LIVE_TAIL : DONE_TAIL}
          status={terminalOutputEvidence(result, clipped, !!error)}
          numbered={!clipped && !result.truncated}
          empty="尚無輸出。"
        />
      )}
    </>
  );
}

export function TerminalOutputPreview({
  bridge,
  session,
}: {
  bridge: WorkbenchBridge;
  session: TerminalSession;
}) {
  const [preview, setPreview] = useState<{ result: TerminalResult; clipped: boolean }>();
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  useEffect(() => {
    let stopped = false;
    let cursor = 0;
    let captured = { text: "", clipped: false };
    let timer: ReturnType<typeof setTimeout>;
    setPreview(undefined);
    setFailure(undefined);
    const poll = async () => {
      try {
        const data = await bridge.call("terminal_poll", { session_id: session.id, cursor });
        if (stopped) return;
        if (data.kind !== "terminal" || data.session.id !== session.id)
          throw new Error("終端機回應格式不符。");
        cursor = data.cursor;
        captured = appendTerminalText(captured, data);
        setPreview({ result: { ...data, text: captured.text }, clipped: captured.clipped });
        setFailure(undefined);
        if (data.has_more || terminalActive(data.session))
          timer = setTimeout(() => void poll(), data.has_more ? 100 : 1500);
      } catch (cause) {
        if (!stopped)
          setFailure({
            id: session.id,
            message: friendlyError(cause, "無法取得輸出。"),
          });
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, session.id]);
  const current = preview?.result.session.id === session.id ? preview : undefined;
  return (
    <TerminalOutput
      result={current?.result}
      clipped={current?.clipped}
      error={failure?.id === session.id ? failure.message : ""}
    />
  );
}
