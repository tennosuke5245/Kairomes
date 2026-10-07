import { expect, test } from "bun:test";
import { VERSION } from "../../../packages/protocol/src/index.ts";
import {
  CHECK_CONTROL_LABELS,
  type CheckRow,
  deriveCheckRows,
  rowNeedsAttention,
  snapshotSummary,
} from "./checks.ts";
import {
  createDemoState,
  DEMO_MODES,
  type DemoMode,
  demoDiagnostics,
  demoSnapshot,
} from "./demo.ts";
import { deriveDesktopView } from "./model.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

function rowsFor(mode: DemoMode, options: { withChecks?: boolean } = {}) {
  const state = createDemoState(mode, NOW);
  const snapshot = demoSnapshot(state, NOW);
  const view = deriveDesktopView(snapshot, { now: NOW });
  const checks =
    options.withChecks === false || mode === "runtime-error" ? null : demoDiagnostics(state, NOW);
  // As 疑難排解 shows it: every state but ready has a status line with its one action.
  const statusAction = view.state === "ready" ? "none" : view.action;
  return { rows: deriveCheckRows({ snapshot, checks, now: NOW, statusAction }), snapshot, view };
}

const byId = (rows: CheckRow[], id: CheckRow["id"]) => {
  const found = rows.find((row) => row.id === id);
  if (!found) throw new Error(`missing row ${id}`);
  return found;
};

/** Nothing a row says may carry a path, URL, log line or a softened security claim. */
const FORBIDDEN = /https?:|[A-Za-z]:\\|\/Users\/|沙箱|只限此聊天|復原|還原|恢復|已驗證|Exit \d/;

test("a healthy machine shows every check, none toned, with only stop and restart offered", () => {
  const { rows } = rowsFor("ready");
  expect(rows.map((row) => row.name)).toEqual([
    "本機服務",
    "工作台",
    "tunnel-client",
    "Runtime API Key",
    "安全通道",
    "瀏覽器側欄",
    "專案資料夾",
    "資料目錄",
    "Codex CLI",
    "MCP 伺服器設定",
  ]);
  expect(rows.filter(rowNeedsAttention)).toEqual([]);
  expect(rows.filter((row) => row.control).map((row) => [row.id, row.control])).toEqual([
    ["runtime", "restart_runtime"],
    ["tunnel", "stop_tunnel"],
  ]);
  expect(byId(rows, "tunnel").detail).toBe("已運作 38 分鐘");
  expect(byId(rows, "panel").detail).toBe("已配對 1 個側欄");
  expect(byId(rows, "workspaces").detail).toBe("1 個都能讀取");
  expect(CHECK_CONTROL_LABELS.restart_runtime).toBe("重新啟動…");
});

test("a rejected key tones only the key row and never repeats the status line's fix", () => {
  const { rows, view } = rowsFor("tunnel-auth");
  expect(view.action).toBe("configure_key");
  expect(rows.filter(rowNeedsAttention).map((row) => row.id)).toEqual(["key"]);
  expect(byId(rows, "key")).toMatchObject({ tone: "danger", pill: "被拒絕", control: null });
  // The Tunnel only waits for the key: neutral, no control of its own.
  expect(byId(rows, "tunnel")).toMatchObject({
    tone: "neutral",
    pill: "等待金鑰",
    pillIcon: "PauseCircle",
    control: null,
  });
  // Off 疑難排解's status line (no status action), the key row offers the fix itself.
  const state = createDemoState("tunnel-auth", NOW);
  const snapshot = demoSnapshot(state, NOW);
  const alone = deriveCheckRows({ snapshot, checks: null, now: NOW });
  expect(byId(alone, "key").control).toBe("update_key");
});

test("a stopped local service shows one failing row and waits on the rest", () => {
  const { rows, view } = rowsFor("runtime-error");
  expect(view.action).toBe("restart_runtime");
  expect(rows).toHaveLength(6);
  expect(byId(rows, "runtime")).toMatchObject({
    tone: "danger",
    pill: "已停止",
    control: null,
  });
  expect(rows.filter(rowNeedsAttention).map((row) => row.id)).toEqual(["runtime"]);
  // The 等待 pill says it; the note under the list says once what the service is needed for.
  for (const id of ["workbench", "tunnel", "panel"] as const)
    expect(byId(rows, id)).toMatchObject({
      tone: "neutral",
      pill: "等待",
      detail: "",
      control: null,
    });
});

test("setup states the key dependency once: on the key row, the Tunnel row adds the profile", () => {
  const { rows } = rowsFor("setup");
  expect(byId(rows, "key")).toMatchObject({ pill: "尚未設定", detail: "安全通道需要它才能啟動" });
  expect(byId(rows, "tunnel")).toMatchObject({ pill: "等待金鑰", detail: "使用 kairomes profile" });
  // No two rows on one page carry the same sentence (each part's own version aside).
  for (const mode of DEMO_MODES) {
    const details = rowsFor(mode)
      .rows.map((row) => row.detail)
      .filter((detail) => detail && !detail.startsWith("版本"));
    expect(new Set(details).size, mode).toBe(details.length);
  }
});

test("a Tunnel that cannot reach the workbench offers the confirmed restart, never a bare retry", () => {
  const { snapshot } = rowsFor("ready");
  if (!snapshot.companion) throw new Error("fixture companion missing");
  snapshot.companion.tunnel = {
    ...snapshot.companion.tunnel,
    state: "error",
    reason: "workbench",
    nextRetryAt: null,
  };
  const alone = deriveCheckRows({ snapshot, checks: null, now: NOW });
  expect(byId(alone, "tunnel")).toMatchObject({ pill: "中斷", control: "restart_runtime" });
  // The healthy runtime row gives up the same control, and nothing offers 重試工作台.
  expect(byId(alone, "runtime").control).toBeNull();
  expect(alone.some((row) => row.control === "retry_workbench")).toBe(false);
  // With the status line offering the restart, no row repeats it.
  const view = deriveDesktopView(snapshot, { now: NOW });
  const rows = deriveCheckRows({ snapshot, checks: null, now: NOW, statusAction: view.action });
  expect(rows.some((row) => row.control === "restart_runtime")).toBe(false);
});

test("a Tunnel failure offers its one fix only where the status line does not", () => {
  const { rows } = rowsFor("error");
  expect(byId(rows, "tunnel")).toMatchObject({ tone: "danger", pill: "中斷", control: null });
  const state = createDemoState("error", NOW);
  const alone = deriveCheckRows({ snapshot: demoSnapshot(state, NOW), checks: null, now: NOW });
  expect(byId(alone, "tunnel").control).toBe("restart_tunnel");
});

test("an automatic retry counts down and offers nothing to press", () => {
  const { rows } = rowsFor("tunnel-retry");
  const tunnel = byId(rows, "tunnel");
  expect(tunnel).toMatchObject({ tone: "running", pill: "自動重試中", control: null });
  // The status line counts down; the row adds how many retries have run.
  expect(tunnel.detail).toBe("近 5 分鐘已自動重試 1 次");
});

test("an older workbench is a warning with the retry the Companion suggests", () => {
  const { rows, snapshot } = rowsFor("mismatch");
  expect(byId(rows, "workbench")).toMatchObject({
    tone: "warning",
    pill: "版本不同",
    detail: "由其他程式啟動",
    // The status line already offers 重試工作台.
    control: null,
  });
  const alone = deriveCheckRows({ snapshot, checks: null, now: NOW });
  expect(byId(alone, "workbench").control).toBe("retry_workbench");
  // An external workbench does not report pairings: unknown, never claimed.
  expect(byId(rows, "panel")).toMatchObject({ pill: "待確認", pillIcon: "Question" });
});

test("a control is offered once: by the row that needs it, not also by a healthy one", () => {
  const { snapshot } = rowsFor("ready");
  if (!snapshot.companion) throw new Error("fixture companion missing");
  // A workbench the service started runs another version: restarting the service fixes it.
  snapshot.versionMismatch = true;
  snapshot.companion.versionMismatch = true;
  snapshot.companion.workbenchVersion = "0.1.4";
  const rows = deriveCheckRows({ snapshot, checks: null, now: NOW });
  expect(byId(rows, "workbench")).toMatchObject({ tone: "warning", control: "restart_runtime" });
  expect(byId(rows, "runtime")).toMatchObject({ tone: "success", control: null });
  const controls = rows.flatMap((row) => (row.control ? [row.control] : []));
  expect(new Set(controls).size).toBe(controls.length);
});

test("environment checks map each code to one fact and an unknown stays unknown", () => {
  const { snapshot } = rowsFor("ready");
  const rows = deriveCheckRows({
    snapshot,
    now: NOW,
    checks: [
      { id: "workspaces", state: "warn", code: "workspaces_unavailable", count: 2 },
      { id: "data_dir", state: "error", code: "data_dir_unwritable" },
      { id: "codex_cli", state: "warn", code: "codex_cli_missing", fix: "show_codex_help" },
      { id: "mcp_config", state: "unknown", code: "mcp_config_unreadable" },
    ],
  });
  expect(byId(rows, "workspaces")).toMatchObject({
    tone: "warning",
    detail: "2 個專案的資料夾已移動或刪除",
    control: "show_projects",
  });
  expect(byId(rows, "data_dir")).toMatchObject({ tone: "danger", pill: "無法寫入" });
  // Codex CLI is optional: missing is a fact, not a failure.
  expect(byId(rows, "codex_cli")).toMatchObject({ tone: "neutral", pill: "未安裝" });
  expect(byId(rows, "mcp_config")).toMatchObject({ pill: "無法確認", pillIcon: "Question" });
});

test("no row repeats the cause or the meta the status line states", () => {
  for (const mode of DEMO_MODES) {
    const { rows, view } = rowsFor(mode);
    if (view.state === "ready") continue;
    for (const row of rows) {
      if (!row.detail) continue;
      expect(view.title).not.toContain(row.detail);
      expect(view.meta).not.toContain(row.detail);
      expect(row.detail).not.toContain(view.title);
    }
  }
  const { rows } = rowsFor("tunnel-auth");
  expect(byId(rows, "key").detail).toBe("由作業系統保管");
  expect(byId(rows, "tunnel").detail).toBe("使用 kairomes profile");
  expect(byId(rowsFor("runtime-error").rows, "runtime").detail).toBe("由 Kairomes Desktop 啟動");
});

test("every row holds at most one control and only fixed text", () => {
  for (const mode of ["setup", "ready", "empty", "attention", "error", "tunnel-auth"] as const) {
    for (const row of rowsFor(mode).rows) {
      expect(`${row.name} ${row.pill} ${row.detail}`).not.toMatch(FORBIDDEN);
      expect(typeof row.control === "string" || row.control === null).toBe(true);
    }
  }
});

test("the fallback summary holds enums and versions only", () => {
  const down = demoSnapshot(createDemoState("runtime-error", NOW), NOW);
  expect(snapshotSummary(down)).toBe(
    `Kairomes ${VERSION} 診斷摘要\ncompanion: warn companion_unavailable fix=restart_runtime`,
  );
  const rejected = demoSnapshot(createDemoState("tunnel-auth", NOW), NOW);
  const summary = snapshotSummary(rejected);
  expect(summary).toContain("tunnel: error tunnel_failed reason=auth fix=configure_key");
  expect(summary).toContain(`companion: ok companion_running version=${VERSION}`);
  // The Tunnel's log tail and message stay out.
  expect(summary).not.toMatch(/control plane|401|Exit|\{/);
});
