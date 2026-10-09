import { afterEach, expect, test } from "bun:test";
import {
  addWorkspace,
  CLOSE_HINT_EVENT,
  CONFIRM_RESTART_EVENT,
  DESKTOP_STATUS_EVENT,
  EXTERNAL_TARGETS,
  getDiagnostics,
  getWorkspacePaths,
  hideMainWindow,
  onCloseHint,
  onConfirmRestart,
  openExternal,
  performAction,
  renameWorkspace,
  revealWorkspace,
  STATUS_POLL_INTERVAL_MS,
  subscribeDesktopStatus,
} from "./api.ts";
import type { DesktopSnapshot, WireDesktopSnapshot } from "./model.ts";

type Call = { command: string; args: unknown };
type Handler = (event: { event: string; id: number; payload: unknown }) => void;

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousSetInterval = globalThis.setInterval;
const previousClearInterval = globalThis.clearInterval;

afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
  globalThis.setInterval = previousSetInterval;
  globalThis.clearInterval = previousClearInterval;
});

function legacySnapshot(sequence: number): WireDesktopSnapshot {
  return {
    sequence,
    credentialConfigured: true,
    tunnelClientInstalled: true,
    runtime: { state: "running", owned: true, message: "合成本機服務" },
    companion: null,
  };
}

/** Real @tauri-apps/api wrappers over an in-memory IPC; no native app is involved. */
function fakeTauri(
  respond: (command: string, args: unknown) => unknown,
  options: { events?: boolean } = {},
) {
  const calls: Call[] = [];
  const callbacks = new Map<number, Handler>();
  const listeners = new Map<number, { event: string; handler: number }>();
  let nextId = 1;
  const internals: Record<string, unknown> = {
    invoke: async (command: string, args: unknown) => {
      calls.push({ command, args });
      if (command === "plugin:event|listen") {
        const { event, handler } = args as { event: string; handler: number };
        const id = nextId++;
        listeners.set(id, { event, handler });
        return id;
      }
      if (command === "plugin:event|unlisten") {
        listeners.delete((args as { eventId: number }).eventId);
        return null;
      }
      return respond(command, args);
    },
  };
  if (options.events !== false)
    internals.transformCallback = (callback: Handler) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: internals,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
    },
  });
  return {
    calls,
    listening: (event: string) => [...listeners.values()].filter((item) => item.event === event),
    emit(event: string, payload: unknown) {
      for (const [id, listener] of listeners)
        if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
    },
  };
}

function manualIntervals() {
  const timers: (() => void)[] = [];
  const cleared: number[] = [];
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    expect(delay).toBe(STATUS_POLL_INTERVAL_MS);
    timers.push(callback);
    return timers.length;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => {
    cleared.push(id);
  }) as unknown as typeof clearInterval;
  return { timers, cleared };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("status subscription reads once, then applies pushed snapshots in order", async () => {
  const tauri = fakeTauri((command) => {
    if (command === "get_desktop_status") return legacySnapshot(3);
    throw new Error(`unexpected ${command}`);
  });
  const received: DesktopSnapshot[] = [];
  const stop = subscribeDesktopStatus((snapshot) => received.push(snapshot));
  await settle();
  expect(tauri.listening(DESKTOP_STATUS_EVENT)).toHaveLength(1);
  expect(received.map((snapshot) => snapshot.sequence)).toEqual([3]);
  // The older Companion shape is completed before the UI sees it.
  expect(received[0]?.versionMismatch).toBe(false);
  expect(received[0]?.version).toBe("");

  // Rust pushes the snapshot it also returned; older and repeated ones are skipped.
  tauri.emit(DESKTOP_STATUS_EVENT, legacySnapshot(3));
  tauri.emit(DESKTOP_STATUS_EVENT, legacySnapshot(2));
  tauri.emit(DESKTOP_STATUS_EVENT, legacySnapshot(5));
  expect(received.map((snapshot) => snapshot.sequence)).toEqual([3, 5]);
  // A fixture without ordering (sequence 0) is always applied.
  tauri.emit(DESKTOP_STATUS_EVENT, { ...legacySnapshot(0), sequence: undefined });
  expect(received.map((snapshot) => snapshot.sequence)).toEqual([3, 5, 0]);

  stop();
  await settle();
  expect(tauri.listening(DESKTOP_STATUS_EVENT)).toHaveLength(0);
  tauri.emit(DESKTOP_STATUS_EVENT, legacySnapshot(9));
  expect(received.map((snapshot) => snapshot.sequence)).toEqual([3, 5, 0]);
});

test("status subscription falls back to polling when events are unavailable", async () => {
  const intervals = manualIntervals();
  let reads = 0;
  fakeTauri(
    (command) => {
      if (command !== "get_desktop_status") throw new Error(`unexpected ${command}`);
      reads++;
      if (reads === 2) throw "合成本機狀態回應失敗。";
      return legacySnapshot(reads);
    },
    { events: false },
  );
  const received: number[] = [];
  const errors: string[] = [];
  const stop = subscribeDesktopStatus(
    (snapshot) => received.push(snapshot.sequence),
    (error) => errors.push(error.message),
  );
  await settle();
  expect(intervals.timers).toHaveLength(1);
  intervals.timers[0]?.();
  await settle();
  intervals.timers[0]?.();
  await settle();
  expect(received).toEqual([1, 3]);
  expect(errors).toEqual(["合成本機狀態回應失敗。"]);
  stop();
  expect(intervals.cleared).toEqual([1]);
});

test("the browser preview polls the synthetic status", async () => {
  const intervals = manualIntervals();
  Reflect.deleteProperty(globalThis, "window");
  const received: DesktopSnapshot[] = [];
  const stop = subscribeDesktopStatus((snapshot) => received.push(snapshot));
  await settle();
  intervals.timers[0]?.();
  await settle();
  expect(received).toHaveLength(2);
  expect(received[1]?.sequence).toBeGreaterThan(received[0]?.sequence ?? 0);
  stop();
});

test("a tray restart request only notifies the UI; it never restarts by itself", async () => {
  const tauri = fakeTauri((command) => {
    throw new Error(`unexpected ${command}`);
  });
  let requests = 0;
  const stop = onConfirmRestart(() => requests++);
  await settle();
  tauri.emit(CONFIRM_RESTART_EVENT, null);
  expect(requests).toBe(1);
  expect(tauri.calls.map((call) => call.command)).toEqual(["plugin:event|listen"]);
  stop();
  await settle();
  tauri.emit(CONFIRM_RESTART_EVENT, null);
  expect(requests).toBe(1);
});

test("the first-close hint only notifies the UI; the window hides when the UI asks", async () => {
  const tauri = fakeTauri((command) => {
    if (command === "hide_main_window") return null;
    throw new Error(`unexpected ${command}`);
  });
  let hints = 0;
  const stop = onCloseHint(() => hints++);
  await settle();
  tauri.emit(CLOSE_HINT_EVENT, null);
  expect(hints).toBe(1);
  await hideMainWindow();
  expect(tauri.calls.map((call) => call.command)).toEqual([
    "plugin:event|listen",
    "hide_main_window",
  ]);
  stop();
  await settle();
  tauri.emit(CLOSE_HINT_EVENT, null);
  expect(hints).toBe(1);
});

test("project, diagnostics and link wrappers send only ids and fixed names", async () => {
  const id = "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4";
  const tauri = fakeTauri((command) => {
    if (command === "perform_action")
      return { pairingUrl: "http://127.0.0.1/pair#code=synthetic", expiresInSeconds: 120 };
    if (command === "get_workspace_paths") return [{ id, root: "C:\\synthetic" }];
    if (command === "get_diagnostics") return { checks: [], summary: "Kairomes 0.2.0 診斷摘要" };
    if (command === "rename_workspace" || command === "add_workspace")
      return { id, name: "新名稱", capabilities: ["read"] };
    return null;
  });
  await renameWorkspace(id, "新名稱");
  await revealWorkspace(id);
  await addWorkspace("C:\\synthetic", "名稱");
  expect(await getWorkspacePaths()).toEqual([{ id, root: "C:\\synthetic" }]);
  expect((await getDiagnostics()).summary).toContain("診斷摘要");
  expect((await performAction("create_pairing")).expiresInSeconds).toBe(120);
  for (const target of EXTERNAL_TARGETS) await openExternal(target);
  expect(tauri.calls).toEqual([
    { command: "rename_workspace", args: { workspaceId: id, name: "新名稱" } },
    { command: "reveal_workspace", args: { workspaceId: id } },
    { command: "add_workspace", args: { path: "C:\\synthetic", name: "名稱" } },
    { command: "get_workspace_paths", args: {} },
    { command: "get_diagnostics", args: {} },
    { command: "perform_action", args: { action: "create_pairing" } },
    ...EXTERNAL_TARGETS.map((target) => ({ command: "open_external", args: { target } })),
  ]);
});

test("the browser preview mocks project paths, reveal and diagnostics", async () => {
  Reflect.deleteProperty(globalThis, "window");
  const paths = await getWorkspacePaths();
  expect(paths.length).toBeGreaterThan(0);
  const first = paths[0];
  if (!first) throw new Error("missing synthetic path");
  await revealWorkspace(first.id);
  await expect(revealWorkspace("00000000-0000-4000-8000-000000000000")).rejects.toThrow(
    "找不到這個專案",
  );
  const report = await getDiagnostics();
  expect(report.checks.map((check) => check.id)).toContain("tunnel");
  expect(report.summary).not.toMatch(/[\\/]/);
});
