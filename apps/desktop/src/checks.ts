import {
  type DiagnosticCheck,
  type DiagnosticCheckId,
  diagnosticSummary,
  tunnelFix,
} from "../../../packages/protocol/src/diagnostics.ts";
import { formatUptime, secondsUntil } from "./format.ts";
import {
  type DesktopSnapshot,
  PROFILE_FACT,
  PROFILE_NAME,
  type ViewAction,
  versionIssue,
} from "./model.ts";

/**
 * 疑難排解 rows (A4): one fact and at most one allowlisted control per component. The parts of
 * the connection path (本機服務, 工作台, tunnel-client, 金鑰, 安全通道, 側欄) follow the pushed
 * status, so a row never lags behind the sidebar chip; the environment checks the status does
 * not carry (資料目錄, 專案, Codex CLI, MCP 設定) come from get_diagnostics. Every sentence is
 * fixed text chosen by enum; no path, URL, log line or host message reaches a row.
 */

export type RowTone = "success" | "running" | "warning" | "danger" | "neutral";

/** Icon shown in a state pill; colour is never the only signal. */
export type PillIcon =
  | "Check"
  | "CircleNotch"
  | "WarningCircle"
  | "XCircle"
  | "PauseCircle"
  | "MinusCircle"
  | "HourglassMedium"
  | "Question";

export const TONE_PILL_ICON: Record<RowTone, PillIcon> = {
  success: "Check",
  running: "CircleNotch",
  warning: "WarningCircle",
  danger: "XCircle",
  neutral: "MinusCircle",
};

/** The only controls a check row may offer; each maps to an allowlisted host call or a page. */
export type CheckControl =
  | "restart_runtime"
  | "retry_workbench"
  | "stop_tunnel"
  | "restart_tunnel"
  | "start_tunnel"
  | "set_key"
  | "update_key"
  | "open_tunnel_guide"
  | "show_projects";

export const CHECK_CONTROL_LABELS: Record<CheckControl, string> = {
  restart_runtime: "重新啟動…",
  retry_workbench: "重試工作台",
  stop_tunnel: "停止安全通道",
  restart_tunnel: "重新啟動安全通道",
  start_tunnel: "啟動安全通道",
  set_key: "設定金鑰",
  update_key: "更新金鑰",
  open_tunnel_guide: "安裝說明",
  show_projects: "前往專案",
};

/** The status line's fix, as the row control that would repeat it. */
const STATUS_CONTROL: Partial<Record<ViewAction, CheckControl[]>> = {
  restart_runtime: ["restart_runtime"],
  retry_workbench: ["retry_workbench"],
  restart_tunnel: ["restart_tunnel"],
  start_tunnel: ["start_tunnel"],
  configure_key: ["set_key", "update_key"],
};

export type CheckRowId =
  | "runtime"
  | "workbench"
  | "tunnel_client"
  | "key"
  | "tunnel"
  | "panel"
  | "workspaces"
  | "data_dir"
  | "codex_cli"
  | "mcp_config";

export type CheckRow = {
  id: CheckRowId;
  name: string;
  tone: RowTone;
  pill: string;
  pillIcon: PillIcon;
  /** One new fact; empty when the pill says it all. */
  detail: string;
  control: CheckControl | null;
};

/** Checks the pushed status cannot answer; they come from get_diagnostics. */
export const ENVIRONMENT_CHECKS = ["workspaces", "data_dir", "codex_cli", "mcp_config"] as const;
type EnvironmentId = (typeof ENVIRONMENT_CHECKS)[number];

const NAMES: Record<CheckRowId, string> = {
  runtime: "本機服務",
  workbench: "工作台",
  tunnel_client: "tunnel-client",
  key: "Runtime API Key",
  tunnel: "安全通道",
  panel: "瀏覽器側欄",
  workspaces: "專案資料夾",
  data_dir: "資料目錄",
  codex_cli: "Codex CLI",
  mcp_config: "MCP 伺服器設定",
};

function row(
  id: CheckRowId,
  tone: RowTone,
  pill: string,
  detail: string,
  control: CheckControl | null = null,
  pillIcon: PillIcon = TONE_PILL_ICON[tone],
): CheckRow {
  return { id, name: NAMES[id], tone, pill, pillIcon, detail, control };
}

/*
 * 疑難排解 shows a status line with the cause and the fix whenever something is wrong, so a
 * failing or starting row never repeats it: its detail is another fact (who started it, the
 * profile, how often it retried) or empty when the pill already says everything. A row that
 * waits for the local service says so with its 等待 pill only; the note under the list says
 * once what the service is needed for.
 */

function runtimeRow(snapshot: DesktopSnapshot): CheckRow {
  const companion = snapshot.companion;
  if (snapshot.runtime.state === "starting" || (snapshot.runtime.state === "running" && !companion))
    return row("runtime", "running", "啟動中", "");
  if (!companion || snapshot.runtime.state !== "running")
    return row(
      "runtime",
      "danger",
      "已停止",
      snapshot.runtime.owned ? "由 Kairomes Desktop 啟動" : "由其他程式啟動",
      "restart_runtime",
    );
  // The status line names both versions; the row says who started the service.
  if (versionIssue(snapshot)?.side === "companion")
    return row(
      "runtime",
      "warning",
      "版本不同",
      snapshot.runtime.owned ? "由 Kairomes Desktop 啟動" : "由其他程式啟動",
      "restart_runtime",
    );
  const owner = snapshot.runtime.owned ? "" : " · 由其他程式啟動";
  return row("runtime", "success", "正常", `版本 ${companion.version}${owner}`, "restart_runtime");
}

function workbenchRow(snapshot: DesktopSnapshot): CheckRow {
  const companion = snapshot.companion;
  if (!companion) return row("workbench", "neutral", "等待", "", null, "HourglassMedium");
  const state = companion.workbench.state;
  if (state === "starting") return row("workbench", "running", "啟動中", "");
  if (state !== "running" && state !== "external")
    return row(
      "workbench",
      "danger",
      "無法使用",
      state === "stopped" ? "工作台已停止" : "工作台沒有回應",
      "retry_workbench",
    );
  const version = companion.workbenchVersion ?? "版本不明";
  if (companion.versionMismatch) {
    const issue = versionIssue(snapshot);
    return row(
      "workbench",
      "warning",
      "版本不同",
      state === "external" ? "由其他程式啟動" : "由本機服務啟動",
      issue?.side === "workbench" ? issue.action : "restart_runtime",
    );
  }
  return row(
    "workbench",
    "success",
    "正常",
    state === "external" ? `由其他程式啟動 · 版本 ${version}` : `版本 ${version}`,
  );
}

function clientFound(snapshot: DesktopSnapshot) {
  const tunnel = snapshot.companion?.tunnel;
  return (
    snapshot.tunnelClientInstalled &&
    tunnel?.state !== "missing" &&
    tunnel?.reason !== "not_installed"
  );
}

function clientRow(snapshot: DesktopSnapshot): CheckRow {
  return clientFound(snapshot)
    ? row("tunnel_client", "success", "正常", "已安裝在這台電腦")
    : row("tunnel_client", "warning", "找不到", "放進 PATH 後會自動偵測", "open_tunnel_guide");
}

function keyRejected(snapshot: DesktopSnapshot) {
  const tunnel = snapshot.companion?.tunnel;
  return tunnel?.state === "error" && tunnel.reason === "auth";
}

function keyRow(snapshot: DesktopSnapshot): CheckRow {
  if (!snapshot.credentialConfigured)
    return row("key", "warning", "尚未設定", "安全通道需要它才能啟動", "set_key");
  if (keyRejected(snapshot)) return row("key", "danger", "被拒絕", "由作業系統保管", "update_key");
  return row("key", "success", "已保存", "由作業系統保管");
}

function tunnelRow(snapshot: DesktopSnapshot, now: number): CheckRow {
  const tunnel = snapshot.companion?.tunnel;
  if (!tunnel) return row("tunnel", "neutral", "等待", "", null, "HourglassMedium");
  if (!clientFound(snapshot))
    return row("tunnel", "neutral", "等待", "需要 tunnel-client", null, "HourglassMedium");
  switch (tunnel.state) {
    case "running":
      return row(
        "tunnel",
        "success",
        "正常",
        formatUptime(tunnel.startedAt, now) ?? "執行中",
        "stop_tunnel",
      );
    case "starting":
      return row("tunnel", "running", "啟動中", PROFILE_FACT);
    case "stopped":
    case "missing":
      // Without a key, the key row above says the Tunnel needs it; this row adds the profile.
      return snapshot.credentialConfigured
        ? row("tunnel", "neutral", "已暫停", PROFILE_FACT, "start_tunnel", "PauseCircle")
        : row("tunnel", "neutral", "等待金鑰", PROFILE_FACT, null, "PauseCircle");
  }
  // The status line counts down to the next retry; the row says how many have run.
  const retried =
    tunnel.restartCount > 0 ? `近 5 分鐘已自動重試 ${tunnel.restartCount} 次` : PROFILE_FACT;
  if (secondsUntil(tunnel.nextRetryAt, now) !== null)
    return row("tunnel", "running", "自動重試中", retried);
  switch (tunnel.reason) {
    case "auth":
      // The key row carries the fix; this row only waits for it.
      return row("tunnel", "neutral", "等待金鑰", PROFILE_FACT, null, "PauseCircle");
    case "profile_missing":
      return row(
        "tunnel",
        "warning",
        "找不到 profile",
        `建立 ${PROFILE_NAME} profile 後再重新啟動`,
        "restart_tunnel",
      );
    case "workbench":
      // The workbench may still run: the fix is the confirmed restart (tunnelReasonAction).
      return row("tunnel", "danger", "中斷", retried, "restart_runtime");
    default:
      return row("tunnel", "danger", "中斷", retried, "restart_tunnel");
  }
}

function panelRow(snapshot: DesktopSnapshot): CheckRow {
  const companion = snapshot.companion;
  if (!companion) return row("panel", "neutral", "等待", "", null, "HourglassMedium");
  if (!companion.extension.configured)
    return row("panel", "neutral", "尚未配對", "到「連線設定」配對側欄");
  const paired = companion.attention.pairedPanels;
  if (paired === null)
    return row("panel", "neutral", "待確認", "這個工作台不回報配對", null, "Question");
  return paired > 0
    ? row("panel", "success", "正常", `已配對 ${paired} 個側欄`)
    : row("panel", "neutral", "未連線", "已設定，尚未配對");
}

function environmentRow(id: EnvironmentId, check: DiagnosticCheck | undefined): CheckRow {
  if (!check || check.state === "unknown")
    return row(id, "neutral", "無法確認", "", null, "Question");
  const count = typeof check.count === "number" ? check.count : null;
  switch (check.code) {
    case "workspaces_ok":
      return row(id, "success", "正常", count === null ? "都能讀取" : `${count} 個都能讀取`);
    case "workspaces_none":
      return row(id, "neutral", "尚未加入", "加入資料夾後 ChatGPT 才能讀取", "show_projects");
    case "workspaces_unavailable":
      return row(
        id,
        "warning",
        "找不到資料夾",
        count === null ? "有專案的資料夾已移動或刪除" : `${count} 個專案的資料夾已移動或刪除`,
        "show_projects",
      );
    case "data_dir_ok":
      return row(id, "success", "正常", "可以讀寫");
    case "data_dir_missing":
      return row(id, "neutral", "尚未建立", "第一次加入專案時會建立");
    case "data_dir_invalid":
      return row(id, "danger", "無法使用", "資料目錄不是一般資料夾");
    case "data_dir_unwritable":
      return row(id, "danger", "無法寫入", "Kairomes 無法保存設定與專案");
    case "codex_cli_found":
      return row(id, "success", "正常", "可以從 Codex 接續");
    case "codex_cli_missing":
      return row(id, "neutral", "未安裝", "安裝後才能從 Codex 接續");
    case "mcp_config_absent":
      return row(id, "success", "正常", "沒有加入其他 MCP 伺服器");
    case "mcp_config_ok":
      return row(id, "success", "正常", count === null ? "設定可以讀取" : `${count} 個 MCP 伺服器`);
    case "mcp_config_invalid":
      return row(
        id,
        "warning",
        "設定有誤",
        `${count === null ? "設定" : `${count} 個地方`}需要修正；請到側欄的 MCP 設定`,
      );
    case "mcp_config_cwd_relative":
      return row(
        id,
        "warning",
        "需要更新",
        `${count === null ? "有" : `${count} 個`}本機 MCP 的工作目錄需改為絕對路徑；請到側欄移除後重新加入`,
      );
    case "mcp_config_unreadable":
      return row(id, "warning", "無法讀取", "請到側欄的 MCP 設定檢查");
    default:
      return row(id, "neutral", "無法確認", "", null, "Question");
  }
}

/**
 * Rows in path order, then the environment checks when a report is available. A row never
 * repeats the status line's fix (`statusAction`), and no two rows offer the same control.
 */
export function deriveCheckRows({
  snapshot,
  checks,
  now,
  statusAction = "none",
}: {
  snapshot: DesktopSnapshot;
  /** get_diagnostics checks; null while loading or when the local service did not answer. */
  checks: readonly DiagnosticCheck[] | null;
  now: number;
  statusAction?: ViewAction;
}): CheckRow[] {
  const rows = [
    runtimeRow(snapshot),
    workbenchRow(snapshot),
    clientRow(snapshot),
    keyRow(snapshot),
    tunnelRow(snapshot, now),
    panelRow(snapshot),
  ];
  if (checks) {
    const byId = new Map<DiagnosticCheckId, DiagnosticCheck>(
      checks.map((check) => [check.id, check]),
    );
    for (const id of ENVIRONMENT_CHECKS) rows.push(environmentRow(id, byId.get(id)));
  }
  // Each control appears once per page: never again after the status line offers it, and a
  // row that needs the user keeps it before a healthy row does.
  const claimed = new Set<CheckControl>(STATUS_CONTROL[statusAction] ?? []);
  const keep = new Map<CheckRowId, boolean>();
  for (const current of [...rows.filter(rowNeedsAttention), ...rows]) {
    if (keep.has(current.id) || !current.control) continue;
    keep.set(current.id, !claimed.has(current.control));
    claimed.add(current.control);
  }
  return rows.map((current) =>
    current.control && keep.get(current.id) === false ? { ...current, control: null } : current,
  );
}

/** The failing rows: only these get a toned kind tile. */
export function rowNeedsAttention(current: CheckRow) {
  return current.tone === "danger" || current.tone === "warning";
}

/**
 * Checks Desktop can state from the pushed status alone, for a summary to copy when the local
 * service cannot run get_diagnostics. Same enums as the Companion's report, nothing else.
 */
export function snapshotChecks(snapshot: DesktopSnapshot): DiagnosticCheck[] {
  const companion = snapshot.companion;
  if (!companion)
    return [
      { id: "companion", state: "warn", code: "companion_unavailable", fix: "restart_runtime" },
    ];
  const checks: DiagnosticCheck[] = [
    snapshot.versionMismatch && companion.version !== snapshot.version
      ? {
          id: "companion",
          state: "warn",
          code: "companion_version_mismatch",
          fix: "restart_runtime",
          version: companion.version,
        }
      : { id: "companion", state: "ok", code: "companion_running", version: companion.version },
  ];
  const workbench = companion.workbench.state;
  const version = companion.workbenchVersion ?? undefined;
  checks.push(
    workbench === "starting"
      ? { id: "workbench", state: "warn", code: "workbench_starting" }
      : workbench === "stopped" || workbench === "error"
        ? {
            id: "workbench",
            state: "error",
            code: workbench === "stopped" ? "workbench_stopped" : "workbench_error",
            fix: "retry_workbench",
          }
        : companion.versionMismatch
          ? {
              id: "workbench",
              state: "warn",
              code: "workbench_version_mismatch",
              fix: workbench === "external" ? "retry_workbench" : "restart_runtime",
              ...(version ? { version } : {}),
            }
          : {
              id: "workbench",
              state: "ok",
              code: workbench === "external" ? "workbench_external" : "workbench_running",
              ...(version ? { version } : {}),
            },
  );
  checks.push(
    clientFound(snapshot)
      ? { id: "tunnel_client", state: "ok", code: "tunnel_client_found" }
      : {
          id: "tunnel_client",
          state: "warn",
          code: "tunnel_client_missing",
          fix: "show_tunnel_help",
        },
  );
  const tunnel = companion.tunnel;
  const reason = tunnel.reason ?? "unknown";
  checks.push(
    tunnel.state === "running"
      ? { id: "tunnel", state: "ok", code: "tunnel_running" }
      : tunnel.state === "starting"
        ? { id: "tunnel", state: "warn", code: "tunnel_starting" }
        : tunnel.state === "stopped"
          ? { id: "tunnel", state: "warn", code: "tunnel_stopped", fix: "start_tunnel" }
          : tunnel.nextRetryAt
            ? { id: "tunnel", state: "warn", code: "tunnel_retrying", reason }
            : {
                id: "tunnel",
                state: "error",
                code: "tunnel_failed",
                reason,
                fix: tunnelFix(reason),
              },
  );
  return checks;
}

/** Copyable summary from the pushed status alone: enums and versions only. */
export function snapshotSummary(snapshot: DesktopSnapshot): string {
  return diagnosticSummary(snapshotChecks(snapshot), snapshot.version);
}
