import { expect, test } from "bun:test";
import { diagnosticSummary } from "../../../packages/protocol/src/diagnostics.ts";
import { VERSION } from "../../../packages/protocol/src/index.ts";
import {
  createDemoState,
  DEMO_MODES,
  demoDiagnostics,
  demoMode,
  demoSnapshot,
  demoWorkspacePaths,
} from "./demo.ts";
import {
  deriveAttention,
  deriveDesktopView,
  normalizeDesktopSnapshot,
  versionMismatchDetail,
} from "./model.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function demo(mode: (typeof DEMO_MODES)[number]) {
  const state = createDemoState(mode, NOW);
  return { state, snapshot: demoSnapshot(state, NOW) };
}

test("the demo query selects a mode; none is first launch and unknown values keep waiting", () => {
  expect(demoMode("")).toBe("setup");
  expect(demoMode("?demo=attention")).toBe("attention");
  expect(demoMode("?demo=tunnel-retry&x=1")).toBe("tunnel-retry");
  expect(demoMode("?demo=other")).toBe("waiting");
});

test("every demo mode is a complete snapshot with increasing sequence numbers", () => {
  for (const mode of DEMO_MODES) {
    const { state, snapshot } = demo(mode);
    expect(normalizeDesktopSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.version).toBe(VERSION);
    const next = demoSnapshot(state, NOW + 1000);
    expect(next.sequence).toBeGreaterThan(snapshot.sequence);
  }
});

test("demo modes reach the states the redesign needs", () => {
  expect(deriveDesktopView(demo("setup").snapshot).action).toBe("configure_key");
  expect(deriveDesktopView(demo("waiting").snapshot).action).toBe("open_connectors");
  expect(deriveDesktopView(demo("ready").snapshot).tone).toBe("ready");
  expect(deriveDesktopView(demo("runtime-error").snapshot).action).toBe("restart_runtime");
  expect(demo("runtime-error").snapshot.companion).toBeNull();

  const empty = demo("empty").snapshot;
  expect(empty.companion?.workspaces).toEqual([]);
  expect(deriveDesktopView(empty).action).toBe("add_workspace");

  const attention = deriveAttention(demo("attention").snapshot, NOW);
  expect(attention.pending).toBe(2);
  expect(attention.pendingByWorkspace.map((entry) => entry.workspaceName)).toEqual([
    "Athori",
    "Lumen Notes",
  ]);
  expect(attention.grants).toEqual([
    expect.objectContaining({ level: "full", remainingMs: 12 * 60_000, expiringSoon: true }),
  ]);
  expect(attention.lastMcpAgoMs).toBe(2 * 60_000);
  expect(deriveDesktopView(demo("attention").snapshot).tone).toBe("ready");

  const auth = demo("tunnel-auth").snapshot.companion?.tunnel;
  expect(auth).toMatchObject({ state: "error", reason: "auth", nextRetryAt: null });

  const retry = demo("tunnel-retry").snapshot.companion?.tunnel;
  expect(retry).toMatchObject({ state: "error", reason: "network", restartCount: 1 });
  const retryIn = Date.parse(retry?.nextRetryAt ?? "") - NOW;
  expect(retryIn).toBeGreaterThan(0);
  expect(retryIn).toBeLessThanOrEqual(10_000);

  const mismatch = demo("mismatch").snapshot;
  expect(versionMismatchDetail(mismatch)).toEqual({
    desktop: VERSION,
    companion: VERSION,
    workbench: "0.1.4",
  });
  expect(mismatch.companion?.attention.grantsKnown).toBe(false);
  expect(deriveAttention(mismatch, NOW).grants).toBeNull();
});

test("demo diagnostics match each mode and summarize without paths or URLs", () => {
  const tunnel = (mode: (typeof DEMO_MODES)[number]) =>
    demoDiagnostics(createDemoState(mode, NOW), NOW).find((check) => check.id === "tunnel");
  expect(tunnel("ready")).toEqual({ id: "tunnel", state: "ok", code: "tunnel_running" });
  expect(tunnel("tunnel-auth")).toMatchObject({ code: "tunnel_failed", fix: "configure_key" });
  expect(tunnel("tunnel-retry")).toMatchObject({ code: "tunnel_retrying", reason: "network" });
  expect(tunnel("error")).toMatchObject({ code: "tunnel_failed", fix: "restart_tunnel" });
  expect(tunnel("setup")).toMatchObject({ code: "tunnel_stopped", fix: "start_tunnel" });
  expect(
    demoDiagnostics(createDemoState("empty", NOW), NOW).find((check) => check.id === "workspaces"),
  ).toMatchObject({ code: "workspaces_none", fix: "add_workspace" });
  expect(
    demoDiagnostics(createDemoState("mismatch", NOW), NOW).find(
      (check) => check.id === "workbench",
    ),
  ).toMatchObject({ code: "workbench_version_mismatch", version: "0.1.4" });
  expect(() => demoDiagnostics(createDemoState("runtime-error", NOW), NOW)).toThrow(
    "本機服務尚未回應",
  );
  for (const mode of DEMO_MODES) {
    if (mode === "runtime-error") continue;
    const state = createDemoState(mode, NOW);
    const summary = diagnosticSummary(demoDiagnostics(state, NOW), VERSION);
    expect(summary).not.toMatch(/[\\/]|https?:|Users|Athori/);
    expect(summary.split("\n")).toHaveLength(9);
  }
});

test("demo roots are synthetic and keyed by the same opaque ids", () => {
  const state = createDemoState("attention", NOW);
  const paths = demoWorkspacePaths(state);
  expect(paths.map((path) => path.id)).toEqual(state.workspaces.map((workspace) => workspace.id));
  expect(paths.map((path) => Object.keys(path).sort())).toEqual([
    ["id", "root"],
    ["id", "root"],
  ]);
  expect(paths[1]?.root).toBe("C:\\Users\\you\\Projects\\Lumen-Notes");
});
