import { tunnelFix } from "../../../packages/protocol/src/diagnostics.ts";
import { VERSION } from "../../../packages/protocol/src/index.ts";
import type {
  CompanionStatus,
  CompanionTunnelStatus,
  DesktopSnapshot,
  DiagnosticCheck,
  WorkspacePath,
  WorkspaceSummary,
} from "./model.ts";

/**
 * Synthetic data for the browser preview (`bun run desktop:web`, `?demo=<mode>`). Every value
 * is made up: no real path, key, token, URL, log or workspace content appears here.
 */
export const DEMO_MODES = [
  "setup",
  "waiting",
  "ready",
  "empty",
  "attention",
  "error",
  "tunnel-auth",
  "tunnel-retry",
  "runtime-error",
  "mismatch",
] as const;
export type DemoMode = (typeof DEMO_MODES)[number];

export type DemoState = {
  mode: DemoMode;
  credential: boolean;
  workspaces: WorkspaceSummary[];
  /** Synthetic clock origin: grant expiry and the last MCP call are fixed relative to it. */
  startedAt: number;
  sequence: number;
};

const OLDER_VERSION = "0.1.4";
const MINUTE = 60_000;

const ATHORI: WorkspaceSummary = {
  id: "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4",
  name: "Athori",
  capabilities: ["read", "write_request"],
};
const LUMEN: WorkspaceSummary = {
  id: "8c0f3a51-6d2e-4b7a-9f14-3e5d2c1b0a99",
  name: "Lumen Notes",
  capabilities: ["read", "write_request"],
};

/** `?demo=` value: none is setup (first launch); anything unknown keeps the waiting state. */
export function demoMode(search: string): DemoMode {
  const value = new URLSearchParams(search).get("demo");
  if (value === null) return "setup";
  return DEMO_MODES.find((mode) => mode === value) ?? "waiting";
}

export function createDemoState(mode: DemoMode, now = Date.now()): DemoState {
  return {
    mode,
    credential: mode !== "setup",
    workspaces: mode === "empty" ? [] : mode === "attention" ? [ATHORI, LUMEN] : [ATHORI],
    startedAt: now,
    sequence: 0,
  };
}

function iso(time: number) {
  return new Date(time).toISOString();
}

function tunnelStatus(state: DemoState, now: number): CompanionTunnelStatus {
  const base = { meta: "Profile · kairomes", restartCount: 0, nextRetryAt: null };
  if (!state.credential)
    return {
      ...base,
      state: "stopped",
      label: "已停止",
      message: "Tunnel 目前沒有執行。",
      logs: [],
      startedAt: null,
      reason: null,
    };
  if (state.mode === "tunnel-auth")
    return {
      ...base,
      state: "error",
      label: "需要處理",
      message: "Tunnel 啟動後停止（Exit 1）；展開最近訊息查看原因。",
      logs: ['{"level":"ERROR","msg":"control plane rejected the credential","status":401}'],
      startedAt: null,
      reason: "auth",
    };
  if (state.mode === "tunnel-retry") {
    // Rolling 10-second countdown so the preview always shows an upcoming retry.
    const retryIn = 10_000 - ((now - state.startedAt) % 10_000);
    return {
      ...base,
      state: "error",
      label: "需要處理",
      message: "Tunnel 意外停止（Exit 1）；稍後會自動重新啟動。",
      logs: ['{"level":"WARN","msg":"dial tcp: i/o timeout"}'],
      startedAt: null,
      reason: "network",
      restartCount: 1,
      nextRetryAt: iso(now + retryIn),
    };
  }
  if (state.mode === "error")
    return {
      ...base,
      state: "error",
      label: "需要處理",
      message: "Tunnel 啟動後停止（Exit 1）；展開最近訊息查看原因。",
      logs: ['{"level":"ERROR","msg":"unexpected response from control plane"}'],
      startedAt: null,
      reason: "unknown",
      restartCount: 3,
    };
  return {
    ...base,
    state: "running",
    label: "執行中",
    message: "官方 Tunnel 正在背景執行；關閉這個頁面不會中斷。",
    logs: [],
    startedAt: iso(state.startedAt - 38 * MINUTE),
    reason: null,
  };
}

function companionStatus(state: DemoState, now: number): CompanionStatus {
  const tunnel = tunnelStatus(state, now);
  const mismatch = state.mode === "mismatch";
  const lastMcpRequestAt =
    state.mode === "attention"
      ? iso(state.startedAt - 2 * MINUTE)
      : state.mode === "ready"
        ? iso(state.startedAt - 20_000)
        : null;
  const connector =
    tunnel.state !== "running"
      ? {
          state: "blocked" as const,
          label: "尚未就緒",
          message: "先讓本機工作台與 Tunnel 都進入執行中。",
          meta: "不會假裝已連上 ChatGPT",
        }
      : lastMcpRequestAt
        ? {
            state: "connected" as const,
            label: "最近有連線",
            message: "Kairomes 已收到 ChatGPT 的 MCP 請求。",
            meta: `最近呼叫 · ${new Date(lastMcpRequestAt).toLocaleString("zh-TW")}`,
          }
        : {
            state: "waiting" as const,
            label: "等待 ChatGPT",
            message: "Tunnel 已執行；若工具尚未出現，請在 ChatGPT Connector 按重新整理。",
            meta: "尚未收到這次啟動後的 MCP 請求",
          };
  const overall =
    connector.state === "connected"
      ? { tone: "good" as const, label: "ChatGPT 與本機工具已連線" }
      : tunnel.state === "running"
        ? { tone: "busy" as const, label: "等待 ChatGPT 使用工具" }
        : { tone: "warn" as const, label: "有一件事情需要處理" };
  const pending =
    state.mode === "attention"
      ? {
          total: 2,
          byWorkspace: [
            { workspace_id: ATHORI.id, count: 1 },
            { workspace_id: LUMEN.id, count: 1 },
          ],
        }
      : { total: 0, byWorkspace: [] };
  return {
    version: VERSION,
    workbenchVersion: mismatch ? OLDER_VERSION : VERSION,
    versionMismatch: mismatch,
    overall,
    workspaces: state.workspaces,
    workbench: mismatch
      ? {
          state: "external",
          label: "既有程序",
          message: `既有工作台版本 ${OLDER_VERSION} 與 Kairomes ${VERSION} 不同；停止舊程序後按重新接管。`,
          meta: "既有工作台保持原本生命週期",
        }
      : {
          state: "running",
          label: "執行中",
          message: "工作台由 Companion 管理；完全退出時會安全關閉。",
          meta: `${state.workspaces.length} 個專案 · 本機隨機連接埠`,
        },
    tunnel,
    connector,
    extension: { configured: true },
    attention: {
      pending,
      // An external workbench's grants cannot be read in-process.
      grants: mismatch
        ? null
        : state.mode === "attention"
          ? [
              {
                workspace_id: ATHORI.id,
                level: "full",
                expires_at: iso(state.startedAt + 12 * MINUTE),
              },
            ]
          : [],
      grantsKnown: !mismatch,
      lastMcpRequestAt,
      pairedPanels: mismatch ? null : state.mode === "attention" || state.mode === "ready" ? 1 : 0,
    },
  };
}

/** One synthetic status read; each call is newer than the last. */
export function demoSnapshot(state: DemoState, now = Date.now()): DesktopSnapshot {
  state.sequence += 1;
  const runtimeFailed = state.mode === "runtime-error";
  const companion = runtimeFailed ? null : companionStatus(state, now);
  return {
    version: VERSION,
    sequence: state.sequence,
    credentialConfigured: state.credential,
    tunnelClientInstalled: true,
    runtime: runtimeFailed
      ? { state: "error", owned: true, message: "Kairomes 本機服務已停止（Exit 1）。" }
      : { state: "running", owned: true, message: "本機服務由 Kairomes Desktop 管理。" },
    companion,
    versionMismatch: companion?.versionMismatch ?? false,
  };
}

/** Synthetic checks shaped like collectDiagnostics() for the same state. */
export function demoDiagnostics(state: DemoState, now = Date.now()): DiagnosticCheck[] {
  if (state.mode === "runtime-error") throw new Error("Kairomes 本機服務尚未回應。");
  const companion = companionStatus(state, now);
  const tunnel = companion.tunnel;
  const tunnelCheck: DiagnosticCheck =
    tunnel.state === "running"
      ? { id: "tunnel", state: "ok", code: "tunnel_running" }
      : tunnel.state === "stopped"
        ? { id: "tunnel", state: "warn", code: "tunnel_stopped", fix: "start_tunnel" }
        : tunnel.nextRetryAt
          ? {
              id: "tunnel",
              state: "warn",
              code: "tunnel_retrying",
              reason: tunnel.reason ?? "unknown",
            }
          : {
              id: "tunnel",
              state: "error",
              code: "tunnel_failed",
              reason: tunnel.reason ?? "unknown",
              fix: tunnelFix(tunnel.reason ?? "unknown"),
            };
  const workspaces = state.workspaces.length;
  return [
    { id: "data_dir", state: "ok", code: "data_dir_ok" },
    { id: "companion", state: "ok", code: "companion_running", version: VERSION },
    state.mode === "mismatch"
      ? {
          id: "workbench",
          state: "warn",
          code: "workbench_version_mismatch",
          fix: "retry_workbench",
          version: OLDER_VERSION,
        }
      : { id: "workbench", state: "ok", code: "workbench_running", version: VERSION },
    { id: "tunnel_client", state: "ok", code: "tunnel_client_found" },
    tunnelCheck,
    state.mode === "setup" || state.mode === "empty"
      ? { id: "codex_cli", state: "warn", code: "codex_cli_missing", fix: "show_codex_help" }
      : { id: "codex_cli", state: "ok", code: "codex_cli_found" },
    state.mode === "attention"
      ? { id: "mcp_config", state: "ok", code: "mcp_config_ok", count: 2 }
      : { id: "mcp_config", state: "ok", code: "mcp_config_absent", count: 0 },
    workspaces === 0
      ? { id: "workspaces", state: "warn", code: "workspaces_none", fix: "add_workspace" }
      : { id: "workspaces", state: "ok", code: "workspaces_ok", count: workspaces },
  ];
}

/** Synthetic roots for display only; they do not exist on any machine. */
export function demoWorkspacePaths(state: DemoState): WorkspacePath[] {
  return state.workspaces.map(({ id, name }) => ({
    id,
    root: `C:\\Users\\you\\Projects\\${name.replace(/[^\p{L}\p{N}._-]+/gu, "-")}`,
  }));
}
