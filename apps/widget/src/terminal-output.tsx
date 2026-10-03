import type { TerminalResult, TerminalSession } from "@kairomes/protocol";
import { useEffect, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";
import { terminalActive } from "./terminal-state.ts";

export function appendTerminalText(
  previous: { text: string; clipped: boolean },
  next: TerminalResult,
  limit = 4000,
) {
  const text = (next.truncated ? "" : previous.text) + next.text;
  let cut = Math.max(0, text.length - limit);
  const first = text.charCodeAt(cut);
  if (first >= 0xdc00 && first <= 0xdfff) cut++;
  return { text: text.slice(cut), clipped: previous.clipped || next.truncated || cut > 0 };
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
  return (
    <>
      {result?.session.state !== "pending" && (
        <p className="result-evidence" role="status">
          {terminalOutputEvidence(result, clipped, !!error)}
        </p>
      )}
      {error && (
        <p className="inspector-error" role="alert">
          {error}
        </p>
      )}
      <pre className="output-preview">{result?.text || (result ? "尚無輸出。" : " ")}</pre>
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
            message: cause instanceof Error ? cause.message : "無法取得輸出。",
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
