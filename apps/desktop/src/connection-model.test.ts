import { expect, test } from "bun:test";
import {
  CONNECTION_ACTION_LABELS,
  keyRow,
  PANEL_META,
  panelRow,
  tunnelRow,
} from "./connection-model.ts";
import { createDemoState, DEMO_MODES, type DemoMode, demoSnapshot } from "./demo.ts";
import type { DesktopSnapshot, TunnelReason } from "./model.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const IDLE = { live: false, cleared: false };

function snapshotFor(mode: DemoMode) {
  return demoSnapshot(createDemoState(mode, NOW), NOW);
}

function withTunnel(
  mode: DemoMode,
  tunnel: Partial<NonNullable<DesktopSnapshot["companion"]>["tunnel"]>,
): DesktopSnapshot {
  const snapshot = snapshotFor(mode);
  if (!snapshot.companion) throw new Error("fixture companion missing");
  snapshot.companion.tunnel = { ...snapshot.companion.tunnel, ...tunnel };
  return snapshot;
}

test("every row in every state has one pill, one sentence and at most two actions", () => {
  for (const mode of DEMO_MODES) {
    const snapshot = snapshotFor(mode);
    for (const row of [keyRow(snapshot), tunnelRow(snapshot, NOW), panelRow(snapshot, IDLE)]) {
      expect(row.actions.length).toBeLessThanOrEqual(2);
      expect(row.pill).not.toBe("");
      expect(row.meta).not.toMatch(/https?:|[A-Za-z]:\\|沙箱|復原|還原|Exit \d/);
    }
  }
});

test("the key row asks for a key, names a rejection, or offers change and removal", () => {
  expect(keyRow(snapshotFor("setup"))).toMatchObject({
    tone: "warning",
    pill: "尚未設定",
    actions: ["set_key", "get_key"],
  });
  expect(keyRow(snapshotFor("tunnel-auth"))).toMatchObject({
    tone: "danger",
    pill: "被拒絕",
    actions: ["update_key", "forget_key"],
  });
  expect(keyRow(snapshotFor("ready"))).toMatchObject({
    tone: "success",
    pill: "已保存",
    actions: ["change_key", "forget_key"],
  });
  expect(CONNECTION_ACTION_LABELS.forget_key).toBe("移除金鑰…");
});

test("the Tunnel row offers one recovery per failure class", () => {
  expect(tunnelRow(snapshotFor("ready"), NOW)).toMatchObject({
    tone: "success",
    meta: "使用 kairomes profile · 已運作 38 分鐘",
    actions: ["restart_tunnel", "stop_tunnel"],
  });
  const cases: [TunnelReason, string, string[]][] = [
    ["auth", "等待金鑰", []],
    ["profile_missing", "找不到 profile", ["restart_tunnel"]],
    ["network", "中斷", ["restart_tunnel"]],
    // The workbench may still run: its restart goes through the confirmed dialog.
    ["workbench", "中斷", ["restart_runtime"]],
    ["unknown", "中斷", ["restart_tunnel"]],
    ["not_installed", "找不到 tunnel-client", ["download_client"]],
  ];
  for (const [reason, pill, actions] of cases)
    expect(tunnelRow(withTunnel("ready", { state: "error", reason }), NOW)).toMatchObject({
      pill,
      actions,
    });
  // Under the 安全通道 title and its 中斷 pill, the line adds the cause and never restates them.
  const unknown = tunnelRow(withTunnel("ready", { state: "error", reason: "unknown" }), NOW);
  expect(unknown.meta).toBe("意外停止，原因不明。");
  expect(unknown.meta).not.toContain("安全通道");
  expect(tunnelRow(withTunnel("ready", { state: "stopped", reason: null }), NOW)).toMatchObject({
    pill: "已暫停",
    pillIcon: "PauseCircle",
    actions: ["start_tunnel"],
  });
  expect(CONNECTION_ACTION_LABELS.restart_runtime).toBe("重新啟動本機服務…");
  const retry = tunnelRow(snapshotFor("tunnel-retry"), NOW);
  expect(retry).toMatchObject({ tone: "running", actions: [] });
  expect(retry.meta).toMatch(/^連線中斷，將於 \d+ 秒後重試。$/);
});

test("a rejected key says once that the Tunnel reconnects: on the key row, not the Tunnel row", () => {
  const snapshot = snapshotFor("tunnel-auth");
  const key = keyRow(snapshot);
  const tunnel = tunnelRow(snapshot, NOW);
  expect(key.meta).toContain("重新連線");
  expect(tunnel).toMatchObject({ pill: "等待金鑰", meta: "使用 kairomes profile", actions: [] });
  expect(tunnel.meta).not.toContain("重新連線");
  // No row uses the English label "Profile ·".
  for (const mode of ["ready", "tunnel-auth", "setup"] as const)
    expect(tunnelRow(snapshotFor(mode), NOW).meta).not.toContain("Profile");
});

test("the side-panel row says 已連線 or 已設定，未連線 and pairs from one button", () => {
  expect(panelRow(snapshotFor("ready"), IDLE)).toMatchObject({
    tone: "success",
    pill: "已連線",
    meta: PANEL_META,
    actions: ["pair"],
  });
  const unpaired = snapshotFor("ready");
  if (!unpaired.companion) throw new Error("fixture companion missing");
  unpaired.companion.attention.pairedPanels = 0;
  expect(panelRow(unpaired, IDLE)).toMatchObject({ pill: "已設定，未連線", actions: ["pair"] });
  // While a link is on screen the row has no button; once cleared it offers 重新產生.
  expect(panelRow(unpaired, { live: true, cleared: false }).actions).toEqual([]);
  expect(panelRow(unpaired, { live: false, cleared: true }).actions).toEqual(["repair"]);
  expect(CONNECTION_ACTION_LABELS.repair).toBe("重新產生");
  // Unknown pairing count: only the setting is claimed.
  expect(panelRow(snapshotFor("mismatch"), IDLE)).toMatchObject({ pill: "已設定" });
  // Not configured yet: the Extension ID form is the action, so no button.
  expect(panelRow(snapshotFor("setup"), IDLE)).toMatchObject({
    tone: "warning",
    pill: "尚未配對",
    actions: [],
  });
  expect(panelRow(snapshotFor("runtime-error"), IDLE)).toMatchObject({
    pill: "等待本機服務",
    actions: [],
  });
});
