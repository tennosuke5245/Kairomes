import { expect, test } from "bun:test";
import {
  ACTION_LABELS,
  capabilitySummary,
  type DesktopSnapshot,
  deriveAttention,
  deriveDesktopView,
  deriveSetupSteps,
  extensionChangeConsequence,
  GRANT_EXPIRING_SOON_MS,
  msUntil,
  newerSnapshot,
  normalizeDesktopSnapshot,
  PROJECT_NAME_MAX,
  pathwayStates,
  profileEvidence,
  restartConsequence,
  type TunnelReason,
  tunnelReasonAction,
  validateProjectName,
  versionIssue,
  type WireDesktopSnapshot,
  workspaceAccess,
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

/** Every copy string the view can show; none may soften security or promise a restore. */
const BANNED = /沙箱|隔離環境|只限此聊天|復原|還原|恢復|已驗證|安全無虞/;

function viewOf(current: DesktopSnapshot, options: { profileAcknowledged?: boolean } = {}) {
  const result = deriveDesktopView(current, { now: NOW, ...options });
  for (const text of [result.chip, result.title, result.meta]) expect(text).not.toMatch(BANNED);
  return result;
}

test("ready is success, stated once, with 開啟工作台 as its one action", () => {
  const view = viewOf(snapshot());
  expect(view).toMatchObject({
    state: "ready",
    tone: "success",
    icon: "CheckCircle",
    chip: "已連上 ChatGPT",
    title: "本機服務與安全通道運作正常",
    action: "open_workbench",
    failingHop: null,
    chatgptUnavailable: false,
    setup: null,
  });
  // The title never repeats the chip: connection is stated only in the sidebar.
  expect(view.title).not.toContain("已連上");
});

test("first launch is a neutral checklist that counts the remaining steps", () => {
  const first = snapshot({ credentialConfigured: false });
  companionOf(first).tunnel = { ...companionOf(first).tunnel, state: "stopped", startedAt: null };
  companionOf(first).connector.state = "blocked";
  const view = viewOf(first);
  expect(view).toMatchObject({
    state: "setup",
    tone: "neutral",
    icon: "ListChecks",
    action: "none",
  });
  expect(view.chip).toBe("尚未連上 ChatGPT");
  // The Tunnel never ran, so the profile step waits for the user to say it exists.
  expect(view.setup?.current).toBe("profile");
  expect(view.title).toBe("還差 3 步，就能讓 ChatGPT 讀取你的專案");
  const acknowledged = viewOf(first, { profileAcknowledged: true });
  expect(acknowledged.setup?.current).toBe("key");
  expect(acknowledged.title).toBe("還差 2 步，就能讓 ChatGPT 讀取你的專案");
});

test("the setup checklist marks done steps from evidence only", () => {
  const current = snapshot({ credentialConfigured: false, tunnelClientInstalled: false });
  const companion = companionOf(current);
  companion.workspaces = [];
  companion.tunnel = { ...companion.tunnel, state: "missing", reason: "not_installed" };
  companion.extension.configured = false;
  companion.connector.state = "waiting";
  const progress = deriveSetupSteps(current, { profileAcknowledged: true });
  expect(progress.steps.map((step) => [step.id, step.state])).toEqual([
    ["workspace", "current"],
    ["tunnel_client", "todo"],
    ["profile", "done"],
    ["key", "todo"],
    ["panel", "todo"],
    ["verify", "todo"],
  ]);
  expect(progress).toMatchObject({ done: 1, remaining: 5, current: "workspace" });
  // Todo steps say what they need; the current step's description is rendered separately.
  expect(progress.steps[0]?.meta).toBeNull();
  expect(progress.steps[4]?.meta).toBe("在 Chrome 或 Edge 側欄開啟配對連結");

  const ready = deriveSetupSteps(snapshot());
  expect(ready.remaining).toBe(0);
  expect(ready.current).toBeNull();
  expect(ready.steps.map((step) => step.meta)).toEqual([
    "已加入 Athori",
    "已找到",
    "kairomes",
    "已由作業系統保管",
    "側欄已連線",
    "已收到 ChatGPT 呼叫",
  ]);
});

test("a missing Tunnel profile is a setup step, never red, even if the user said it exists", () => {
  const current = snapshot();
  companionOf(current).tunnel = {
    ...companionOf(current).tunnel,
    state: "error",
    reason: "profile_missing",
    startedAt: null,
  };
  companionOf(current).connector.state = "blocked";
  const view = viewOf(current, { profileAcknowledged: true });
  expect(view.state).toBe("setup");
  expect(view.tone).toBe("neutral");
  expect(view.setup).toMatchObject({ current: "profile", profileMissing: true });
});

test("a missing tunnel-client is the install step of the checklist", () => {
  const current = snapshot({ tunnelClientInstalled: false });
  companionOf(current).tunnel = {
    ...companionOf(current).tunnel,
    state: "missing",
    reason: "not_installed",
  };
  const view = viewOf(current);
  expect(view.state).toBe("setup");
  expect(view.setup?.current).toBe("tunnel_client");
});

test("each Tunnel failure offers the one fix that matches its reason", () => {
  const cases: [TunnelReason | null, string, string, "local" | "tunnel"][] = [
    ["auth", "ChatGPT 拒絕了 Runtime API Key", "configure_key", "tunnel"],
    ["network", "安全通道連不上 ChatGPT", "restart_tunnel", "tunnel"],
    ["unknown", "安全通道意外停止", "restart_tunnel", "tunnel"],
    [null, "安全通道意外停止", "restart_tunnel", "tunnel"],
    ["workbench", "安全通道接不上本機工作台", "restart_runtime", "local"],
  ];
  for (const [reason, title, action, hop] of cases) {
    const current = snapshot();
    companionOf(current).tunnel = {
      ...companionOf(current).tunnel,
      state: "error",
      reason,
      startedAt: null,
    };
    const view = viewOf(current);
    expect(view, String(reason)).toMatchObject({
      state: "error",
      tone: "danger",
      icon: "WarningCircle",
      chip: "安全通道中斷",
      title,
      action,
      failingHop: hop,
      chatgptUnavailable: true,
    });
  }
  // X8: a rejected key is never answered by restarting the same Tunnel.
  expect(tunnelReasonAction("auth")).toBe("configure_key");
  expect(tunnelReasonAction("profile_missing")).toBe("show_profile_setup");
  expect(tunnelReasonAction("not_installed")).toBe("open_tunnel_releases");
  // The workbench may still run: the fix is the confirmed restart, as tunnelFix suggests.
  expect(tunnelReasonAction("workbench")).toBe("restart_runtime");
  expect(tunnelReasonAction("network")).toBe("restart_tunnel");
  expect(ACTION_LABELS.configure_key).toBe("更新金鑰");
  expect(ACTION_LABELS.restart_runtime).toBe("重新啟動本機服務…");
});

test("a scheduled automatic restart is progress with its countdown, not an action", () => {
  const current = snapshot();
  companionOf(current).tunnel = {
    ...companionOf(current).tunnel,
    state: "error",
    reason: "network",
    restartCount: 1,
    nextRetryAt: new Date(NOW + 7_200).toISOString(),
  };
  expect(viewOf(current)).toMatchObject({
    state: "running",
    tone: "running",
    icon: "CircleNotch",
    chip: "正在連線…",
    meta: "將於 8 秒後重試",
    action: "none",
  });
  // A retry time already in the past falls back to the failure and its fix.
  companionOf(current).tunnel.nextRetryAt = new Date(NOW - 1).toISOString();
  expect(viewOf(current).action).toBe("restart_tunnel");
});

test("the local service and workbench fail at the first hop with fixed copy", () => {
  const stopped = viewOf(
    snapshot({
      runtime: { state: "error", owned: true, message: "raw stderr: C:\\Users\\me\\secret" },
      companion: null,
    }),
  );
  expect(stopped).toMatchObject({
    state: "error",
    chip: "本機服務已停止",
    title: "本機服務已停止",
    action: "restart_runtime",
    failingHop: "local",
  });
  // Host stderr never reaches the status line.
  expect(JSON.stringify(stopped)).not.toContain("secret");

  const starting = viewOf(
    snapshot({ runtime: { state: "starting", owned: true, message: "" }, companion: null }),
  );
  expect(starting).toMatchObject({ state: "running", tone: "running", action: "none" });
  // First paint while the service starts never asks for a key (X14).
  expect(starting.title).not.toContain("金鑰");

  // A workbench that is not answering, and one that stopped: the chip says which, and the meta
  // says what happens next instead of the project cards' 無法使用.
  const broken = snapshot();
  companionOf(broken).workbench.state = "error";
  expect(viewOf(broken)).toMatchObject({
    state: "error",
    chip: "本機工作台無回應",
    title: "本機工作台沒有回應",
    meta: "重試後，安全通道會自動重新連線。",
    action: "retry_workbench",
    failingHop: "local",
    chatgptUnavailable: true,
  });
  companionOf(broken).workbench.state = "stopped";
  expect(viewOf(broken)).toMatchObject({
    chip: "本機工作台已停止",
    title: "本機工作台已停止",
    action: "retry_workbench",
  });
  expect(viewOf(broken).meta).not.toContain("無法");
});

test("a Tunnel that lost a running workbench never offers the unconfirmed 重試工作台", () => {
  // The reviewer's case: retries used up, one full grant, one pending request, one paired panel.
  const current = snapshot();
  const companion = companionOf(current);
  companion.tunnel = {
    ...companion.tunnel,
    state: "error",
    reason: "workbench",
    startedAt: null,
    restartCount: 3,
    nextRetryAt: null,
  };
  companion.attention = {
    ...companion.attention,
    pending: { total: 1, byWorkspace: [{ workspace_id: ATHORI, count: 1 }] },
    grants: [{ workspace_id: ATHORI, level: "full", expires_at: null }],
    pairedPanels: 1,
  };
  const view = viewOf(current);
  expect(view).toMatchObject({ state: "error", action: "restart_runtime", failingHop: "local" });
  // restart_runtime always opens the confirmation; it names what the restart ends.
  expect(restartConsequence(current, NOW)).toBe(
    "會停止執行中的命令與終端機、收回 1 個自主授權、取消 1 件待確認的請求；瀏覽器側欄需重新配對，MCP 登入需重新進行。",
  );
});

test("a version mismatch names the side that differs and its one fix", () => {
  const current = snapshot({ versionMismatch: true });
  companionOf(current).workbenchVersion = "0.1.4";
  companionOf(current).versionMismatch = true;
  // A workbench the service started restarts with it (confirmed first).
  expect(viewOf(current)).toMatchObject({
    state: "attention",
    tone: "brand",
    icon: "Hand",
    title: "工作台版本不同",
    meta: "工作台 0.1.4 · Desktop 0.2.0",
    action: "restart_runtime",
    failingHop: null,
  });
  // One another program started is taken over instead, as the Companion's diagnostics say.
  companionOf(current).workbench.state = "external";
  expect(viewOf(current)).toMatchObject({ title: "工作台版本不同", action: "retry_workbench" });
  // A different local service is named first and restarted.
  companionOf(current).version = "0.1.9";
  expect(viewOf(current)).toMatchObject({
    title: "本機服務版本不同",
    meta: "本機服務 0.1.9 · Desktop 0.2.0",
    action: "restart_runtime",
  });
  expect(versionIssue(snapshot())).toBeNull();
  expect(versionIssue(snapshot({ companion: null, versionMismatch: true }))).toBeNull();
});

test("waiting for ChatGPT is a brand action without a spinner; a paused Tunnel is neutral", () => {
  const waiting = snapshot();
  companionOf(waiting).connector.state = "waiting";
  expect(viewOf(waiting)).toMatchObject({
    state: "attention",
    tone: "brand",
    icon: "Hand",
    title: "請在 ChatGPT 重新整理連接器",
    action: "open_connectors",
    chatgptUnavailable: false,
  });

  const paused = snapshot();
  companionOf(paused).tunnel = { ...companionOf(paused).tunnel, state: "stopped", startedAt: null };
  expect(viewOf(paused)).toMatchObject({
    state: "paused",
    tone: "neutral",
    action: "start_tunnel",
    chatgptUnavailable: true,
    // The project cards say ChatGPT cannot reach them; the meta says what starting does.
    meta: "啟動後，ChatGPT 就能再讀取你的專案。",
  });

  const starting = snapshot();
  companionOf(starting).tunnel = { ...companionOf(starting).tunnel, state: "starting" };
  expect(viewOf(starting)).toMatchObject({ state: "running", title: "正在啟動安全通道…" });
});

test("a starting Tunnel with a saved key never flashes the checklist", () => {
  const launching = snapshot();
  companionOf(launching).tunnel = {
    ...companionOf(launching).tunnel,
    state: "starting",
    startedAt: null,
  };
  companionOf(launching).connector.state = "blocked";
  // The profile cannot be confirmed yet, but the Tunnel is already on its way.
  expect(viewOf(launching)).toMatchObject({ state: "running", title: "正在啟動安全通道…" });
  expect(profileEvidence(launching)).toBe(false);
  expect(profileEvidence(snapshot())).toBe(true);
  const rejected = snapshot();
  companionOf(rejected).tunnel = {
    ...companionOf(rejected).tunnel,
    state: "error",
    reason: "auth",
  };
  companionOf(rejected).connector.state = "blocked";
  expect(profileEvidence(rejected)).toBe(true);
  companionOf(rejected).tunnel.reason = "profile_missing";
  expect(profileEvidence(rejected)).toBe(false);
});

test("an unpaired side panel keeps setup only until ChatGPT has called", () => {
  const current = snapshot();
  companionOf(current).extension.configured = false;
  companionOf(current).connector.state = "waiting";
  expect(viewOf(current).setup?.current).toBe("panel");
  companionOf(current).connector.state = "connected";
  expect(viewOf(current).state).toBe("ready");
});

test("the pathway marks the failing hop and switches off everything after it", () => {
  const stopped = snapshot({ runtime: { state: "stopped", owned: true, message: "" } });
  expect(pathwayStates(stopped, "local")).toEqual({
    nodes: ["fail", "off", "off"],
    links: ["broken", "off"],
  });
  const rejected = snapshot();
  companionOf(rejected).tunnel = { ...companionOf(rejected).tunnel, state: "error" };
  expect(pathwayStates(rejected, "tunnel")).toEqual({
    nodes: ["ok", "fail", "off"],
    links: ["ok", "broken"],
  });
  // The Tunnel cannot reach the workbench: the local hop fails although the service runs.
  expect(pathwayStates(rejected, "local").nodes).toEqual(["fail", "off", "off"]);
});

test("without a failure the pathway shows only what the snapshot proves", () => {
  expect(pathwayStates(snapshot(), null)).toEqual({
    nodes: ["ok", "ok", "ok"],
    links: ["ok", "ok"],
  });
  const waiting = snapshot();
  companionOf(waiting).connector.state = "waiting";
  expect(pathwayStates(waiting, null)).toEqual({
    nodes: ["ok", "ok", "off"],
    links: ["ok", "off"],
  });
  const paused = snapshot();
  companionOf(paused).tunnel = { ...companionOf(paused).tunnel, state: "starting" };
  expect(pathwayStates(paused, null)).toEqual({
    nodes: ["ok", "off", "off"],
    links: ["off", "off"],
  });
  // ChatGPT is never claimed past a Tunnel that is not running.
  companionOf(paused).connector.state = "connected";
  expect(pathwayStates(paused, null).nodes[2]).toBe("off");
  expect(pathwayStates(snapshot({ companion: null }), null).nodes).toEqual(["off", "off", "off"]);
});

test("the restart confirmation states what stops, never that anything comes back", () => {
  const current = snapshot();
  companionOf(current).attention = {
    ...companionOf(current).attention,
    pending: { total: 2, byWorkspace: [{ workspace_id: ATHORI, count: 2 }] },
    grants: [{ workspace_id: ATHORI, level: "full", expires_at: null }],
  };
  const text = restartConsequence(current, NOW);
  expect(text).toBe(
    "會停止執行中的命令與終端機、收回 1 個自主授權、取消 2 件待確認的請求；瀏覽器側欄需重新配對，MCP 登入需重新進行。",
  );
  // Nothing to count: only what always happens is said.
  companionOf(current).attention.pending = { total: 0, byWorkspace: [] };
  companionOf(current).attention.grants = [];
  companionOf(current).attention.pairedPanels = 0;
  expect(restartConsequence(current, NOW)).toBe("會停止執行中的命令與終端機；MCP 登入需重新進行。");
  for (const value of [text, restartConsequence(current, NOW)]) expect(value).not.toMatch(BANNED);
});

test("the restart confirmation leaves out counts it cannot read instead of guessing", () => {
  const current = snapshot();
  companionOf(current).attention = {
    pending: null,
    grants: null,
    grantsKnown: false,
    lastMcpRequestAt: null,
    pairedPanels: null,
  };
  const external = snapshot({ ...current, runtime: { ...current.runtime, owned: false } });
  const text = restartConsequence(external, NOW);
  expect(text).toBe(
    "會接管由其他程式啟動的本機服務，停止執行中的命令與終端機；瀏覽器側欄需重新配對，MCP 登入需重新進行。",
  );
  expect(text).not.toMatch(/所有自主授權|\d+ 個自主授權|待確認/);
  // The tray can ask before any status arrived; the line stays generic and honest.
  for (const value of [
    restartConsequence(snapshot({ companion: null }), NOW),
    restartConsequence(null, NOW),
  ]) {
    // The title already says 重新啟動本機服務？; the line holds only the consequences.
    expect(value).toBe("瀏覽器側欄需重新配對，MCP 登入需重新進行。");
    expect(value).not.toMatch(BANNED);
  }
});

test("更換 Extension ID is confirmed with what the workbench restart ends", () => {
  const current = snapshot();
  companionOf(current).attention = {
    ...companionOf(current).attention,
    pending: { total: 2, byWorkspace: [{ workspace_id: ATHORI, count: 2 }] },
    grants: [{ workspace_id: ATHORI, level: "files", expires_at: null }],
  };
  const text = extensionChangeConsequence(current, NOW);
  expect(text).toBe(
    "會重新啟動本機工作台並停止執行中的命令與終端機、收回 1 個自主授權、取消 2 件待確認的請求；瀏覽器側欄要用新的配對連結重新配對，MCP 登入需重新進行。",
  );
  expect(text).not.toMatch(BANNED);
  // Unknown counts are left out, never guessed.
  expect(extensionChangeConsequence(null, NOW)).toBe(
    "會重新啟動本機工作台並停止執行中的命令與終端機；瀏覽器側欄要用新的配對連結重新配對，MCP 登入需重新進行。",
  );
});

test("project names follow the registry rule before the host is asked", () => {
  expect(validateProjectName("  Lumen Notes  ")).toEqual({ ok: true, name: "Lumen Notes" });
  expect(validateProjectName("筆記".repeat(40))).toEqual({ ok: true, name: "筆記".repeat(40) });
  expect(validateProjectName("   ")).toEqual({ ok: false, error: "請輸入專案名稱。" });
  expect(validateProjectName("a".repeat(PROJECT_NAME_MAX + 1))).toEqual({
    ok: false,
    error: "專案名稱最多 80 個字元。",
  });
  for (const hidden of ["a\nb", "a\tb", "a\u202eb", "a\u2066b", "a\u007fb"])
    expect(validateProjectName(hidden)).toEqual({
      ok: false,
      error: "專案名稱不能包含換行或不可見字元。",
    });
});

test("project cards show the strongest grant, 唯讀, or 權限待確認 when grants are unknown", () => {
  const current = snapshot();
  const athori = companionOf(current).workspaces[0];
  if (!athori) throw new Error("fixture workspace missing");
  companionOf(current).attention.grants = [
    { workspace_id: ATHORI, level: "files", expires_at: null },
    { workspace_id: ATHORI, level: "full", expires_at: new Date(NOW + 60_000).toISOString() },
  ];
  expect(workspaceAccess(deriveAttention(current, NOW), athori)).toBe("full");
  companionOf(current).attention.grants = [];
  expect(workspaceAccess(deriveAttention(current, NOW), athori)).toBe("step");
  companionOf(current).attention.grantsKnown = false;
  expect(workspaceAccess(deriveAttention(current, NOW), athori)).toBe("unknown");
  expect(
    workspaceAccess(deriveAttention(current, NOW), { ...athori, capabilities: ["read"] }),
  ).toBe("read");
  expect(capabilitySummary(["read", "write_request"])).toBe("讀寫・命令・終端機");
  expect(capabilitySummary(["read"])).toBe("讀取・搜尋");
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
  // An older Companion without kinds falls back to one group per workspace.
  expect(attention.pendingGroups).toEqual([
    { kind: null, workspaceId: ATHORI, workspaceName: "Athori", count: 2 },
    {
      kind: null,
      workspaceId: "00000000-0000-4000-8000-000000000001",
      workspaceName: null,
      count: 1,
    },
  ]);
  expect(attention.pendingRemainingMs).toBeNull();
});

test("attention groups pending requests by kind and keeps the earliest deadline", () => {
  const current = snapshot();
  companionOf(current).attention.pending = {
    total: 2,
    byWorkspace: [{ workspace_id: ATHORI, count: 2 }],
    byKind: [
      { kind: "command", workspace_id: ATHORI, count: 1 },
      { kind: "file_change", workspace_id: ATHORI, count: 1 },
    ],
    earliestExpiresAt: new Date(NOW + 252_000).toISOString(),
  };
  const attention = deriveAttention(current, NOW);
  expect(attention.pendingGroups).toEqual([
    { kind: "command", workspaceId: ATHORI, workspaceName: "Athori", count: 1 },
    { kind: "file_change", workspaceId: ATHORI, workspaceName: "Athori", count: 1 },
  ]);
  expect(attention.pendingRemainingMs).toBe(252_000);
  // Nothing pending means no countdown, even if a stale deadline is still reported.
  companionOf(current).attention.pending = {
    total: 0,
    byWorkspace: [],
    byKind: [],
    earliestExpiresAt: new Date(NOW + 1000).toISOString(),
  };
  expect(deriveAttention(current, NOW).pendingRemainingMs).toBeNull();
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
    pendingGroups: [],
    pendingRemainingMs: null,
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
