import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { WorkspaceDetail } from "../../../packages/protocol/src/companion.ts";
import {
  type DiagnosticCheck,
  type DiagnosticsReport,
  diagnosticSummary,
} from "../../../packages/protocol/src/diagnostics.ts";
import type { HandoffInput } from "../../../packages/protocol/src/handoff.ts";
import { VERSION } from "../../../packages/protocol/src/index.ts";
import { handoffError } from "./handoff-copy.ts";
import type { DesktopSnapshot, WorkspaceSummary } from "./model.ts";

/** The pairing link is a one-time credential: show it, never log or persist it. */
type PairingResult = { pairingUrl?: string; expiresInSeconds?: number };

let mockCredential = false;
let mockWorkspaces: WorkspaceSummary[] = [
  {
    id: "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4",
    name: "Athori",
    capabilities: ["read", "write_request"],
  },
];

function mockSnapshot(): DesktopSnapshot {
  const demo = new URLSearchParams(window.location.search).get("demo") ?? "setup";
  const credentialConfigured = mockCredential || demo !== "setup";
  const connectorState = demo === "ready" ? "connected" : "waiting";
  const tunnelState = demo === "error" ? "error" : credentialConfigured ? "running" : "stopped";
  return {
    credentialConfigured,
    tunnelClientInstalled: true,
    runtime: {
      state: demo === "runtime-error" ? "error" : "running",
      owned: true,
      message: demo === "runtime-error" ? "本機服務意外停止。" : "本機服務正在背景執行。",
    },
    companion: {
      version: VERSION,
      overall: { tone: demo === "ready" ? "good" : "busy", label: "Kairomes" },
      workspaces: mockWorkspaces,
      workbench: {
        state: "running",
        label: "執行中",
        message: "工作台由 Kairomes Desktop 管理。",
        meta: `${mockWorkspaces.length} 個專案 · 本機安全連線`,
      },
      tunnel: {
        state: tunnelState,
        label:
          tunnelState === "running" ? "執行中" : tunnelState === "error" ? "需要處理" : "已停止",
        message:
          tunnelState === "error"
            ? "Runtime API Key 無法通過驗證，請更新後再試一次。"
            : tunnelState === "running"
              ? "官方 Tunnel 正在背景執行。"
              : "等待安全連線設定。",
        meta: "Profile · kairomes",
        logs: demo === "error" ? ["Tunnel authentication failed."] : [],
      },
      connector: {
        state: connectorState,
        label: connectorState === "connected" ? "最近有連線" : "等待 ChatGPT",
        message:
          connectorState === "connected"
            ? "Kairomes 已收到 ChatGPT 的 MCP 請求。"
            : "請在 ChatGPT Connector 按重新整理。",
        meta: connectorState === "connected" ? "最近呼叫 · 剛剛" : "尚未收到 MCP 請求",
      },
      extension: { configured: true },
    },
  };
}

function inTauri() {
  return "__TAURI_INTERNALS__" in window;
}

export async function getDesktopStatus(): Promise<DesktopSnapshot> {
  return inTauri() ? invoke<DesktopSnapshot>("get_desktop_status") : mockSnapshot();
}

export async function getLocalMcpCommand(): Promise<string> {
  return inTauri()
    ? invoke<string>("get_local_mcp_command")
    : '"C:/Program Files/Kairomes/kairomes-runtime.exe" relay --stdio';
}

export async function saveRuntimeApiKey(apiKey: string): Promise<void> {
  if (inTauri()) await invoke("save_runtime_api_key", { apiKey });
  else mockCredential = true;
}

export async function forgetRuntimeApiKey(): Promise<void> {
  if (inTauri()) await invoke("forget_runtime_api_key");
  else mockCredential = false;
}

export async function performAction(action: string): Promise<PairingResult> {
  if (inTauri()) return invoke<PairingResult>("perform_action", { action });
  return action === "create_pairing"
    ? { pairingUrl: "http://127.0.0.1/pair#code=preview-only", expiresInSeconds: 120 }
    : {};
}

export async function configureExtension(extensionId: string): Promise<PairingResult> {
  if (inTauri()) return invoke<PairingResult>("configure_extension", { extensionId });
  return { pairingUrl: "http://127.0.0.1/pair#code=preview-only", expiresInSeconds: 120 };
}

export async function openExternal(target: "runtime_keys" | "chatgpt_connectors"): Promise<void> {
  if (inTauri()) await invoke("open_external", { target });
}

export async function chooseWorkspaceFolder(): Promise<string | null> {
  if (!inTauri()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    title: "選擇要加入 Kairomes 的專案資料夾",
  });
  return typeof selected === "string" ? selected : null;
}

export async function addWorkspace(path: string, name?: string): Promise<WorkspaceSummary> {
  if (inTauri()) return invoke<WorkspaceSummary>("add_workspace", { path, name });
  const label = name?.trim() || (path.split(/[\\/]/).filter(Boolean).at(-1) ?? "新專案");
  const workspace = {
    id: crypto.randomUUID(),
    name: label,
    capabilities: ["read", "write_request"],
  };
  mockWorkspaces = [...mockWorkspaces, workspace];
  return workspace;
}

export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSummary> {
  if (inTauri()) return invoke<WorkspaceSummary>("rename_workspace", { workspaceId, name });
  const label = name.trim();
  if (!label || label.length > 80) throw new Error("工作區名稱須為 1～80 個可見字元。");
  const current = mockWorkspaces.find((workspace) => workspace.id === workspaceId);
  if (!current) throw new Error("找不到已掛載的工作區。");
  const renamed = { ...current, name: label };
  mockWorkspaces = mockWorkspaces.map((workspace) =>
    workspace.id === workspaceId ? renamed : workspace,
  );
  return renamed;
}

/** Desktop only: absolute roots for display and reveal. Never send them to the widget or model. */
export async function getWorkspaceDetails(): Promise<WorkspaceDetail[]> {
  if (inTauri()) return invoke<WorkspaceDetail[]>("workspace_details");
  return mockWorkspaces.map(({ id, name }) => ({
    id,
    name,
    root: `C:\\Users\\you\\Projects\\${name}`,
  }));
}

export async function getDiagnostics(): Promise<DiagnosticsReport> {
  if (inTauri()) return invoke<DiagnosticsReport>("get_diagnostics");
  const tunnelFailed = new URLSearchParams(window.location.search).get("demo") === "error";
  const checks: DiagnosticCheck[] = [
    { id: "data_dir", state: "ok", code: "data_dir_ok" },
    { id: "companion", state: "ok", code: "companion_running", version: VERSION },
    { id: "workbench", state: "ok", code: "workbench_running", version: VERSION },
    { id: "tunnel_client", state: "ok", code: "tunnel_client_found" },
    tunnelFailed
      ? {
          id: "tunnel",
          state: "error",
          code: "tunnel_failed",
          reason: "auth",
          fix: "configure_key",
        }
      : { id: "tunnel", state: "ok", code: "tunnel_running" },
    { id: "codex_cli", state: "warn", code: "codex_cli_missing", fix: "show_codex_help" },
    { id: "mcp_config", state: "ok", code: "mcp_config_absent", count: 0 },
    { id: "workspaces", state: "ok", code: "workspaces_ok", count: mockWorkspaces.length },
  ];
  return { checks, summary: diagnosticSummary(checks, VERSION) };
}

export async function removeWorkspace(workspaceId: string): Promise<void> {
  if (inTauri()) await invoke("remove_workspace", { workspaceId });
  else mockWorkspaces = mockWorkspaces.filter((workspace) => workspace.id !== workspaceId);
}

export async function handoffRequest<T>(input: HandoffInput): Promise<T> {
  if (!inTauri()) throw new Error("接續需使用 Kairomes Desktop；此頁只提供介面預覽。");
  try {
    return await invoke<T>("handoff_request", { input });
  } catch (caught) {
    throw handoffError(caught);
  }
}
