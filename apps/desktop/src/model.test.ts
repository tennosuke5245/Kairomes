import { expect, test } from "bun:test";
import {
  type DesktopSnapshot,
  deriveAttention,
  deriveDesktopView,
  GRANT_EXPIRING_SOON_MS,
  msUntil,
  newerSnapshot,
  normalizeDesktopSnapshot,
  versionMismatchDetail,
  type WireDesktopSnapshot,
} from "./model.ts";

const ATHORI = "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4";
const LUMEN = "8c0f3a51-6d2e-4b7a-9f14-3e5d2c1b0a99";
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function snapshot(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    version: "0.2.0",
    sequence: 1,
    credentialConfigured: true,
    tunnelClientInstalled: true,
    runtime: { state: "running", owned: true, message: "本機服務正在執行。" },
    companion: {
      version: "0.2.0",
      workbenchVersion: "0.2.0",
      versionMismatch: false,
      overall: { tone: "good", label: "已連線" },
      workspaces: [{ id: ATHORI, name: "Athori", capabilities: ["read", "write_request"] }],
      workbench: { state: "running", label: "執行中", message: "就緒", meta: "1 個專案" },
      tunnel: {
        state: "running",
        label: "執行中",
        message: "安全通道已連線。",
        meta: "Profile · kairomes",
        logs: [],
        startedAt: "2026-10-06T11:00:00.000Z",
        reason: null,
        restartCount: 0,
        nextRetryAt: null,
      },
      connector: {
        state: "connected",
        label: "最近有連線",
        message: "收到 MCP 請求。",
        meta: "剛剛",
      },
      extension: { configured: true },
      attention: {
        pending: { total: 0, byWorkspace: [] },
        grants: [],
        grantsKnown: true,
        lastMcpRequestAt: "2026-10-06T11:58:00.000Z",
        pairedPanels: 1,
      },
    },
    versionMismatch: false,
    ...overrides,
  };
}

function companionOf(current: DesktopSnapshot) {
  if (!current.companion) throw new Error("fixture companion missing");
  return current.companion;
}

test("desktop view makes the missing credential the single next action", () => {
  const view = deriveDesktopView(snapshot({ credentialConfigured: false }));
  expect(view.action).toBe("configure_key");
  expect(view.tunnelState).toBe("current");
  expect(view.chatgptState).toBe("pending");
});

test("desktop view waits for a real connector request", () => {
  const current = snapshot();
  companionOf(current).connector.state = "waiting";
  const view = deriveDesktopView(current);
  expect(view.action).toBe("open_connectors");
  expect(view.chatgptState).toBe("current");
});

test("desktop view reports ready only after the connector has been observed", () => {
  const view = deriveDesktopView(snapshot());
  expect(view.tone).toBe("ready");
  expect(view.action).toBe("open_workbench");
  expect(view.chatgptState).toBe("done");
});

test("desktop view makes the first project the next action when none are mounted", () => {
  const current = snapshot();
  companionOf(current).workspaces = [];
  const view = deriveDesktopView(current);
  expect(view.tone).toBe("focus");
  expect(view.action).toBe("add_workspace");
  expect(view.localState).toBe("current");
});

test("an older Companion snapshot is completed with unknown, never optimistic, values", () => {
  const legacy: WireDesktopSnapshot = {
    credentialConfigured: true,
    tunnelClientInstalled: true,
    runtime: { state: "running", owned: false, message: "既有程序" },
    companion: {
      version: "0.1.4",
      overall: { tone: "busy", label: "等待" },
      workspaces: [],
      workbench: { state: "running", label: "執行中", message: "", meta: "" },
      tunnel: { state: "error", label: "需要處理", message: "", meta: "" },
      connector: { state: "blocked", label: "", message: "", meta: "" },
      extension: { configured: false },
    },
  };
  const normalized = normalizeDesktopSnapshot(legacy);
  expect(normalized.version).toBe("");
  expect(normalized.sequence).toBe(0);
  expect(normalized.versionMismatch).toBe(false);
  expect(normalized.companion?.workbenchVersion).toBeNull();
  expect(normalized.companion?.versionMismatch).toBe(false);
  expect(normalized.companion?.tunnel).toMatchObject({
    logs: [],
    startedAt: null,
    reason: null,
    restartCount: 0,
    nextRetryAt: null,
  });
  expect(normalized.companion?.attention).toEqual({
    pending: null,
    grants: null,
    grantsKnown: false,
    lastMcpRequestAt: null,
    pairedPanels: null,
  });
  expect(normalizeDesktopSnapshot({ ...legacy, companion: null }).companion).toBeNull();
  expect(normalizeDesktopSnapshot({ ...legacy, sequence: 1.5 }).sequence).toBe(0);
  // A complete snapshot passes through unchanged.
  expect(normalizeDesktopSnapshot(snapshot())).toEqual(snapshot());
});

test("a late response never replaces a newer pushed snapshot", () => {
  const older = snapshot({ sequence: 4 });
  const newer = snapshot({ sequence: 5, credentialConfigured: false });
  expect(newerSnapshot(older, newer)).toBe(newer);
  expect(newerSnapshot(newer, older)).toBe(newer);
  const same = snapshot({ sequence: 5 });
  expect(newerSnapshot(newer, same)).toBe(same);
});

test("attention reports counts, names and soonest-expiring grants only", () => {
  const current = snapshot();
  const companion = companionOf(current);
  companion.workspaces.push({ id: LUMEN, name: "Lumen Notes", capabilities: ["read"] });
  companion.attention = {
    pending: {
      total: 3,
      byWorkspace: [
        { workspace_id: ATHORI, count: 2 },
        { workspace_id: "00000000-0000-4000-8000-000000000001", count: 1 },
      ],
    },
    grants: [
      { workspace_id: LUMEN, level: "files", expires_at: null },
      {
        workspace_id: ATHORI,
        level: "full",
        expires_at: new Date(NOW + 12 * 60_000).toISOString(),
      },
      { workspace_id: LUMEN, level: "full", expires_at: new Date(NOW - 1000).toISOString() },
    ],
    grantsKnown: true,
    lastMcpRequestAt: new Date(NOW - 2 * 60_000).toISOString(),
    pairedPanels: 1,
  };
  const attention = deriveAttention(current, NOW);
  expect(attention.pending).toBe(3);
  expect(attention.pendingByWorkspace).toEqual([
    { workspaceId: ATHORI, workspaceName: "Athori", count: 2 },
    { workspaceId: "00000000-0000-4000-8000-000000000001", workspaceName: null, count: 1 },
  ]);
  expect(attention.grants).toEqual([
    {
      workspaceId: ATHORI,
      workspaceName: "Athori",
      level: "full",
      expiresAt: new Date(NOW + 12 * 60_000).toISOString(),
      remainingMs: 12 * 60_000,
      expiringSoon: true,
    },
    {
      workspaceId: LUMEN,
      workspaceName: "Lumen Notes",
      level: "files",
      expiresAt: null,
      remainingMs: null,
      expiringSoon: false,
    },
  ]);
  expect(attention.lastMcpAgoMs).toBe(2 * 60_000);
  expect(attention.pairedPanels).toBe(1);
  expect(GRANT_EXPIRING_SOON_MS).toBe(15 * 60_000);
});

test("attention keeps unknown grants and pending counts unknown", () => {
  const current = snapshot();
  companionOf(current).attention = {
    pending: null,
    grants: null,
    grantsKnown: false,
    lastMcpRequestAt: null,
    pairedPanels: null,
  };
  expect(deriveAttention(current, NOW)).toEqual({
    pending: null,
    pendingByWorkspace: [],
    grants: null,
    lastMcpRequestAt: null,
    lastMcpAgoMs: null,
    pairedPanels: null,
  });
  expect(deriveAttention(snapshot({ companion: null }), NOW).grants).toBeNull();
  // A clock skew never reports a negative age.
  companionOf(current).attention.lastMcpRequestAt = new Date(NOW + 5000).toISOString();
  expect(deriveAttention(current, NOW).lastMcpAgoMs).toBe(0);
});

test("time helpers reject missing or invalid timestamps", () => {
  expect(msUntil(null, NOW)).toBeNull();
  expect(msUntil(undefined, NOW)).toBeNull();
  expect(msUntil("not a date", NOW)).toBeNull();
  expect(msUntil(new Date(NOW + 10_000).toISOString(), NOW)).toBe(10_000);
});

test("version mismatch detail lists every side only when versions disagree", () => {
  expect(versionMismatchDetail(snapshot())).toBeNull();
  const current = snapshot({ versionMismatch: true });
  companionOf(current).workbenchVersion = "0.1.4";
  companionOf(current).versionMismatch = true;
  expect(versionMismatchDetail(current)).toEqual({
    desktop: "0.2.0",
    companion: "0.2.0",
    workbench: "0.1.4",
  });
  expect(versionMismatchDetail(snapshot({ versionMismatch: true, companion: null }))).toEqual({
    desktop: "0.2.0",
    companion: null,
    workbench: null,
  });
});
