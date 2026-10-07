import {
  ArrowClockwise,
  ArrowSquareOut,
  Check,
  CircleNotch,
  Copy,
  Database,
  Desktop,
  DownloadSimple,
  Folder,
  HardDrives,
  Key,
  LockKey,
  type Icon as PhosphorIcon,
  ShieldCheck,
  SidebarSimple,
  Terminal,
  Toolbox,
} from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAction } from "./api.ts";
import {
  CHECK_CONTROL_LABELS,
  type CheckControl,
  type CheckRow,
  type CheckRowId,
  deriveCheckRows,
  ENVIRONMENT_CHECKS,
  snapshotSummary,
} from "./checks.ts";
import { Icon, Section, StatePill, StateTile, waitable } from "./components.tsx";
import { focusControl, focusHeading, focusScope } from "./focus.ts";
import { formatChecked } from "./format.ts";
import type { DesktopSnapshot, DiagnosticsReport, ViewAction } from "./model.ts";

const ROW_ICONS: Record<CheckRowId, PhosphorIcon> = {
  runtime: Desktop,
  workbench: Toolbox,
  tunnel_client: DownloadSimple,
  key: Key,
  tunnel: LockKey,
  panel: SidebarSimple,
  workspaces: Folder,
  data_dir: Database,
  codex_cli: Terminal,
  mcp_config: HardDrives,
};

/** The host call behind a control, so only that button spins while it runs. */
export const CHECK_HOST_ACTION: Partial<Record<CheckControl, DesktopAction>> = {
  retry_workbench: "retry_workbench",
  stop_tunnel: "stop_tunnel",
  restart_tunnel: "restart_tunnel",
  start_tunnel: "start_tunnel",
};

/** How long 已複製 stays on the copy button. */
const COPIED_MS = 2000;

function CheckItem({
  row,
  busyAction,
  onControl,
}: {
  row: CheckRow;
  busyAction: string | null;
  onControl: (control: CheckControl, trigger: HTMLButtonElement) => void;
}) {
  const nameId = `check-${row.id}`;
  const control = row.control;
  const host = control ? CHECK_HOST_ACTION[control] : undefined;
  const running = host !== undefined && busyAction === host;
  return (
    <li
      className="desk-health"
      data-state={row.tone === "danger" || row.tone === "warning" ? "fail" : undefined}
      {...focusScope}
    >
      <StateTile tone={row.tone} icon={ROW_ICONS[row.id]} />
      {/* A control that goes away after its action hands focus to the row name. */}
      <span className="desk-health__name" id={nameId} {...focusHeading}>
        {row.name}
      </span>
      <StatePill tone={row.tone} icon={row.pillIcon} label={row.pill} />
      <span className="desk-health__detail">{row.detail}</span>
      <span className="desk-health__action">
        {control ? (
          <button
            className="k-btn k-btn--quiet k-btn--sm"
            type="button"
            aria-busy={running || undefined}
            aria-describedby={nameId}
            {...focusControl}
            // Host calls wait for each other; a dialog, page or link opens at any time.
            {...waitable(
              (host !== undefined || control === "restart_runtime") && busyAction !== null,
              (event) => onControl(control, event.currentTarget),
            )}
          >
            {running ? <Icon icon={CircleNotch} size="sm" spin /> : null}
            {CHECK_CONTROL_LABELS[control]}
            {control === "open_tunnel_guide" ? <Icon icon={ArrowSquareOut} size="sm" /> : null}
          </button>
        ) : null}
      </span>
    </li>
  );
}

type Load = {
  state: "loading" | "ready" | "failed";
  report: DiagnosticsReport | null;
  at: number | null;
};

/**
 * 疑難排解 (A4): the status line with its pathway (unless all is well), then one row per
 * component with one fact and at most one control, then the privacy sentence and 複製診斷摘要.
 * The summary holds state codes and versions only; nothing here shows logs, paths or host
 * messages.
 */
export function DiagnosticsPage({
  snapshot,
  statusLine,
  statusAction,
  now,
  busyAction,
  loadDiagnostics,
  copyText,
  onControl,
  onCopyFailed,
}: {
  snapshot: DesktopSnapshot;
  /** The status line with its pathway; null while everything works (the sidebar chip says so). */
  statusLine: ReactNode;
  /** The status line's fix; rows never offer the same action a second time. */
  statusAction: ViewAction;
  now: number;
  busyAction: string | null;
  loadDiagnostics: () => Promise<DiagnosticsReport>;
  copyText: (text: string) => Promise<void>;
  onControl: (control: CheckControl, trigger: HTMLButtonElement) => void;
  onCopyFailed: () => void;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading", report: null, at: null });
  const [copied, setCopied] = useState(false);
  const revision = useRef(0);
  const reachable = snapshot.runtime.state === "running" && snapshot.companion !== null;
  const workspaceKey = snapshot.companion?.workspaces.map((workspace) => workspace.id).join(",");

  const check = useCallback(() => {
    const current = ++revision.current;
    setLoad((previous) => ({ ...previous, state: "loading" }));
    loadDiagnostics().then(
      (report) => {
        if (current === revision.current) setLoad({ state: "ready", report, at: Date.now() });
      },
      () => {
        if (current === revision.current)
          setLoad({ state: "failed", report: null, at: Date.now() });
      },
    );
  }, [loadDiagnostics]);

  // Checked on arrival, and again when the service comes or goes or projects change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reachable and workspaceKey are the triggers.
  useEffect(() => {
    check();
    return () => {
      revision.current++;
    };
  }, [check, reachable, workspaceKey]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copySummary = async () => {
    // A fresh read so the summary matches what is on screen; the status alone if that fails.
    const summary = await loadDiagnostics().then(
      (report) => report.summary,
      () => snapshotSummary(snapshot),
    );
    try {
      await copyText(summary);
      setCopied(true);
    } catch {
      onCopyFailed();
    }
  };

  const rows = deriveCheckRows({
    snapshot,
    checks: load.report?.checks ?? null,
    now,
    statusAction,
  });
  const loading = load.state === "loading" && !load.report;

  return (
    <>
      {statusLine}
      <Section
        id="checks-title"
        title="檢查項目"
        trailing={
          <span className="desk-section__tools">
            <span className="k-meta">
              {load.state === "loading" ? "正在檢查…" : formatChecked(load.at, now)}
            </span>
            <button
              className="k-btn k-btn--quiet k-btn--sm"
              type="button"
              aria-busy={load.state === "loading" || undefined}
              {...waitable(load.state === "loading", check)}
            >
              <Icon
                icon={load.state === "loading" ? CircleNotch : ArrowClockwise}
                size="sm"
                spin={load.state === "loading"}
              />
              重新檢查
            </button>
          </span>
        }
      >
        <ul className="k-card desk-health-list" aria-busy={loading}>
          {rows.map((row) => (
            <CheckItem key={row.id} row={row} busyAction={busyAction} onControl={onControl} />
          ))}
          {loading
            ? ENVIRONMENT_CHECKS.map((id) => (
                <li key={id} className="desk-health desk-health--skeleton" aria-hidden="true">
                  <span className="k-kind" />
                  <span className="k-skeleton" />
                  <span className="k-skeleton" />
                </li>
              ))
            : null}
          {load.state === "failed" ? (
            <li className="desk-health-note">
              {reachable
                ? "暫時讀不到資料目錄、專案資料夾、Codex CLI 與 MCP 設定的檢查結果。"
                : "本機服務啟動後，才能檢查標示「等待」的項目，以及資料目錄、專案資料夾、Codex CLI 與 MCP 設定。"}
            </li>
          ) : null}
        </ul>
      </Section>
      <div className="desk-privacy">
        <Icon icon={ShieldCheck} size="lg" />
        <p>診斷摘要只含狀態代碼與版本，不含金鑰、路徑或專案內容。</p>
        <button
          className="k-btn k-btn--secondary k-btn--sm"
          type="button"
          onClick={() => void copySummary()}
        >
          <Icon icon={copied ? Check : Copy} size="sm" />
          {copied ? "已複製" : "複製診斷摘要"}
        </button>
        <span className="k-sr-only" role="status">
          {copied ? "診斷摘要已複製" : ""}
        </span>
      </div>
    </>
  );
}
