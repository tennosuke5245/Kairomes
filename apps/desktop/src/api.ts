import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { diagnosticSummary } from "../../../packages/protocol/src/diagnostics.ts";
import type { HandoffInput } from "../../../packages/protocol/src/handoff.ts";
import { VERSION } from "../../../packages/protocol/src/index.ts";
import {
  createDemoState,
  type DemoState,
  demoDiagnostics,
  demoMode,
  demoSnapshot,
  demoWorkspacePaths,
} from "./demo.ts";
import { handoffError } from "./handoff-copy.ts";
import {
  type DesktopSnapshot,
  type DiagnosticsReport,
  normalizeDesktopSnapshot,
  type WireDesktopSnapshot,
  type WorkspacePath,
  type WorkspaceSummary,
} from "./model.ts";

/** The pairing link is a one-time credential: show it, never log or persist it. */
export type PairingResult = { pairingUrl?: string; expiresInSeconds?: number };

/** Companion actions the Rust host accepts from `perform_action`. */
export type DesktopAction =
  | "open_workbench"
  | "open_connectors"
  | "retry_workbench"
  | "start_tunnel"
  | "stop_tunnel"
  | "restart_tunnel"
  | "create_pairing"
  | "restart_runtime";

/** Fixed external pages; the Rust host owns the URLs and accepts nothing else. */
export const EXTERNAL_TARGETS = [
  "runtime_keys",
  "chatgpt_connectors",
  "tunnel_guide",
  "tunnel_releases",
  "platform_tunnels",
  "kairomes_releases",
] as const;
export type ExternalTarget = (typeof EXTERNAL_TARGETS)[number];

/** Rust pushes the same JSON as `get_desktop_status` on this event after every collection. */
export const DESKTOP_STATUS_EVENT = "desktop-status";
/** Rust asks the UI to confirm a runtime restart requested from the tray menu. */
export const CONFIRM_RESTART_EVENT = "desktop-confirm-restart";
/** Browser previews dispatch this DOM event on window to simulate the tray request. */
export const DEMO_CONFIRM_RESTART_EVENT = "kairomes-demo:confirm-restart";
/** Polling interval when Tauri events are unavailable (browser preview or fixtures). */
export const STATUS_POLL_INTERVAL_MS = 2000;

let demo: DemoState | undefined;

function demoState() {
  demo ??= createDemoState(demoMode(globalThis.location?.search ?? ""));
  return demo;
}

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function asError(caught: unknown, fallback: string) {
  if (caught instanceof Error) return caught;
  return new Error(typeof caught === "string" && caught ? caught : fallback);
}

/** Immediate status read for first paint and right after an action. */
export async function getDesktopStatus(): Promise<DesktopSnapshot> {
  if (!inTauri()) return demoSnapshot(demoState());
  return normalizeDesktopSnapshot(await invoke<WireDesktopSnapshot>("get_desktop_status"));
}

/**
 * Delivers an immediate snapshot, then every pushed `desktop-status` update. Falls back to
 * polling when Tauri events are unavailable. A snapshot already delivered or older than one
 * already delivered is skipped; sequence 0 (a fixture without ordering) is always delivered.
 * Returns an unsubscribe function.
 */
export function subscribeDesktopStatus(
  onSnapshot: (snapshot: DesktopSnapshot) => void,
  onError: (error: Error) => void = () => undefined,
): () => void {
  let active = true;
  let latest = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unlisten: (() => void) | undefined;
  const deliver = (snapshot: DesktopSnapshot) => {
    if (!active || (snapshot.sequence !== 0 && snapshot.sequence <= latest)) return;
    latest = Math.max(latest, snapshot.sequence);
    onSnapshot(snapshot);
  };
  const read = () => {
    getDesktopStatus().then(deliver, (caught: unknown) => {
      if (active) onError(asError(caught, "無法讀取 Kairomes 狀態。"));
    });
  };
  const poll = () => {
    if (!active || timer !== undefined) return;
    timer = setInterval(read, STATUS_POLL_INTERVAL_MS);
  };
  read();
  if (!inTauri()) poll();
  else
    listen<WireDesktopSnapshot>(DESKTOP_STATUS_EVENT, (event) =>
      deliver(normalizeDesktopSnapshot(event.payload)),
    ).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }, poll);
  return () => {
    active = false;
    if (timer !== undefined) clearInterval(timer);
    unlisten?.();
  };
}

/**
 * The tray asked to restart the local runtime. Show a confirmation, then call
 * `performAction("restart_runtime")` only if the user agrees. Returns an unsubscribe function.
 */
export function onConfirmRestart(callback: () => void): () => void {
  let active = true;
  if (!inTauri()) {
    const handler = () => {
      if (active) callback();
    };
    globalThis.addEventListener?.(DEMO_CONFIRM_RESTART_EVENT, handler);
    return () => {
      active = false;
      globalThis.removeEventListener?.(DEMO_CONFIRM_RESTART_EVENT, handler);
    };
  }
  let unlisten: (() => void) | undefined;
  listen(CONFIRM_RESTART_EVENT, () => {
    if (active) callback();
  }).then(
    (stop) => {
      if (active) unlisten = stop;
      else stop();
    },
    () => undefined,
  );
  return () => {
    active = false;
    unlisten?.();
  };
}

export async function getLocalMcpCommand(): Promise<string> {
  return inTauri()
    ? invoke<string>("get_local_mcp_command")
    : '"C:/Program Files/Kairomes/kairomes-runtime.exe" relay --stdio';
}

export async function saveRuntimeApiKey(apiKey: string): Promise<void> {
  if (inTauri()) await invoke("save_runtime_api_key", { apiKey });
  else demoState().credential = true;
}

export async function forgetRuntimeApiKey(): Promise<void> {
  if (inTauri()) await invoke("forget_runtime_api_key");
  else demoState().credential = false;
}

export async function performAction(action: DesktopAction): Promise<PairingResult> {
  if (inTauri()) return invoke<PairingResult>("perform_action", { action });
  return action === "create_pairing"
    ? { pairingUrl: "http://127.0.0.1/pair#code=preview-only", expiresInSeconds: 120 }
    : {};
}

export async function configureExtension(extensionId: string): Promise<PairingResult> {
  if (inTauri()) return invoke<PairingResult>("configure_extension", { extensionId });
  return { pairingUrl: "http://127.0.0.1/pair#code=preview-only", expiresInSeconds: 120 };
}

export async function openExternal(target: ExternalTarget): Promise<void> {
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
  const state = demoState();
  const label = name?.trim() || (path.split(/[\\/]/).filter(Boolean).at(-1) ?? "新專案");
  const workspace: WorkspaceSummary = {
    id: crypto.randomUUID(),
    name: label,
    capabilities: ["read", "write_request"],
  };
  state.workspaces = [...state.workspaces, workspace];
  return workspace;
}

export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSummary> {
  if (inTauri()) return invoke<WorkspaceSummary>("rename_workspace", { workspaceId, name });
  const state = demoState();
  const label = name.trim();
  if (!label || label.length > 80) throw new Error("工作區名稱須為 1～80 個可見字元。");
  const current = state.workspaces.find((workspace) => workspace.id === workspaceId);
  if (!current) throw new Error("找不到已掛載的工作區。");
  const renamed = { ...current, name: label };
  state.workspaces = state.workspaces.map((workspace) =>
    workspace.id === workspaceId ? renamed : workspace,
  );
  return renamed;
}

/**
 * Desktop only: absolute roots for display. Never send them to the widget, the Extension,
 * the model or logs.
 */
export async function getWorkspacePaths(): Promise<WorkspacePath[]> {
  if (inTauri()) return invoke<WorkspacePath[]>("get_workspace_paths");
  return demoWorkspacePaths(demoState());
}

/** Shows the project folder in the OS file manager; the host resolves the root from the id. */
export async function revealWorkspace(workspaceId: string): Promise<void> {
  if (inTauri()) {
    await invoke("reveal_workspace", { workspaceId });
    return;
  }
  if (!demoState().workspaces.some((workspace) => workspace.id === workspaceId))
    throw new Error("找不到這個專案。");
}

/** Fixed-id checks plus a copyable summary that holds only enums, counts and versions. */
export async function getDiagnostics(): Promise<DiagnosticsReport> {
  if (inTauri()) return invoke<DiagnosticsReport>("get_diagnostics");
  const checks = demoDiagnostics(demoState());
  return { checks, summary: diagnosticSummary(checks, VERSION) };
}

export async function removeWorkspace(workspaceId: string): Promise<void> {
  if (inTauri()) {
    await invoke("remove_workspace", { workspaceId });
    return;
  }
  const state = demoState();
  state.workspaces = state.workspaces.filter((workspace) => workspace.id !== workspaceId);
}

export async function handoffRequest<T>(input: HandoffInput): Promise<T> {
  if (!inTauri()) throw new Error("接續需使用 Kairomes Desktop；此頁只提供介面預覽。");
  try {
    return await invoke<T>("handoff_request", { input });
  } catch (caught) {
    throw handoffError(caught);
  }
}
