import { expect, test } from "bun:test";
import {
  type CompanionRailStatus,
  companionPage,
  companionRail,
  pairingProgress,
} from "./companion-page.ts";

function status(overrides: Partial<CompanionRailStatus> = {}): CompanionRailStatus {
  return {
    workbench: { state: "running", label: "執行中", message: "工作台正常。", meta: "" },
    tunnel: {
      state: "running",
      label: "執行中",
      message: "",
      meta: "",
      logs: [],
      startedAt: "2026-10-06T07:00:00.000Z",
      reason: null,
      restartCount: 0,
      nextRetryAt: null,
    },
    connector: { state: "connected", label: "最近有連線", message: "", meta: "" },
    workspaces: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Kairomes",
        capabilities: ["read", "write_request"],
      },
    ],
    extension: { configured: true },
    versionMismatch: false,
    attention: { pairedPanels: 1 },
    ...overrides,
  };
}

const byId = (rows: ReturnType<typeof companionRail>) =>
  Object.fromEntries(rows.map((row) => [row.id, row]));

test("the rail states each part once, in a fixed order, with a pill and at most one action", () => {
  const rows = companionRail(status(), { enabled: 2, total: 3 });
  expect(rows.map((row) => row.name)).toEqual([
    "本機工作台",
    "安全通道",
    "ChatGPT",
    "專案",
    "MCP",
    "瀏覽器側欄",
  ]);
  const row = byId(rows);
  expect(row.workbench?.state).toBe("執行中");
  expect(row.chatgpt).toMatchObject({ tone: "success", state: "已連上", detail: "" });
  expect(row.projects?.state).toBe("1 個");
  expect(row.mcp?.state).toBe("2／3 已開啟");
  expect(row.panel).toMatchObject({ tone: "success", state: "已連線" });
  // Healthy rows say nothing more than their state; their optional actions stay quiet.
  expect(rows.filter((item) => item.detail)).toEqual([]);
  expect(rows.filter((item) => item.action && !item.action.quiet)).toEqual([]);
  expect(row.tunnel?.action).toEqual({ action: "stop_tunnel", label: "停止", quiet: true });
});

test("a row that needs the user carries one sentence and the matching action", () => {
  const waiting = byId(
    companionRail(
      status({ connector: { state: "waiting", label: "", message: "", meta: "" } }),
      undefined,
    ),
  );
  expect(waiting.chatgpt).toMatchObject({
    tone: "brand",
    detail: "請在 ChatGPT 重新整理連接器。",
    action: { action: "open_connectors", label: "開啟 ChatGPT 設定" },
  });
  expect(waiting.mcp?.state).toBe("讀取中");

  const base = status();
  const tunnelError = (reason: "auth" | "network", nextRetryAt: string | null = null) =>
    byId(
      companionRail(
        status({
          tunnel: {
            ...base.tunnel,
            state: "error",
            message: "安全通道已中斷。",
            reason,
            nextRetryAt,
          },
        }),
        null,
      ),
    );
  // A rejected key is not fixed by a restart, so no restart is offered.
  expect(tunnelError("auth").tunnel).toMatchObject({ tone: "danger", action: null });
  expect(tunnelError("network").tunnel?.action).toEqual({
    action: "restart_tunnel",
    label: "重新啟動",
  });
  expect(tunnelError("network", "2026-10-06T07:01:00.000Z").tunnel).toMatchObject({
    tone: "warning",
    state: "稍後自動重試",
  });
  expect(tunnelError("network").mcp).toMatchObject({ tone: "warning", state: "設定無法讀取" });

  const stopped = byId(
    companionRail(
      status({
        workbench: { state: "error", label: "", message: "工作台沒有回應。", meta: "" },
        workspaces: [],
        extension: { configured: false },
      }),
      { enabled: 0, total: 0 },
    ),
  );
  expect(stopped.workbench).toMatchObject({
    tone: "danger",
    detail: "工作台沒有回應。",
    action: { action: "retry_workbench", label: "重試" },
  });
  expect(stopped.projects).toMatchObject({ tone: "warning", state: "尚未加入" });
  expect(stopped.mcp?.state).toBe("未設定");
  // No pairing link without a running workbench or a saved Extension ID.
  expect(stopped.panel).toMatchObject({ state: "尚未設定", action: null });
});

test("a version mismatch asks to take over the workbench instead of claiming it is fine", () => {
  const row = byId(companionRail(status({ versionMismatch: true }), { enabled: 0, total: 0 }));
  expect(row.workbench).toMatchObject({
    tone: "warning",
    state: "版本不同",
    action: { action: "retry_workbench", label: "重新接管" },
  });
});

test("the page is one static card: no hero, eyebrow, logo image or interpolated status", () => {
  const html = companionPage("0.3.0");
  expect(html).toContain('<html lang="zh-Hant-TW">');
  expect(html).toContain("Kairomes 正在背景執行");
  expect(html.match(/關閉這個頁面不會停止 Kairomes。/g)).toHaveLength(1);
  expect(html).toContain('<meta name="color-scheme" content="light dark">');
  expect(html).toContain("prefers-color-scheme: dark");
  expect(html).not.toMatch(/<img|LOCAL APP|SECURE TUNNEL|ONE PLACE|clamp\(/);
  expect(html).not.toMatch(/confirm\(/);
  // Every declared font size is at least 14px.
  for (const match of html.matchAll(/font-size:\s*(\d+)px/g))
    expect(Number(match[1])).toBeGreaterThanOrEqual(14);
  expect(html).toContain("版本 0.3.0");
  expect(companionPage('1.0.0"><script>')).not.toContain('"><script>');
  // Exactly one inline script, which compiles and never closes its own tag early.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const source = scripts[0]?.[1] ?? "";
  expect(() => new Function(source)).not.toThrow();
  expect(source).toContain("const companionRail = (");
  // No inline handlers or style attributes, so the CSP needs no unsafe-inline for scripts.
  expect(html).not.toMatch(/\son[a-z]+=|\sstyle="/);
});

test("a pairing link is noticed as used even after saving an Extension ID reset the count", () => {
  // One panel was paired when the link was made; the workbench restart forgot it.
  let progress = pairingProgress(1, 0);
  expect(progress).toEqual({ baseline: 0, used: false });
  progress = pairingProgress(progress.baseline, 0);
  expect(progress).toEqual({ baseline: 0, used: false });
  // The new panel pairs with the link: 0 → 1 is above the lowered baseline.
  expect(pairingProgress(progress.baseline, 1)).toEqual({ baseline: 0, used: true });
  // Without a count nothing changes; an unknown baseline is learnt first.
  expect(pairingProgress(1, null)).toEqual({ baseline: 1, used: false });
  expect(pairingProgress(null, 2)).toEqual({ baseline: 2, used: false });
  expect(pairingProgress(2, 2)).toEqual({ baseline: 2, used: false });
  // The page inlines the same function.
  expect(companionPage("0.3.0")).toContain("const pairingProgress = (");
});
