import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  Browser,
  Check,
  CircleNotch,
  Copy,
  FolderOpen,
  House,
  Key,
  LinkSimple,
  LockKey,
  PlugsConnected,
  Plus,
  ShieldCheck,
  TerminalWindow,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  addWorkspace,
  chooseWorkspaceFolder,
  configureExtension,
  type DesktopAction,
  forgetRuntimeApiKey,
  getDesktopStatus,
  getLocalMcpCommand,
  onConfirmRestart,
  openExternal,
  performAction,
  removeWorkspace,
  saveRuntimeApiKey,
  subscribeDesktopStatus,
} from "./api.ts";
import { HandoffFlow } from "./handoff-flow.tsx";
import { handoffInvalidReason } from "./handoff-session.ts";
import {
  type DesktopSnapshot,
  deriveDesktopView,
  newerSnapshot,
  type PrimaryAction,
  type WorkspaceSummary,
} from "./model.ts";

type Route = "overview" | "projects" | "connection" | "diagnostics";

const initialSnapshot: DesktopSnapshot = {
  version: "",
  sequence: 0,
  credentialConfigured: false,
  tunnelClientInstalled: true,
  runtime: { state: "starting", owned: true, message: "正在啟動本機服務。" },
  companion: null,
  versionMismatch: false,
};

function StateIcon({ tone }: { tone: ReturnType<typeof deriveDesktopView>["tone"] }) {
  if (tone === "ready") return <Check weight="bold" />;
  if (tone === "error") return <Warning weight="fill" />;
  if (tone === "waiting") return <CircleNotch className="spin" weight="bold" />;
  return <LockKey weight="fill" />;
}

function JourneyNode({
  state,
  icon,
  title,
}: {
  state: "done" | "current" | "pending" | "error";
  icon: ReactNode;
  title: string;
}) {
  const stateLabel = {
    done: "已連線",
    current: "下一步",
    pending: "待完成",
    error: "需要處理",
  }[state];
  return (
    <div className={`journey-node ${state}`}>
      <div className="journey-icon" aria-hidden="true">
        {state === "done" ? (
          <Check weight="bold" />
        ) : state === "error" ? (
          <Warning weight="fill" />
        ) : (
          icon
        )}
      </div>
      <strong>
        {title}
        <span className="journey-state"> · {stateLabel}</span>
      </strong>
    </div>
  );
}

function KeyDialog({
  onClose,
  onSaved,
  returnFocus,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
  returnFocus: HTMLButtonElement | null;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const shell = dialogRef.current?.closest(".app-shell");
    const background = [
      shell?.querySelector<HTMLElement>(".sidebar"),
      shell?.querySelector<HTMLElement>(".main-surface"),
    ].filter((element): element is HTMLElement => Boolean(element));
    const previousInert = background.map((element) => element.inert);
    for (const element of background) element.inert = true;
    inputRef.current?.focus();
    return () => {
      for (const [index, element] of background.entries())
        element.inert = previousInert[index] ?? false;
      if (returnFocus?.isConnected) returnFocus.focus();
      else shell?.querySelector<HTMLButtonElement>(".sidebar nav button.active")?.focus();
    };
  }, [returnFocus]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      if (!busy) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (key.length < 8) {
      setError("請貼上完整的 Runtime API Key。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveRuntimeApiKey(key);
      setValue("");
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法保存安全連線設定。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <button
        className="dialog-dismiss"
        type="button"
        aria-label="關閉安全連線設定"
        tabIndex={-1}
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-dialog-title"
        onKeyDown={handleKeyDown}
      >
        <button
          className="icon-button dialog-close"
          type="button"
          aria-label="關閉"
          onClick={onClose}
        >
          <X weight="bold" />
        </button>
        <div className="dialog-symbol" aria-hidden="true">
          <LockKey weight="fill" />
        </div>
        <h2 id="key-dialog-title">連上 ChatGPT Tunnel</h2>
        <p className="dialog-intro">金鑰由作業系統保管，只用來啟動官方 Tunnel。</p>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="runtime-key">
            Runtime API Key
          </label>
          <input
            ref={inputRef}
            id="runtime-key"
            className="text-field"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="貼上金鑰"
          />
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="text-link"
            type="button"
            onClick={() => void openExternal("runtime_keys")}
          >
            取得 Runtime API Key <ArrowSquareOut weight="bold" />
          </button>
          <div className="dialog-actions">
            <button className="button secondary" type="button" onClick={onClose}>
              稍後再說
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? (
                <CircleNotch className="spin" weight="bold" />
              ) : (
                <ShieldCheck weight="bold" />
              )}
              保存並連線
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function RemoveWorkspaceDialog({
  workspace,
  busy,
  onClose,
  onConfirm,
}: {
  workspace: WorkspaceSummary;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="dialog-backdrop">
      <button
        className="dialog-dismiss"
        type="button"
        aria-label="取消解除掛載"
        onClick={onClose}
      />
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-workspace-title"
      >
        <button
          className="icon-button dialog-close"
          type="button"
          aria-label="關閉"
          onClick={onClose}
          disabled={busy}
        >
          <X weight="bold" />
        </button>
        <div className="dialog-symbol danger" aria-hidden="true">
          <Trash weight="duotone" />
        </div>
        <h2 id="remove-workspace-title">解除掛載「{workspace.name}」？</h2>
        <label className="confirm-check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={busy}
          />
          <span>只解除 Kairomes 掛載；資料夾與檔案都會保留。</span>
        </label>
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>
            保留專案
          </button>
          <button
            className="button danger"
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy || !confirmed}
          >
            {busy ? <CircleNotch className="spin" weight="bold" /> : <Trash weight="bold" />}
            解除掛載
          </button>
        </div>
      </section>
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>("overview");
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>(initialSnapshot);
  const [statusCurrent, setStatusCurrent] = useState(false);
  const refreshRevision = useRef(0);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const keyDialogTrigger = useRef<HTMLButtonElement | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [extensionId, setExtensionId] = useState("");
  const [pairingUrl, setPairingUrl] = useState("");
  const [localMcpCommand, setLocalMcpCommand] = useState("");
  const [localMcpCommandError, setLocalMcpCommandError] = useState("");
  const [removeTarget, setRemoveTarget] = useState<WorkspaceSummary | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<WorkspaceSummary | null>(null);

  const view = useMemo(() => deriveDesktopView(snapshot), [snapshot]);
  const handoffInvalid = handoffTarget
    ? handoffInvalidReason(snapshot, handoffTarget.id, statusCurrent)
    : null;

  useEffect(() => {
    if (!handoffTarget || !handoffInvalid) return;
    const returnId = `handoff-project-${handoffTarget.id}`;
    setHandoffTarget(null);
    setNotice(handoffInvalid);
    requestAnimationFrame(() => {
      const trigger = document.getElementById(returnId);
      if (trigger instanceof HTMLButtonElement && !trigger.disabled) trigger.focus();
      else document.getElementById("projects-title")?.focus();
    });
  }, [handoffTarget, handoffInvalid]);

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current;
    try {
      const next = await getDesktopStatus();
      if (revision !== refreshRevision.current) return;
      setSnapshot((current) => newerSnapshot(current, next));
      setStatusCurrent(true);
    } catch (caught) {
      if (revision !== refreshRevision.current) return;
      setStatusCurrent(false);
      setNotice(caught instanceof Error ? caught.message : "無法讀取 Kairomes 狀態。");
    }
  }, []);

  useEffect(
    () =>
      subscribeDesktopStatus(
        (next) => {
          setSnapshot((current) => newerSnapshot(current, next));
          setStatusCurrent(true);
        },
        (caught) => {
          setStatusCurrent(false);
          setNotice(caught.message);
        },
      ),
    [],
  );

  // Interim wiring until the confirmation dialog lands: the tray never restarts directly.
  useEffect(
    () =>
      onConfirmRestart(() => {
        setRoute("diagnostics");
        setNotice("重新啟動會停止終端機並收回自主授權；確認後按「重新啟動本機服務」。");
      }),
    [],
  );

  useEffect(() => {
    if (route !== "connection") return;
    let active = true;
    void getLocalMcpCommand()
      .then((command) => {
        if (!active) return;
        setLocalMcpCommand(command);
        setLocalMcpCommandError("");
      })
      .catch((caught) => {
        if (!active) return;
        setLocalMcpCommand("");
        setLocalMcpCommandError(
          caught instanceof Error ? caught.message : "無法取得本機 MCP 指令。",
        );
      });
    return () => {
      active = false;
    };
  }, [route]);

  const run = async (action: DesktopAction, successMessage = "") => {
    if (busyAction) return;
    setBusyAction(action);
    setNotice("");
    try {
      const result = await performAction(action);
      if (result.pairingUrl) setPairingUrl(result.pairingUrl);
      if (successMessage) setNotice(successMessage);
      await refresh();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "操作沒有完成。");
    } finally {
      setBusyAction(null);
    }
  };

  const addProject = async () => {
    if (busyAction) return;
    setBusyAction("workspace_pick");
    setNotice("");
    try {
      const selected = await chooseWorkspaceFolder();
      if (!selected) return;
      setBusyAction("workspace_add");
      const workspace = await addWorkspace(selected);
      await refresh();
      setRoute("projects");
      setNotice(`已掛載「${workspace.name}」；側欄專案列會自動更新。`);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "無法加入這個專案資料夾。");
    } finally {
      setBusyAction(null);
    }
  };

  const removeProject = async () => {
    if (!removeTarget || busyAction) return;
    const workspace = removeTarget;
    setBusyAction("workspace_remove");
    setNotice("");
    try {
      await removeWorkspace(workspace.id);
      setRemoveTarget(null);
      await refresh();
      setNotice(`已解除掛載「${workspace.name}」；原始檔案保持不變。`);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "無法解除掛載這個專案。");
    } finally {
      setBusyAction(null);
    }
  };

  const openKeyDialog = (trigger: HTMLButtonElement) => {
    keyDialogTrigger.current = trigger;
    setKeyDialogOpen(true);
  };

  const handlePrimary = async (action: PrimaryAction, trigger: HTMLButtonElement) => {
    if (action === "configure_key") openKeyDialog(trigger);
    else if (action === "add_workspace") await addProject();
    else if (action === "start_tunnel") await run("start_tunnel");
    else if (action === "restart_runtime") await run("restart_runtime");
    else if (action === "open_connectors") await run("open_connectors");
    else if (action === "open_workbench") await run("open_workbench");
    else if (action === "show_tunnel_help") setRoute("diagnostics");
  };

  const pairExtension = async (event: FormEvent) => {
    event.preventDefault();
    const value = extensionId.trim();
    if (!/^[a-p]{32}$/.test(value)) {
      setNotice("Extension ID 應為 32 個 a～p 字元。");
      return;
    }
    setBusyAction("configure_extension");
    setNotice("");
    try {
      const result = await configureExtension(value);
      setPairingUrl(result.pairingUrl ?? "");
      setNotice("新的配對連結已準備好，請在兩分鐘內貼到 Kairomes Extension。");
      await refresh();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "無法建立瀏覽器配對。");
    } finally {
      setBusyAction(null);
    }
  };

  const copyPairing = async () => {
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setNotice("配對連結已複製。");
    } catch {
      setNotice("無法自動複製，請手動選取連結。");
    }
  };

  const copyLocalMcpCommand = async () => {
    if (!localMcpCommand) return;
    try {
      await navigator.clipboard.writeText(localMcpCommand);
      setNotice("本機 MCP 指令已複製，可用於官方 Tunnel profile 的一次性設定。");
    } catch {
      setNotice("無法自動複製，請手動選取本機 MCP 指令。");
    }
  };

  const statusLabel =
    view.tone === "ready"
      ? "已就緒"
      : view.tone === "error"
        ? "需要處理"
        : view.tone === "waiting"
          ? "連線中"
          : "設定中";
  const workspaces = snapshot.companion?.workspaces ?? [];
  const pageTitle = {
    overview: "總覽",
    projects: "專案",
    connection: "連線設定",
    diagnostics: "疑難排解",
  }[route];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/kairomes-k-128.png" alt="" />
          <div>
            <strong>Kairomes</strong>
          </div>
        </div>

        <nav aria-label="主要導覽">
          <button
            className={route === "overview" ? "active" : ""}
            type="button"
            onClick={() => setRoute("overview")}
          >
            <House weight={route === "overview" ? "fill" : "regular"} />
            總覽
          </button>
          <button
            className={route === "projects" ? "active" : ""}
            type="button"
            onClick={() => setRoute("projects")}
          >
            <FolderOpen weight={route === "projects" ? "fill" : "regular"} />
            專案
          </button>
          <button
            className={route === "connection" ? "active" : ""}
            type="button"
            onClick={() => setRoute("connection")}
          >
            <PlugsConnected weight={route === "connection" ? "fill" : "regular"} />
            連線設定
          </button>
          <button
            className={`mobile-diagnostics ${route === "diagnostics" ? "active" : ""}`}
            type="button"
            onClick={() => setRoute("diagnostics")}
          >
            <TerminalWindow weight={route === "diagnostics" ? "fill" : "regular"} />
            疑難排解
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className={`mini-status ${view.tone}`}>
            <span className="status-dot" />
            <div>
              <strong>{statusLabel}</strong>
            </div>
          </div>
          <button className="quiet-button" type="button" onClick={() => setRoute("diagnostics")}>
            <TerminalWindow /> 疑難排解
          </button>
        </div>
      </aside>

      <main className="main-surface">
        <header className="page-header">
          <div>
            <h1>{pageTitle}</h1>
          </div>
          <div className="tray-pill" title="關閉視窗後 Kairomes 仍會在系統匣執行">
            <span className={`status-dot ${view.tone}`} aria-hidden="true" />
            關閉後仍執行
          </div>
        </header>

        {notice ? (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" aria-label="關閉訊息" onClick={() => setNotice("")}>
              <X weight="bold" />
            </button>
          </div>
        ) : null}

        {route === "overview" ? (
          <div className="overview-page">
            <section className={`status-hero ${view.tone}`} aria-live="polite">
              <div className="status-symbol" aria-hidden="true">
                <StateIcon tone={view.tone} />
              </div>
              <div className="status-copy">
                <p className="eyebrow">{statusLabel}</p>
                <h2>{view.title}</h2>
                {view.tone !== "ready" && <p>{view.description}</p>}
              </div>
              <div className="status-actions">
                {view.action !== "none" ? (
                  <button
                    className="button primary"
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={(event) => void handlePrimary(view.action, event.currentTarget)}
                  >
                    {busyAction ? <CircleNotch className="spin" weight="bold" /> : null}
                    {view.actionLabel}
                    {!busyAction ? <ArrowRight weight="bold" /> : null}
                  </button>
                ) : (
                  <span className="working-label">
                    <CircleNotch className="spin" /> {view.actionLabel}
                  </span>
                )}
              </div>
            </section>

            <section className="journey-section" aria-labelledby="journey-title">
              <div className="section-heading">
                <h2 id="journey-title">連線</h2>
                <button
                  className="section-link"
                  type="button"
                  onClick={() => setRoute("connection")}
                >
                  管理連線 <ArrowRight weight="bold" />
                </button>
              </div>
              <div className="journey-track">
                <JourneyNode state={view.localState} icon={<FolderOpen />} title="本機" />
                <div
                  className={`journey-line ${view.tunnelState === "done" ? "done" : ""}`}
                  aria-hidden="true"
                />
                <JourneyNode state={view.tunnelState} icon={<ShieldCheck />} title="安全通道" />
                <div
                  className={`journey-line ${view.chatgptState === "done" ? "done" : ""}`}
                  aria-hidden="true"
                />
                <JourneyNode state={view.chatgptState} icon={<PlugsConnected />} title="ChatGPT" />
              </div>
            </section>

            <section className="overview-projects" aria-labelledby="overview-projects-title">
              <div className="section-heading">
                <h2 id="overview-projects-title">專案</h2>
                <button className="section-link" type="button" onClick={() => setRoute("projects")}>
                  管理專案 <ArrowRight weight="bold" />
                </button>
              </div>
              <div className="overview-project-list">
                {workspaces.length ? (
                  <>
                    {workspaces.slice(0, 3).map((workspace) => (
                      <span key={workspace.id} className="overview-project-name">
                        <FolderOpen aria-hidden="true" /> <span>{workspace.name}</span>
                      </span>
                    ))}
                    {workspaces.length > 3 && <span>另有 {workspaces.length - 3} 個</span>}
                  </>
                ) : (
                  <p>尚未加入專案</p>
                )}
              </div>
            </section>
          </div>
        ) : null}

        {route === "projects" && handoffTarget && !handoffInvalid ? (
          <HandoffFlow
            workspace={handoffTarget}
            onClose={() => {
              const returnId = `handoff-project-${handoffTarget.id}`;
              setHandoffTarget(null);
              requestAnimationFrame(() => document.getElementById(returnId)?.focus());
            }}
          />
        ) : null}
        {route === "projects" && (!handoffTarget || handoffInvalid) ? (
          <div className="projects-page">
            <section className="projects-intro">
              <div>
                <h2 id="projects-title" tabIndex={-1}>
                  已加入的專案
                </h2>
                <p>選擇本機資料夾，讓 ChatGPT 在授權範圍內協作。</p>
              </div>
              <button
                className="button primary"
                type="button"
                onClick={() => void addProject()}
                disabled={Boolean(busyAction) || !snapshot.companion}
              >
                {busyAction === "workspace_pick" || busyAction === "workspace_add" ? (
                  <CircleNotch className="spin" weight="bold" />
                ) : (
                  <Plus weight="bold" />
                )}
                新增專案
              </button>
            </section>

            {workspaces.length ? (
              <section className="project-list" aria-label="已加入的專案">
                {workspaces.map((workspace) => (
                  <article className="project-card" key={workspace.id}>
                    <div className="project-icon" aria-hidden="true">
                      <FolderOpen weight="duotone" />
                    </div>
                    <div className="project-copy">
                      <h3>{workspace.name}</h3>
                    </div>
                    <button
                      id={`handoff-project-${workspace.id}`}
                      className="button secondary"
                      type="button"
                      disabled={
                        Boolean(busyAction) ||
                        Boolean(handoffInvalidReason(snapshot, workspace.id, statusCurrent))
                      }
                      onClick={() => {
                        setHandoffTarget(workspace);
                      }}
                    >
                      從 Codex 接續
                    </button>
                    <button
                      className="button danger-text project-remove"
                      type="button"
                      onClick={() => setRemoveTarget(workspace)}
                      disabled={Boolean(busyAction)}
                      aria-label={`解除掛載 ${workspace.name}`}
                    >
                      <Trash weight="bold" /> 解除掛載
                    </button>
                  </article>
                ))}
              </section>
            ) : (
              <section className="projects-empty">
                <div className="empty-symbol" aria-hidden="true">
                  <FolderOpen weight="duotone" />
                </div>
                <h3>還沒有專案</h3>
                <p>先加入一個本機資料夾。</p>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void addProject()}
                  disabled={Boolean(busyAction) || !snapshot.companion}
                >
                  <Plus weight="bold" /> 選擇第一個專案
                </button>
              </section>
            )}

            <aside className="project-safety-note">
              <ShieldCheck weight="duotone" />
              <p>加入後可讀取與搜尋專案；修改檔案仍需你的核准或授權。</p>
            </aside>
          </div>
        ) : null}

        {route === "connection" ? (
          <div className="settings-page">
            <section className="settings-block">
              <div className="settings-icon">
                <Key weight="duotone" />
              </div>
              <div className="settings-content">
                <div className="settings-heading">
                  <div>
                    <h3>OpenAI Runtime API Key</h3>
                  </div>
                  <span
                    className={`setting-state ${snapshot.credentialConfigured ? "good" : "warn"}`}
                  >
                    {snapshot.credentialConfigured ? "已安全保存" : "尚未設定"}
                  </span>
                </div>
                <p className="security-note">
                  <ShieldCheck weight="fill" /> 由作業系統保存，只用於 Tunnel，不會交給模型。
                </p>
                <div className="button-row">
                  <button
                    className="button primary"
                    type="button"
                    onClick={(event) => openKeyDialog(event.currentTarget)}
                  >
                    {snapshot.credentialConfigured ? "更換金鑰" : "設定金鑰"}
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => void openExternal("runtime_keys")}
                  >
                    取得 Runtime API Key <ArrowSquareOut />
                  </button>
                  {snapshot.credentialConfigured ? (
                    <button
                      className="button danger-text"
                      type="button"
                      onClick={() =>
                        void (async () => {
                          setBusyAction("forget_key");
                          try {
                            await forgetRuntimeApiKey();
                            await refresh();
                            setNotice("已從作業系統憑證保管庫移除 Runtime API Key。");
                          } catch (caught) {
                            setNotice(caught instanceof Error ? caught.message : "無法移除金鑰。");
                          } finally {
                            setBusyAction(null);
                          }
                        })()
                      }
                    >
                      移除
                    </button>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="settings-block">
              <div className="settings-icon">
                <TerminalWindow weight="duotone" />
              </div>
              <div className="settings-content">
                <div className="settings-heading">
                  <div>
                    <h3>本機 MCP 指令</h3>
                    <p>
                      首次建立官方 tunnel-client 的 <code>kairomes</code> profile 時，將這行填入{" "}
                      <code>--mcp-command</code>。
                    </p>
                  </div>
                </div>
                <div className="mcp-command-result">
                  <input
                    className="text-field"
                    value={localMcpCommand}
                    readOnly
                    aria-label="本機 MCP 指令"
                    aria-describedby="mcp-command-hint"
                    placeholder="正在取得安裝位置…"
                  />
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => void copyLocalMcpCommand()}
                    disabled={!localMcpCommand}
                  >
                    <Copy weight="bold" /> 複製指令
                  </button>
                </div>
                {localMcpCommandError ? (
                  <p className="field-error" role="alert">
                    {localMcpCommandError}
                  </p>
                ) : null}
                <p className="mcp-command-hint" id="mcp-command-hint">
                  只需設定一次。指令不含金鑰或配對資訊；日常由 Desktop 管理 Tunnel。
                </p>
              </div>
            </section>

            <section className="settings-block">
              <div className="settings-icon">
                <Browser weight="duotone" />
              </div>
              <div className="settings-content">
                <div className="settings-heading">
                  <div>
                    <h3>瀏覽器側欄</h3>
                    <p>在 ChatGPT 旁顯示活動與核准。</p>
                  </div>
                  <span
                    className={`setting-state ${snapshot.companion?.extension.configured ? "good" : "quiet"}`}
                  >
                    {snapshot.companion?.extension.configured ? "已設定" : "尚未配對"}
                  </span>
                </div>
                <form className="inline-form" onSubmit={pairExtension}>
                  <label className="field-label" htmlFor="extension-id">
                    Extension ID
                  </label>
                  <div>
                    <input
                      id="extension-id"
                      className="text-field"
                      value={extensionId}
                      onChange={(event) => setExtensionId(event.target.value)}
                      maxLength={32}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="貼上 32 位 Extension ID"
                    />
                    <button
                      className="button secondary"
                      type="submit"
                      disabled={Boolean(busyAction)}
                    >
                      <LinkSimple weight="bold" /> 儲存並配對
                    </button>
                  </div>
                </form>
                {pairingUrl ? (
                  <div className="pairing-area">
                    <div className="pairing-result">
                      <input
                        className="text-field"
                        value={pairingUrl}
                        readOnly
                        aria-label="一次性配對連結"
                      />
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => void copyPairing()}
                      >
                        <Copy weight="bold" /> 複製連結
                      </button>
                    </div>
                    <p className="pairing-hint">只貼到瀏覽器側欄，勿交給 ChatGPT。</p>
                  </div>
                ) : snapshot.companion?.extension.configured ? (
                  <button
                    className="text-link"
                    type="button"
                    onClick={() => void run("create_pairing")}
                  >
                    產生新的兩分鐘配對連結 <ArrowRight weight="bold" />
                  </button>
                ) : null}
              </div>
            </section>
          </div>
        ) : null}

        {route === "diagnostics" ? (
          <div className="diagnostics-page">
            {(!snapshot.tunnelClientInstalled ||
              snapshot.companion?.tunnel.state === "missing") && (
              <p className="diagnostics-note">
                從 OpenAI 官方 Tunnel 指南取得 tunnel-client，加入 PATH 後重新啟動 Kairomes
                Desktop。
              </p>
            )}
            <p className="diagnostics-note">不顯示金鑰、控制憑證或私人配對連結。</p>
            <section className="diagnostic-table" aria-label="Kairomes 診斷狀態">
              <div>
                <span>本機服務</span>
                <strong>
                  {snapshot.runtime.state === "running"
                    ? "執行中"
                    : snapshot.runtime.state === "starting"
                      ? "啟動中"
                      : "需要處理"}
                </strong>
              </div>
              <div>
                <span>程序管理</span>
                <strong>{snapshot.runtime.owned ? "由 Desktop 管理" : "既有程序"}</strong>
              </div>
              <div>
                <span>官方 Tunnel</span>
                <strong>{snapshot.tunnelClientInstalled ? "已找到" : "找不到"}</strong>
              </div>
              <div>
                <span>Kairomes 版本</span>
                <strong>{snapshot.companion?.version ?? "尚未回應"}</strong>
              </div>
              <div>
                <span>Connector 狀態</span>
                <strong>{snapshot.companion?.connector.meta ?? "尚無"}</strong>
              </div>
            </section>
            <div className="button-row diagnostics-actions">
              <button
                className="button primary"
                type="button"
                onClick={() => void run("restart_runtime")}
              >
                <ArrowClockwise weight="bold" /> 重新啟動本機服務
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => void run("open_workbench")}
              >
                <FolderOpen weight="bold" /> 開啟工作台
              </button>
            </div>
            {snapshot.companion?.tunnel.logs.length ? (
              <details className="log-disclosure">
                <summary>最近的 Tunnel 訊息</summary>
                <pre>{snapshot.companion.tunnel.logs.join("\n")}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </main>

      {keyDialogOpen ? (
        <KeyDialog
          onClose={() => setKeyDialogOpen(false)}
          onSaved={refresh}
          returnFocus={keyDialogTrigger.current}
        />
      ) : null}
      {removeTarget ? (
        <RemoveWorkspaceDialog
          workspace={removeTarget}
          busy={busyAction === "workspace_remove"}
          onClose={() => setRemoveTarget(null)}
          onConfirm={removeProject}
        />
      ) : null}
    </div>
  );
}
