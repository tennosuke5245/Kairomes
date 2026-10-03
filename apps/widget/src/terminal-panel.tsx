import { terminalLabels as labels, type TerminalSession } from "@kairomes/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";
import { currentTerminalSession, terminalActive, terminalSelection } from "./terminal-state.ts";

export function TerminalPanel({
  bridge,
  workspaceId,
  cwd,
  platform,
  visible,
  liveSessions,
  focus,
  readOnly = false,
}: {
  bridge: WorkbenchBridge;
  workspaceId: string;
  cwd: string;
  platform: string;
  visible: boolean;
  liveSessions?: TerminalSession[];
  focus?: { id: string; seq: number };
  readOnly?: boolean;
}) {
  const [listed, setListed] = useState<TerminalSession[]>([]);
  const [polledSession, setPolledSession] = useState<TerminalSession>();
  const [selected, setSelected] = useState(focus?.id ?? "");
  const [shell, setShell] = useState(platform === "win32" ? "powershell" : "bash");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newOutput, setNewOutput] = useState(false);
  const mount = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const current = useRef<TerminalSession | undefined>(undefined);
  const sessions = (liveSessions ?? listed).filter((item) => item.workspace_id === workspaceId);
  const session = currentTerminalSession(
    sessions.find((item) => item.id === selected),
    polledSession,
  );
  const unavailable = !!selected && !session;
  const locked = readOnly || unavailable;
  current.current = locked ? undefined : session;
  const isVisible = useRef(visible);
  isVisible.current = visible;
  const hasLive = liveSessions !== undefined;

  useEffect(() => {
    if (!liveSessions) return;
    const filtered = liveSessions.filter((item) => item.workspace_id === workspaceId);
    setSelected((id) => terminalSelection(filtered, id));
  }, [liveSessions, workspaceId]);

  useEffect(() => {
    if (focus?.id) setSelected(focus.id);
  }, [focus]);

  useEffect(() => {
    if (hasLive) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const data = await bridge.call("terminal_list");
        if (active && data.kind === "terminals") {
          const filtered = data.sessions.filter((item) => item.workspace_id === workspaceId);
          setListed(filtered);
          setSelected((id) => terminalSelection(filtered, id));
        }
      } catch (cause) {
        if (active) setError(String(cause));
      }
      if (active) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [bridge, workspaceId, hasLive]);

  useEffect(() => {
    if (!mount.current) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    Terminal.strings.promptLabel = "終端機輸入";
    Terminal.strings.tooMuchOutput = "輸出過多，請逐行閱讀。";
    const terminal = new Terminal({
      cols: 100,
      rows: 28,
      cursorBlink: !reducedMotion.matches,
      screenReaderMode: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      scrollback: 2000,
      disableStdin: true,
      theme: { background: "#111513", foreground: "#e9ede8", cursor: "#c7e9ae" },
      linkHandler: { activate: () => undefined },
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(mount.current);
    const updateMotion = () => {
      terminal.options.cursorBlink = !reducedMotion.matches;
    };
    reducedMotion.addEventListener("change", updateMotion);
    // Never permit terminal escape sequences to access the browser clipboard.
    const clipboard = terminal.parser.registerOscHandler(52, () => true);
    term.current = terminal;
    fit.current = addon;
    let active = true;
    let queue = Promise.resolve();
    let pending = "";
    let pendingSession = "";
    let inputTimer: ReturnType<typeof setTimeout>;
    let resizeTimer: ReturnType<typeof setTimeout>;
    const input = terminal.onData((data) => {
      const target = current.current;
      if (target?.state !== "running") return;
      if (pendingSession !== target.id) {
        pending = "";
        pendingSession = target.id;
      }
      if (pending.length + data.length > 16384) {
        setError("貼上內容過長，請分段輸入。");
        return;
      }
      pending += data;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        const id = pendingSession;
        const chunks = pending.match(/[\s\S]{1,2048}/gu) ?? [];
        pending = "";
        queue = queue
          .then(async () => {
            for (const chunk of chunks) {
              if (!active || current.current?.id !== id || current.current.state !== "running")
                return;
              await bridge.call("terminal_input", {
                session_id: id,
                data: chunk,
                input_id: crypto.randomUUID(),
              });
            }
          })
          .catch((cause) => {
            if (active) setError(`輸入未確認送達，請先檢查畫面再重送：${String(cause)}`);
          });
      }, 40);
    });
    const resized = terminal.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const target = current.current;
        if (target?.state === "running")
          void bridge
            .call("terminal_resize", {
              session_id: target.id,
              cols: Math.max(20, Math.min(240, cols)),
              rows: Math.max(5, Math.min(100, rows)),
            })
            .catch((cause) => {
              if (active) setError(String(cause));
            });
      }, 150);
    });
    const observer = new ResizeObserver(() => {
      if (mount.current && mount.current.clientWidth > 0) addon.fit();
    });
    observer.observe(mount.current);
    return () => {
      active = false;
      clearTimeout(inputTimer);
      clearTimeout(resizeTimer);
      observer.disconnect();
      reducedMotion.removeEventListener("change", updateMotion);
      input.dispose();
      resized.dispose();
      clipboard.dispose();
      terminal.dispose();
      term.current = null;
      fit.current = null;
    };
  }, [bridge]);

  useEffect(() => {
    if (term.current) term.current.options.disableStdin = locked || session?.state !== "running";
    if (!visible) return;
    fit.current?.fit();
    // A newly selected shell may still have its creation size even when xterm's
    // visible size did not change, so onResize alone is insufficient.
    let active = true;
    if (!locked && session?.state === "running" && term.current)
      void bridge
        .call("terminal_resize", {
          session_id: session.id,
          cols: Math.max(20, Math.min(240, term.current.cols)),
          rows: Math.max(5, Math.min(100, term.current.rows)),
        })
        .catch((cause) => {
          if (active) setError(String(cause));
        });
    return () => {
      active = false;
    };
  }, [bridge, visible, session?.id, session?.state, locked]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    term.current?.reset();
    setNewOutput(false);
    setPolledSession(undefined);
    setError("");
    const poll = async () => {
      let delay = isVisible.current ? 250 : 1000;
      try {
        const data = await bridge.call("terminal_poll", { session_id: selected, cursor });
        if (!active) return;
        if (data.kind !== "terminal" || data.session.id !== selected)
          throw new Error("終端機回應格式不符。");
        setPolledSession((prior) =>
          prior?.id === data.session.id
            ? currentTerminalSession(prior, data.session)
            : data.session,
        );
        if (data.truncated) {
          term.current?.reset();
          setError("較早輸出已不再保留。");
        }
        if (data.output) {
          const buffer = term.current?.buffer.active;
          if (buffer && buffer.viewportY < buffer.baseY) setNewOutput(true);
          await new Promise<void>((resolve) => {
            if (term.current) term.current.write(data.output, resolve);
            else resolve();
          });
        }
        cursor = data.cursor;
        if (data.has_more) delay = 20;
        else if (data.session.state === "pending") delay = 1500;
        else if (!terminalActive(data.session)) return;
      } catch (cause) {
        if (active) setError(String(cause));
        delay = 2500;
      }
      if (active) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [bridge, selected]);

  async function request() {
    if (locked) return;
    setBusy(true);
    setError("");
    try {
      const data = await bridge.call("terminal_start", {
        workspace_id: workspaceId,
        cwd,
        shell,
        cols: 100,
        rows: 28,
      });
      if (data.kind === "terminal") {
        setListed((items) => [
          ...items.filter((item) => item.id !== data.session.id),
          data.session,
        ]);
        setSelected(data.session.id);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (locked || !selected) return;
    try {
      const data = await bridge.call("terminal_stop", { session_id: selected });
      if (data.kind === "terminal") setPolledSession(data.session);
    } catch (cause) {
      setError(String(cause));
    }
  }

  return (
    <section
      className="terminal-panel"
      style={{ display: visible ? "flex" : "none" }}
      aria-label="互動終端機"
    >
      <div className="terminal-toolbar">
        <select
          aria-label="選擇終端機"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setError("");
          }}
        >
          {!sessions.length && !selected && <option value="">尚無工作階段</option>}
          {selected && !session && <option value={selected}>詳情已無法取得</option>}
          {sessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.shell} · {item.id.slice(0, 8)} · {labels[item.state]}
            </option>
          ))}
        </select>
        <select
          aria-label="選擇 Shell"
          value={shell}
          disabled={locked}
          onChange={(event) => setShell(event.target.value)}
        >
          {(platform === "win32" ? ["powershell", "cmd"] : ["bash", "sh"]).map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <button
          type="button"
          className="accent-button"
          disabled={locked || busy}
          onClick={() => void request()}
        >
          {busy ? "建立中…" : "新增終端機"}
        </button>
        <button
          type="button"
          className="text-button terminal-stop"
          disabled={
            locked || !session || !["pending", "starting", "running"].includes(session.state)
          }
          onClick={() => void stop()}
        >
          停止
        </button>
      </div>
      {!locked && ((!selected && !session) || session?.state === "pending") && (
        <div className="terminal-notice">
          <strong>{session ? "等待核准" : `起始位置：${cwd || "/"}`}</strong>
          <p>{session ? "請在原生側欄確認。" : "需核准 15 分鐘；可操作工作區外及連網。"}</p>
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="關閉終端機錯誤" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      <div className="terminal-screen">
        <div className="terminal-mount" ref={mount} />
      </div>
      {newOutput && (
        <button
          type="button"
          className="terminal-new-output"
          onClick={() => {
            term.current?.scrollToBottom();
            setNewOutput(false);
          }}
        >
          有新輸出 · 返回底部
        </button>
      )}
      {(!selected || session) && (
        <div className="terminal-footer">
          <span>HOST PTY · {session ? labels[session.state] : "未啟動"}</span>
          <span>
            {readOnly
              ? "唯讀"
              : session?.state === "running"
                ? `授權至 ${new Date(session.expires_at).toLocaleTimeString()}`
                : session?.exit_code !== null && session?.exit_code !== undefined
                  ? `Exit ${session.exit_code}`
                  : "唯讀"}
          </span>
        </div>
      )}
    </section>
  );
}
