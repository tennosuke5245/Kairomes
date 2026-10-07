import { CircleNotch, Plus } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VERSION } from "../../../packages/protocol/src/index.ts";
import {
  addWorkspace,
  chooseWorkspaceFolders,
  configureExtension,
  type DesktopAction,
  type ExternalTarget,
  forgetRuntimeApiKey,
  getDesktopStatus,
  getDiagnostics,
  getLocalMcpCommand,
  getWorkspacePaths,
  hideMainWindow,
  onCloseHint,
  onConfirmRestart,
  onFolderDrop,
  openExternal,
  type PairingResult,
  performAction,
  removeWorkspace,
  renameWorkspace,
  revealWorkspace,
  subscribeDesktopStatus,
} from "./api.ts";
import type { CheckControl } from "./checks.ts";
import { Icon, NoticeSlot, useNow, waitable } from "./components.tsx";
import { CONNECTION_HOST_ACTION, ConnectionPage } from "./connection.tsx";
import type { ConnectionAction } from "./connection-model.ts";
import { CHECK_HOST_ACTION, DiagnosticsPage } from "./diagnostics.tsx";
import { CloseHintDialog, ConfirmDialog, closeOwn, KeyDialog, RenameDialog } from "./dialog.tsx";
import { useFocusRescue } from "./focus.ts";
import { pairingRemaining } from "./format.ts";
import { HandoffFlow } from "./handoff-flow.tsx";
import { handoffInvalidReason } from "./handoff-session.ts";
import {
  type DesktopSnapshot,
  deriveAttention,
  deriveDesktopView,
  extensionChangeConsequence,
  newerSnapshot,
  profileEvidence,
  restartConsequence,
  type ViewAction,
  type WorkspaceSummary,
} from "./model.ts";
import {
  addProjectsNotice,
  clearNotice,
  errorText,
  MAX_FOLDERS_PER_ADD,
  type Notice,
  nextNotice,
  STATUS_ERROR_TEXT,
} from "./notice.ts";
import { OverviewPage, OverviewSkeleton, StatusLine, statusLineContent } from "./overview.tsx";
import { followPairing, leavePairing, type PairingLink, receivePairing } from "./pairing.ts";
import { PROFILE_ACK_KEY, readFlag, writeFlag } from "./prefs.ts";
import { ProjectsPage, projectMenuId } from "./projects.tsx";
import { PAGE_TITLES, type Route, Sidebar } from "./shell.tsx";

type DialogState =
  | { kind: "key" }
  | { kind: "restart" }
  | { kind: "forget_key" }
  | { kind: "rename"; workspace: WorkspaceSummary }
  | { kind: "remove"; workspace: WorkspaceSummary }
  /** 更換 Extension ID restarts the workbench; `settle` tells the form whether it was saved. */
  | { kind: "extension"; extensionId: string; settle: (saved: boolean) => void }
  | { kind: "close_hint" }
  | null;

/** A second action while one runs gets this fixed sentence instead of starting. */
const BUSY_TEXT = "另一個操作還在進行，完成後再試一次。";

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function App() {
  const [route, setRoute] = useState<Route>("overview");
  // Read after an await: the page the user is on when a slow host call answers.
  const routeRef = useRef(route);
  routeRef.current = route;
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [statusCurrent, setStatusCurrent] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [paths, setPaths] = useState<ReadonlyMap<string, string>>(new Map());
  const [profileAcknowledged, setProfileAcknowledged] = useState(() => readFlag(PROFILE_ACK_KEY));
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpCommandError, setMcpCommandError] = useState("");
  const [pairing, setPairing] = useState<PairingLink | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<WorkspaceSummary | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const refreshRevision = useRef(0);
  // The action in flight, read synchronously so two clicks in one frame cannot both start.
  const busyRef = useRef<string | null>(null);
  const tick = useNow(1000);
  // Never older than the last snapshot, so a countdown computed from it cannot run backwards.
  const now = Math.max(tick, checkedAt ?? 0);

  const show = useCallback(
    (next: Notice | null) => setNotice((current) => nextNotice(current, next)),
    [],
  );
  const dismiss = useCallback(() => setNotice(null), []);
  // A control that an action or a status update removes hands focus on, never to <body>.
  useFocusRescue(".desk-main h1");
  /** Closes `mine` only; a dialog that replaced it stays open. */
  const closeDialog = useCallback(
    (mine: NonNullable<DialogState>) => setDialog((current) => closeOwn(current, mine)),
    [],
  );
  /** The handoff flow's messages share the slot; null clears only the flow's own message. */
  const notifyHandoff = useCallback(
    (next: Notice | null) =>
      next ? show(next) : setNotice((current) => clearNotice(current, "handoff")),
    [show],
  );
  const fail = useCallback(
    (caught: unknown, fallback: string) =>
      show({ tone: "danger", text: errorText(caught, fallback), source: "action" }),
    [show],
  );

  const begin = (name: string) => {
    if (busyRef.current) return false;
    busyRef.current = name;
    setBusyAction(name);
    return true;
  };
  const end = () => {
    busyRef.current = null;
    setBusyAction(null);
  };

  const deliver = useCallback((next: DesktopSnapshot) => {
    setSnapshot((current) => (current ? newerSnapshot(current, next) : next));
    setCheckedAt(Date.now());
    setStatusCurrent(true);
    setNotice((current) => clearNotice(current, "status"));
  }, []);

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current;
    try {
      const next = await getDesktopStatus();
      if (revision === refreshRevision.current) deliver(next);
    } catch {
      if (revision !== refreshRevision.current) return;
      setStatusCurrent(false);
      show({ tone: "warning", text: STATUS_ERROR_TEXT, source: "status" });
    }
  }, [deliver, show]);

  // First paint comes from an immediate read; pushed updates follow (polling when unavailable).
  useEffect(
    () =>
      subscribeDesktopStatus(deliver, () => {
        setStatusCurrent(false);
        show({ tone: "warning", text: STATUS_ERROR_TEXT, source: "status" });
      }),
    [deliver, show],
  );

  // The tray never restarts by itself: it shows this window and asks for confirmation here.
  useEffect(
    () =>
      onConfirmRestart(() =>
        setDialog((current) => (current?.kind === "restart" ? current : { kind: "restart" })),
      ),
    [],
  );

  // The first close says once that Kairomes stays in the tray (the old pill's job). With a
  // dialog already open the window just hides, so nothing the user typed is lost.
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  useEffect(
    () =>
      onCloseHint(() => {
        if (dialogRef.current) void hideMainWindow().catch(() => undefined);
        else setDialog({ kind: "close_hint" });
      }),
    [],
  );

  // Once the Tunnel has run with the profile, the profile step stays done on later launches.
  useEffect(() => {
    if (profileAcknowledged || !snapshot || !profileEvidence(snapshot)) return;
    writeFlag(PROFILE_ACK_KEY);
    setProfileAcknowledged(true);
  }, [snapshot, profileAcknowledged]);

  const view = useMemo(
    () => (snapshot ? deriveDesktopView(snapshot, { now, profileAcknowledged }) : null),
    [snapshot, now, profileAcknowledged],
  );
  const attention = useMemo(() => deriveAttention(snapshot, now), [snapshot, now]);
  const companion = snapshot?.companion ?? null;
  const workspaces = companion?.workspaces ?? [];
  const workspaceKey = workspaces.map((workspace) => workspace.id).join(",");
  const pairedPanels = companion?.attention.pairedPanels ?? null;

  // Absolute roots are fetched for display here only; they never leave Desktop.
  useEffect(() => {
    if (!workspaceKey) {
      setPaths(new Map());
      return;
    }
    let active = true;
    getWorkspacePaths().then(
      (list) => {
        if (active) setPaths(new Map(list.map((entry) => [entry.id, entry.root])));
      },
      () => {
        if (active) setPaths(new Map());
      },
    );
    return () => {
      active = false;
    };
  }, [workspaceKey]);

  const needsCommand = route === "connection" || view?.setup?.current === "profile";
  useEffect(() => {
    if (!needsCommand || mcpCommand) return;
    let active = true;
    getLocalMcpCommand().then(
      (command) => {
        if (!active) return;
        setMcpCommand(command);
        setMcpCommandError("");
      },
      (caught) => {
        if (active) setMcpCommandError(errorText(caught, "無法取得本機 MCP 指令。"));
      },
    );
    return () => {
      active = false;
    };
  }, [needsCommand, mcpCommand]);

  // The pairing link is a one-time credential: gone when it expires, is used or the page is left.
  const pairingRemainingMs = pairing?.url
    ? pairingRemaining(pairing.receivedAt, pairing.expiresInSeconds, now)
    : 0;
  useEffect(() => {
    if (route !== "connection") setPairing(leavePairing);
  }, [route]);
  useEffect(() => {
    if (!pairing?.url) return;
    const next = followPairing(pairing, pairingRemainingMs, pairedPanels);
    if (next === pairing) return;
    setPairing(next);
    if (next.cleared === "used")
      show({ tone: "success", text: "側欄已完成配對。", source: "action" });
  }, [pairing, pairingRemainingMs, pairedPanels, show]);
  /** Keeps a returned link only if 連線設定 is still open; true when it was kept. */
  const keepPairing = (result: PairingResult) => {
    const link = receivePairing(result, {
      onPage: routeRef.current === "connection",
      pairedPanels,
      now: Date.now(),
    });
    if (link) setPairing(link);
    return link !== null;
  };

  const handoffInvalid =
    handoffTarget && snapshot
      ? handoffInvalidReason(snapshot, handoffTarget.id, statusCurrent)
      : null;
  useEffect(() => {
    if (!handoffTarget || !handoffInvalid) return;
    const returnId = projectMenuId(handoffTarget.id);
    setHandoffTarget(null);
    show({ tone: "warning", text: handoffInvalid, source: "action" });
    requestAnimationFrame(() => {
      const trigger = document.getElementById(returnId);
      if (trigger instanceof HTMLButtonElement && !trigger.disabled) trigger.focus();
      else document.querySelector<HTMLElement>(".desk-main h1")?.focus();
    });
  }, [handoffTarget, handoffInvalid, show]);

  const run = async (action: DesktopAction) => {
    if (!begin(action)) return false;
    try {
      keepPairing(await performAction(action));
      await refresh();
      return true;
    } catch (caught) {
      fail(caught, "操作沒有完成，請再試一次。");
      return false;
    } finally {
      end();
    }
  };

  /** Runs a confirmed dialog action under busyAction; a busy app refuses with fixed text. */
  const guarded = async (name: string, task: () => Promise<void>) => {
    if (!begin(name)) throw new Error(BUSY_TEXT);
    try {
      await task();
    } finally {
      end();
    }
  };

  const openLink = (target: ExternalTarget) =>
    void openExternal(target).catch((caught) => fail(caught, "無法開啟瀏覽器。"));

  const onViewAction = (action: ViewAction) => {
    switch (action) {
      case "configure_key":
        setDialog({ kind: "key" });
        return;
      case "restart_runtime":
        setDialog({ kind: "restart" });
        return;
      case "show_profile_setup":
        setRoute("overview");
        return;
      case "open_tunnel_releases":
        openLink("tunnel_releases");
        return;
      case "none":
        return;
      default:
        void run(action);
    }
  };

  const onConnectionAction = (action: ConnectionAction) => {
    const host = CONNECTION_HOST_ACTION[action];
    if (host) {
      void run(host);
      return;
    }
    switch (action) {
      case "restart_runtime":
        setDialog({ kind: "restart" });
        return;
      case "get_key":
        openLink("runtime_keys");
        return;
      case "download_client":
        openLink("tunnel_releases");
        return;
      case "forget_key":
        setDialog({ kind: "forget_key" });
        return;
      default:
        setDialog({ kind: "key" });
    }
  };

  const onCheckControl = (control: CheckControl) => {
    const host = CHECK_HOST_ACTION[control];
    if (host) {
      void run(host);
      return;
    }
    switch (control) {
      case "restart_runtime":
        setDialog({ kind: "restart" });
        return;
      case "open_tunnel_guide":
        openLink("tunnel_guide");
        return;
      case "show_projects":
        setRoute("projects");
        return;
      default:
        setDialog({ kind: "key" });
    }
  };

  /** Adds folders one by one (multi-select or drop) and reports them in one message. */
  const addProjects = async (picked: readonly string[]) => {
    const folders = [...new Set(picked)];
    if (!folders.length) return;
    if (folders.length > MAX_FOLDERS_PER_ADD) {
      show({
        tone: "warning",
        text: `一次最多加入 ${MAX_FOLDERS_PER_ADD} 個資料夾。`,
        source: "action",
      });
      return;
    }
    if (!begin("workspace_add")) {
      show({ tone: "warning", text: BUSY_TEXT, source: "action" });
      return;
    }
    const added: string[] = [];
    const failures: string[] = [];
    try {
      for (const folder of folders) {
        try {
          added.push((await addWorkspace(folder)).name);
        } catch (caught) {
          failures.push(errorText(caught, "無法加入這個資料夾。"));
        }
      }
      await refresh();
    } finally {
      end();
    }
    show(addProjectsNotice(added, failures));
  };

  const pickProjects = async () => {
    if (!begin("workspace_pick")) return;
    let picked: string[] = [];
    try {
      picked = await chooseWorkspaceFolders();
    } catch (caught) {
      fail(caught, "無法開啟資料夾選擇視窗。");
    } finally {
      end();
    }
    await addProjects(picked);
  };

  // Folders dropped onto 專案 are added like picked ones; nothing else listens for drops.
  const dropTarget = useRef<(folders: string[]) => void>(() => undefined);
  dropTarget.current = (folders) => {
    if (dialog) {
      show({ tone: "warning", text: "先關閉對話框，再把資料夾拖進來。", source: "action" });
      return;
    }
    void addProjects(folders);
  };
  const dropEnabled = route === "projects" && !handoffTarget && companion !== null;
  useEffect(() => {
    if (!dropEnabled) {
      setDropActive(false);
      return;
    }
    return onFolderDrop((drop) => {
      if (drop.type === "enter") setDropActive(drop.paths.length > 0);
      else if (drop.type === "leave") setDropActive(false);
      else if (drop.type === "drop") {
        setDropActive(false);
        dropTarget.current(drop.paths);
      }
    });
  }, [dropEnabled]);

  const copyCommand = () =>
    void copyText(mcpCommand).then(
      () => show({ tone: "success", text: "本機 MCP 指令已複製。", source: "action" }),
      () =>
        show({
          tone: "warning",
          text: "無法自動複製，請手動選取本機 MCP 指令。",
          source: "action",
        }),
    );

  const copyPairing = () => {
    if (!pairing?.url) return;
    const minutes = Math.max(1, Math.ceil(pairingRemainingMs / 60_000));
    void copyText(pairing.url).then(
      () =>
        show({
          tone: "success",
          text: `配對連結已複製，${minutes} 分鐘內有效；只貼到瀏覽器側欄。`,
          source: "action",
        }),
      () =>
        show({
          tone: "warning",
          text: "無法自動複製配對連結，請重新產生後再試。",
          source: "action",
        }),
    );
  };

  /** Saves the ID (the host restarts the workbench) and keeps the new pairing link. */
  const pairExtension = async (extensionId: string) => {
    const kept = keepPairing(await configureExtension(extensionId));
    await refresh();
    show({
      tone: "success",
      text: kept ? "Extension ID 已儲存，配對連結已產生。" : "Extension ID 已儲存。",
      source: "action",
    });
  };

  /**
   * First setup saves at once. 更換 Extension ID first confirms, because the workbench restart
   * ends commands, terminals, grants, pairings and pending requests like a runtime restart.
   */
  const saveExtension = async (extensionId: string) => {
    if (companion?.extension.configured)
      return new Promise<boolean>((settle) =>
        setDialog({ kind: "extension", extensionId, settle }),
      );
    if (!begin("configure_extension")) return false;
    try {
      await pairExtension(extensionId);
      return true;
    } catch (caught) {
      fail(caught, "無法建立瀏覽器配對。");
      return false;
    } finally {
      end();
    }
  };

  const reveal = (workspace: WorkspaceSummary) =>
    void revealWorkspace(workspace.id).catch((caught) =>
      fail(caught, "無法在檔案總管中顯示這個專案。"),
    );

  const busy = busyAction !== null;
  const statusLine = (page: "overview" | "diagnostics") => {
    const line = view && snapshot ? statusLineContent(page, view, snapshot, checkedAt, now) : null;
    return view && line ? (
      <StatusLine view={view} {...line} busyAction={busyAction} onAction={onViewAction} />
    ) : null;
  };
  const grid = {
    workspaces,
    paths,
    attention,
    unavailable: view?.chatgptUnavailable ?? true,
  };
  const adding = busyAction === "workspace_pick" || busyAction === "workspace_add";

  // The one notice slot and the approvals live region, apart from the connection chip's.
  const headSlot = (
    <>
      <NoticeSlot notice={notice} onDismiss={dismiss} />
      <p className="k-sr-only" role="status">
        {attention.pending ? `需確認 ${attention.pending} 件，請在瀏覽器側欄審核` : ""}
      </p>
    </>
  );

  let content = null;
  let trailing = null;
  // The handoff page brings its own header (title, back, stepper) and hosts the slot under it.
  let ownHeader = false;
  if (!snapshot || !view) content = <OverviewSkeleton />;
  else if (route === "overview")
    content = (
      <OverviewPage
        view={view}
        statusLine={statusLine("overview")}
        attention={attention}
        grantsReadable={Boolean(
          companion && ["running", "external"].includes(companion.workbench.state),
        )}
        now={now}
        setupHandlers={{
          busy,
          mcpCommand,
          mcpCommandError,
          profileMissing: view.setup?.profileMissing ?? false,
          onAddProject: () => void pickProjects(),
          onOpenExternal: openLink,
          onCopyCommand: copyCommand,
          onAcknowledgeProfile: () => {
            writeFlag(PROFILE_ACK_KEY);
            setProfileAcknowledged(true);
          },
          onRestartTunnel: () => void run("restart_tunnel"),
          onConfigureKey: () => setDialog({ kind: "key" }),
          onPair: () => setRoute("connection"),
          onOpenConnectors: () => void run("open_connectors"),
        }}
        projects={
          companion ? { ...grid, addWaiting: busy, onAdd: () => void pickProjects() } : null
        }
      />
    );
  else if (route === "projects") {
    if (handoffTarget && !handoffInvalid) {
      ownHeader = true;
      content = (
        <HandoffFlow
          workspace={handoffTarget}
          notify={notifyHandoff}
          slot={headSlot}
          onClose={() => {
            const returnId = projectMenuId(handoffTarget.id);
            setHandoffTarget(null);
            requestAnimationFrame(() => document.getElementById(returnId)?.focus());
          }}
        />
      );
    } else {
      if (workspaces.length)
        trailing = (
          <button
            className="k-btn k-btn--secondary"
            type="button"
            aria-busy={adding || undefined}
            {...waitable(busy, () => void pickProjects())}
          >
            <Icon icon={adding ? CircleNotch : Plus} spin={adding} />
            新增專案
          </button>
        );
      content = (
        <ProjectsPage
          grid={grid}
          busy={busy}
          canAdd={Boolean(companion)}
          dropActive={dropActive}
          handoffUnavailable={(workspace) =>
            handoffInvalidReason(snapshot, workspace.id, statusCurrent)
              ? "本機工作台恢復後才能使用"
              : null
          }
          onAdd={() => void pickProjects()}
          onRename={(workspace) => setDialog({ kind: "rename", workspace })}
          onReveal={reveal}
          onHandoff={setHandoffTarget}
          onRemove={(workspace) => setDialog({ kind: "remove", workspace })}
        />
      );
    }
  } else if (route === "connection")
    content = (
      <ConnectionPage
        snapshot={snapshot}
        now={now}
        busyAction={busyAction}
        mcpCommand={mcpCommand}
        mcpCommandError={mcpCommandError}
        pairing={pairing}
        pairingRemainingMs={pairingRemainingMs}
        onAction={onConnectionAction}
        onSaveExtension={saveExtension}
        onCopyPairing={copyPairing}
        onCopyCommand={copyCommand}
      />
    );
  else
    content = (
      <DiagnosticsPage
        snapshot={snapshot}
        statusLine={statusLine("diagnostics")}
        statusAction={view.state === "ready" ? "none" : view.action}
        now={now}
        busyAction={busyAction}
        loadDiagnostics={getDiagnostics}
        copyText={copyText}
        onControl={onCheckControl}
        onCopyFailed={() =>
          show({ tone: "warning", text: "無法自動複製診斷摘要，請再試一次。", source: "action" })
        }
      />
    );

  return (
    <div className="k-app desk">
      <Sidebar
        route={route}
        onNavigate={(next) => {
          // Leaving through the sidebar ends a handoff; its draft is cancelled on unmount.
          setHandoffTarget(null);
          setRoute(next);
        }}
        projectCount={companion ? workspaces.length : null}
        view={view}
        version={snapshot?.version || VERSION}
      />
      <main className="desk-main" aria-busy={!snapshot}>
        <div className="desk-body">
          {ownHeader ? null : (
            <header className="desk-head">
              <div className="desk-page-head">
                <h1 className="k-page-title" id="page-title" tabIndex={-1}>
                  {PAGE_TITLES[route]}
                </h1>
                {trailing}
              </div>
              {headSlot}
            </header>
          )}
          {content}
        </div>
      </main>

      {dialog?.kind === "key" ? (
        <KeyDialog
          onClose={() => closeDialog(dialog)}
          onSaved={async () => {
            await refresh();
            // The status line says what the Tunnel does next; the notice only confirms the save.
            show({ tone: "success", text: "金鑰已保存。", source: "action" });
          }}
        />
      ) : null}
      {dialog?.kind === "restart" ? (
        <ConfirmDialog
          title="重新啟動本機服務？"
          consequence={restartConsequence(snapshot, now)}
          confirmLabel="重新啟動"
          blocked={busy}
          onClose={() => closeDialog(dialog)}
          onConfirm={() =>
            guarded("restart_runtime", async () => {
              await performAction("restart_runtime");
              await refresh();
            })
          }
        />
      ) : null}
      {dialog?.kind === "forget_key" ? (
        <ConfirmDialog
          title="移除 Runtime API Key？"
          consequence="安全通道會立即中斷，直到你重新設定金鑰。"
          confirmLabel="移除金鑰"
          blocked={busy}
          onClose={() => closeDialog(dialog)}
          onConfirm={() =>
            guarded("forget_key", async () => {
              await forgetRuntimeApiKey();
              await refresh();
              show({ tone: "success", text: "已移除 Runtime API Key。", source: "action" });
            })
          }
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameDialog
          name={dialog.workspace.name}
          onClose={() => closeDialog(dialog)}
          onRename={(name) =>
            guarded("workspace_rename", async () => {
              const renamed = await renameWorkspace(dialog.workspace.id, name);
              await refresh();
              show({ tone: "success", text: `已改名為「${renamed.name}」。`, source: "action" });
            })
          }
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <ConfirmDialog
          title={`解除掛載 ${dialog.workspace.name}？`}
          consequence="檔案會留在原處；ChatGPT 之後無法再讀取這個專案。"
          confirmLabel="解除掛載"
          blocked={busy}
          onClose={() => closeDialog(dialog)}
          onConfirm={() =>
            guarded("workspace_remove", async () => {
              await removeWorkspace(dialog.workspace.id);
              await refresh();
              show({
                tone: "success",
                text: `已解除掛載「${dialog.workspace.name}」；檔案留在原處。`,
                source: "action",
              });
            })
          }
        />
      ) : null}
      {dialog?.kind === "extension" ? (
        <ConfirmDialog
          title="更換 Extension ID？"
          consequence={extensionChangeConsequence(snapshot, now)}
          confirmLabel="儲存並配對"
          blocked={busy}
          onClose={() => {
            // A save already settled true; a cancel keeps the typed ID in the form.
            dialog.settle(false);
            closeDialog(dialog);
          }}
          onConfirm={() =>
            guarded("configure_extension", async () => {
              await pairExtension(dialog.extensionId);
              dialog.settle(true);
            })
          }
        />
      ) : null}
      {dialog?.kind === "close_hint" ? (
        <CloseHintDialog
          onClose={() => closeDialog(dialog)}
          onHide={() => {
            closeDialog(dialog);
            void hideMainWindow().catch(() => undefined);
          }}
        />
      ) : null}
    </div>
  );
}
