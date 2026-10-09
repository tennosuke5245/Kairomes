import type { TerminalSession } from "@kairomes/protocol";
import { toneFor } from "@kairomes/protocol/ui-state";
import {
  ArrowDownIcon,
  DesktopIcon,
  GlobeIcon,
  InfoIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useId, useRef, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";
import { cwdLabel, terminalFooter, workspaceCwd } from "./command-model.ts";
import {
  CwdMeta,
  InspectorHead,
  PendingNotice,
  StatusLine,
  WorkspaceTag,
} from "./detail-parts.tsx";
import { friendlyError } from "./errors.ts";
import { RecordList, type SubBack, SubBar, useListReturn } from "./record-list.tsx";
import { terminalRecord } from "./record-model.ts";
import { currentTerminalSession, terminalActive, terminalSelection } from "./terminal-state.ts";
import { tokenTerminalTheme } from "./terminal-theme.ts";
import { openedTime } from "./time-format.ts";
import { workspaceHue } from "./timeline-model.ts";
import { iconProps } from "./ui-icons.tsx";
import { useNow } from "./use-now.ts";

export function TerminalPanel({
  bridge,
  workspaceId,
  cwd,
  platform,
  visible,
  liveSessions,
  focus,
  readOnly = false,
  workspaceName,
  onSubBack,
}: {
  bridge: WorkbenchBridge;
  workspaceId: string;
  cwd: string;
  platform: string;
  visible: boolean;
  liveSessions?: TerminalSession[];
  /** An empty id opens the list; any other id opens that terminal. */
  focus?: { id: string; seq: number };
  readOnly?: boolean;
  workspaceName?: (id: string) => string | undefined;
  /** The workbench heading takes over the way back to 全部終端機. */
  onSubBack?(value: SubBack | undefined): void;
}) {
  const [listed, setListed] = useState<TerminalSession[]>([]);
  const [polledSession, setPolledSession] = useState<TerminalSession>();
  const [selected, setSelected] = useState(focus?.id ?? "");
  const [listMode, setListMode] = useState(!focus?.id);
  const [fromList, setFromList] = useState(false);
  const listReturn = useListReturn({
    open: fromList && !listMode,
    label: "返回全部終端機",
    back: () => setListMode(true),
    onSubBack,
  });
  const [shell, setShell] = useState(platform === "win32" ? "powershell" : "bash");
  const [error, setError] = useState("");
  /** Information about the output itself (older lines dropped), not a failure. */
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [newOutput, setNewOutput] = useState(false);
  /** The terminal whose first terminal_poll has answered; until then the screen is empty. */
  const [polledId, setPolledId] = useState("");
  const mount = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const current = useRef<TerminalSession | undefined>(undefined);
  const shellId = useId();
  const sessions = (liveSessions ?? listed).filter((item) => item.workspace_id === workspaceId);
  const session = currentTerminalSession(
    sessions.find((item) => item.id === selected),
    polledSession,
  );
  // The terminal on screen; the list polls nothing.
  const shown = listMode ? "" : selected;
  const unavailable = !!shown && !session;
  const locked = readOnly || unavailable;
  current.current = locked || listMode ? undefined : session;
  const screenVisible = visible && !listMode && !!session;
  const isVisible = useRef(screenVisible);
  isVisible.current = screenVisible;
  const hasLive = liveSessions !== undefined;
  const now = useNow(sessions.some((item) => item.state === "pending"));

  useEffect(() => {
    if (!liveSessions) return;
    const filtered = liveSessions.filter((item) => item.workspace_id === workspaceId);
    setSelected((id) => terminalSelection(filtered, id));
  }, [liveSessions, workspaceId]);

  useEffect(() => {
    if (!focus) return;
    if (focus.id) setSelected(focus.id);
    setListMode(!focus.id);
    setFromList(false);
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
        if (active) setError(friendlyError(cause, "無法讀取終端機清單。"));
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
    const element = mount.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
    Terminal.strings.promptLabel = "終端機輸入";
    Terminal.strings.tooMuchOutput = "輸出過多，請逐行閱讀。";
    const monoFont = getComputedStyle(element).getPropertyValue("--k-font-mono").trim();
    const terminal = new Terminal({
      cols: 100,
      rows: 28,
      cursorBlink: !reducedMotion.matches,
      screenReaderMode: true,
      fontSize: 13,
      fontFamily: monoFont || '"Cascadia Mono", Consolas, monospace',
      scrollback: 2000,
      disableStdin: true,
      theme: tokenTerminalTheme(element),
      linkHandler: { activate: () => undefined },
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(element);
    const updateMotion = () => {
      terminal.options.cursorBlink = !reducedMotion.matches;
    };
    reducedMotion.addEventListener("change", updateMotion);
    // The palette follows the token theme: the host data-theme, else the OS setting.
    const updateTheme = () => {
      terminal.options.theme = tokenTerminalTheme(element);
    };
    darkScheme.addEventListener("change", updateTheme);
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
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
          .catch(() => {
            if (active) setError("輸入未確認送達，請先檢查畫面再重送。");
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
              if (active) setError(friendlyError(cause, "終端機大小沒有更新。"));
            });
      }, 150);
    });
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0) addon.fit();
    });
    observer.observe(element);
    return () => {
      active = false;
      clearTimeout(inputTimer);
      clearTimeout(resizeTimer);
      observer.disconnect();
      themeObserver.disconnect();
      darkScheme.removeEventListener("change", updateTheme);
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
    if (!screenVisible) return;
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
          if (active) setError(friendlyError(cause, "終端機大小沒有更新。"));
        });
    return () => {
      active = false;
    };
  }, [bridge, screenVisible, session?.id, session?.state, locked]);

  useEffect(() => {
    if (!shown) return;
    let active = true;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout>;
    term.current?.reset();
    setNewOutput(false);
    setPolledSession(undefined);
    setError("");
    setInfo("");
    const poll = async () => {
      let delay = isVisible.current ? 250 : 1000;
      try {
        const data = await bridge.call("terminal_poll", { session_id: shown, cursor });
        if (!active) return;
        if (data.kind !== "terminal" || data.session.id !== shown)
          throw new Error("終端機回應格式不符。");
        setPolledSession((prior) =>
          prior?.id === data.session.id
            ? currentTerminalSession(prior, data.session)
            : data.session,
        );
        setPolledId(shown);
        if (data.truncated) {
          term.current?.reset();
          setInfo("較早輸出已不再保留。");
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
        if (active) {
          setError(friendlyError(cause, "無法讀取終端機輸出。"));
          setPolledId(shown);
        }
        delay = 2500;
      }
      if (active) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [bridge, shown]);

  async function request() {
    if (readOnly) return;
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
        setListMode(false);
        setFromList(true);
      }
    } catch (cause) {
      setError(friendlyError(cause, "終端機沒有建立，請再試一次。"));
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (locked || !shown) return;
    try {
      const data = await bridge.call("terminal_stop", { session_id: shown });
      if (data.kind === "terminal") setPolledSession(data.session);
    } catch (cause) {
      setError(friendlyError(cause, "停止結果尚未確認，請等待狀態更新。"));
    }
  }

  const workspace = session ? workspaceName?.(session.workspace_id) : undefined;
  const waiting = screenVisible && polledId !== shown && !error;
  const state = session ? toneFor("terminal", session.state) : undefined;
  const footer = session ? terminalFooter(session, readOnly) : undefined;
  return (
    <section
      ref={listReturn.container}
      className="wb-panel wb-terminal"
      data-terminal-id={shown || undefined}
      style={{ display: visible ? "flex" : "none" }}
      aria-label="互動終端機"
    >
      {listMode ? (
        <div className="insp-body">
          {!readOnly && (
            <form
              className="k-card wb-term-new"
              onSubmit={(event) => {
                event.preventDefault();
                void request();
              }}
            >
              <div className="k-risk wb-term-risk" data-tone="warning">
                <p className="k-risk__title">
                  <DesktopIcon {...iconProps("lg")} />
                  主機權限
                </p>
                <p className="k-risk__text">以你的帳號執行，沒有隔離。需在側欄核准。</p>
                <ul className="k-risk__facts">
                  <li className="k-risk__fact">可操作工作區外</li>
                  <li className="k-risk__fact">
                    <GlobeIcon {...iconProps("sm")} />
                    可連網
                  </li>
                </ul>
              </div>
              <div className="wb-term-new__row">
                <label className="k-label" htmlFor={shellId}>
                  Shell
                </label>
                <select
                  id={shellId}
                  className="k-input wb-select"
                  value={shell}
                  onChange={(event) => setShell(event.target.value)}
                >
                  {(platform === "win32" ? ["powershell", "cmd"] : ["bash", "sh"]).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
                <span className="k-meta wb-term-new__cwd">
                  工作目錄 · {cwdLabel(workspaceCwd(cwd))}
                </span>
                <button type="submit" className="k-btn k-btn--primary" disabled={busy}>
                  {busy ? "建立中…" : "新增終端機"}
                </button>
              </div>
            </form>
          )}
          {error && (
            <p className="k-notice" data-tone="danger" role="alert">
              <WarningCircleIcon {...iconProps("lg")} />
              <span className="k-notice__body">{error}</span>
            </p>
          )}
          {sessions.length ? (
            <RecordList
              label="終端機"
              items={[...sessions]
                .sort((a, b) => b.created_at - a.created_at)
                .map((item) => ({
                  id: item.id,
                  row: terminalRecord(item, { now, workspaceName }),
                }))}
              onOpen={(id) => {
                listReturn.opened(id);
                setSelected(id);
                setListMode(false);
                setFromList(true);
              }}
            />
          ) : (
            <div className="k-empty wb-empty">
              <span className="k-empty__icon" aria-hidden="true">
                <TerminalWindowIcon {...iconProps("xl")} />
              </span>
              <h3 className="k-empty__title">還沒有終端機</h3>
            </div>
          )}
        </div>
      ) : (
        <>
          {listReturn.subBar && <SubBar {...listReturn.subBar} />}
          {!session ? (
            <div className="insp-body">
              <StatusLine>終端機詳情已無法取得。</StatusLine>
            </div>
          ) : (
            <InspectorHead
              icon="terminal"
              verb="終端機"
              code={session.shell}
              state={state}
              meta={[
                workspace && (
                  <WorkspaceTag name={workspace} hue={workspaceHue(session.workspace_id)} />
                ),
                openedTime(session.created_at, now),
                <CwdMeta key="cwd" cwd={workspaceCwd(session.cwd)} />,
              ]}
              actions={
                !locked &&
                terminalActive(session) && (
                  <button
                    type="button"
                    className="k-btn k-btn--danger-quiet k-btn--sm"
                    onClick={() => void stop()}
                  >
                    停止
                  </button>
                )
              }
            />
          )}
          {(session?.state === "pending" || error || info || waiting) && (
            <div className="insp-body wb-term-notices">
              {session?.state === "pending" && <PendingNotice />}
              {waiting && <StatusLine>正在讀取輸出…</StatusLine>}
              {info && !error && (
                <p className="k-notice" data-tone="neutral" role="status">
                  <InfoIcon {...iconProps("lg")} />
                  <span className="k-notice__body">{info}</span>
                </p>
              )}
              {error && (
                <div className="k-notice" data-tone="danger" role="alert">
                  <WarningCircleIcon {...iconProps("lg")} />
                  <span className="k-notice__body">{error}</span>
                  <button
                    type="button"
                    className="k-btn k-btn--quiet k-btn--icon k-btn--sm k-notice__close"
                    aria-label="關閉終端機錯誤"
                    onClick={() => setError("")}
                  >
                    <XIcon {...iconProps("md")} />
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <div className="wb-term-screen" hidden={!screenVisible}>
        <div className="terminal-mount" ref={mount} />
        {newOutput && screenVisible && (
          <button
            type="button"
            className="k-newpill wb-term-newout"
            onClick={() => {
              term.current?.scrollToBottom();
              setNewOutput(false);
            }}
          >
            <ArrowDownIcon {...iconProps("md")} />
            有新輸出 · 回到底部
          </button>
        )}
      </div>
      {!listMode && session && state && (
        <footer className="wb-term-footer">
          <span>主機終端機 · {state.label}</span>
          {footer && <span>{footer}</span>}
        </footer>
      )}
    </section>
  );
}
