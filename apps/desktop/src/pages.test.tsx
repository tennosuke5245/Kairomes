import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionPage, pairingAnnouncement } from "./connection.tsx";
import { createDemoState, type DemoMode, demoSnapshot, demoWorkspacePaths } from "./demo.ts";
import { DiagnosticsPage } from "./diagnostics.tsx";
import { deriveAttention, deriveDesktopView } from "./model.ts";
import type { PairingLink } from "./pairing.ts";
import { ProjectsPage } from "./projects.tsx";

// Static markup of the real pages over synthetic demo data: no DOM, host or network.
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const noop = () => undefined;
const PAIRING_URL = "http://127.0.0.1:43111/pair#code=synthetic-one-time-code";

function demo(mode: DemoMode) {
  const state = createDemoState(mode, NOW);
  return { state, snapshot: demoSnapshot(state, NOW) };
}

const buttons = (markup: string) =>
  [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    (match[1] ?? "").replace(/<[^>]+>/g, ""),
  );
const primaries = (markup: string) => markup.match(/k-btn--primary/g)?.length ?? 0;

function projects(mode: DemoMode, options: { busy?: boolean } = {}) {
  const { state, snapshot } = demo(mode);
  return renderToStaticMarkup(
    <ProjectsPage
      grid={{
        workspaces: snapshot.companion?.workspaces ?? [],
        paths: new Map(demoWorkspacePaths(state).map((entry) => [entry.id, entry.root])),
        attention: deriveAttention(snapshot, NOW),
        unavailable: false,
      }}
      busy={options.busy ?? false}
      canAdd={snapshot.companion !== null}
      dropActive={false}
      handoffUnavailable={() => null}
      onAdd={noop}
      onRename={noop}
      onReveal={noop}
      onHandoff={noop}
      onRemove={noop}
    />,
  );
}

test("專案 lists cards with one overflow menu each and no second heading", () => {
  const markup = projects("attention");
  expect(markup.match(/aria-haspopup="menu"/g)).toHaveLength(2);
  expect(markup).toContain('aria-label="Athori 的更多操作"');
  expect(markup).toContain('id="project-menu-');
  // The page title is the only heading; cards carry names as h3.
  expect(markup).not.toMatch(/<h2/);
  expect(markup).not.toContain("已加入的專案");
  // Unmounting is behind the menu and a confirmation, never a checkbox or an inline button.
  expect(markup).not.toContain('type="checkbox"');
  expect(buttons(markup).join(" ")).not.toContain("解除掛載");
  expect(markup).toContain("也可以把資料夾拖進這個視窗。");
});

test("an empty 專案 page has the empty state with one ink action", () => {
  const markup = projects("empty");
  for (const text of ["還沒有專案", "加入一個資料夾，ChatGPT 才能讀取。", "新增專案"])
    expect(markup).toContain(text);
  expect(primaries(markup)).toBe(1);
  // Without the local service nothing can be added, and nothing claims there are no projects.
  const down = projects("runtime-error");
  expect(down).not.toContain("還沒有專案");
  expect(primaries(down)).toBe(0);
});

function connection(
  mode: DemoMode,
  pairing: PairingLink | null,
  remainingMs = 0,
  busyAction: string | null = null,
) {
  const { snapshot } = demo(mode);
  return renderToStaticMarkup(
    <ConnectionPage
      snapshot={snapshot}
      now={NOW}
      busyAction={busyAction}
      mcpCommand='"C:/Program Files/Kairomes/kairomes-runtime.exe" relay --stdio'
      mcpCommandError=""
      pairing={pairing}
      pairingRemainingMs={remainingMs}
      onAction={noop}
      onSaveExtension={async () => true}
      onCopyPairing={noop}
      onCopyCommand={noop}
    />,
  );
}

test("連線設定 has three rows, each with one pill, and the MCP command behind 進階", () => {
  const markup = connection("ready", null);
  for (const title of ["Runtime API Key", "安全通道", "瀏覽器側欄"])
    expect(markup).toContain(title);
  expect(markup.match(/class="desk-setting"/g)).toHaveLength(3);
  expect(markup.match(/class="k-pill"/g)).toHaveLength(3);
  expect(markup).toMatch(/瀏覽器側欄[\s\S]*已連線/);
  expect(markup).not.toContain("側欄已連線");
  expect(markup).toMatch(/<details class="desk-advanced">[\s\S]*進階[\s\S]*本機 MCP 指令/);
  expect(markup).toContain("移除金鑰…");
  expect(markup).toContain("產生配對連結");
  // A healthy page has no ink button.
  expect(primaries(markup)).toBe(0);
});

test("a live pairing link is masked with a countdown and never rendered", () => {
  const pairing: PairingLink = {
    url: PAIRING_URL,
    receivedAt: NOW,
    expiresInSeconds: 120,
    pairedAtStart: 1,
  };
  const markup = connection("ready", pairing, 105_000);
  expect(markup).not.toContain("synthetic-one-time-code");
  expect(markup).not.toContain("127.0.0.1");
  expect(markup).toContain("剩 1:45");
  expect(markup).toContain("複製連結");
  expect(markup).toContain("（已隱藏）");
  // While the link is live the row offers no second 產生配對連結.
  expect(markup).not.toContain("產生配對連結");
  // Once cleared, the row offers 重新產生.
  const cleared = connection("ready", { ...pairing, url: "", cleared: "left" });
  expect(cleared).toContain("重新產生");
  expect(cleared).not.toContain("剩 ");
});

test("the Extension ID field has a sans placeholder and a mono value", () => {
  const markup = connection("setup", null);
  expect(markup).toMatch(/class="k-input k-input--mono"[^>]*placeholder="貼上 32 位 Extension ID"/);
  expect(markup).toContain("尚未配對");
  // The key that still needs setting holds the page's one ink button.
  expect(primaries(markup)).toBe(1);
});

test("the pairing countdown is announced at one minute and ten seconds only", () => {
  expect(pairingAnnouncement(90_000)).toBe("");
  expect(pairingAnnouncement(60_000)).toBe("配對連結剩 1 分鐘");
  expect(pairingAnnouncement(11_000)).toBe("配對連結剩 1 分鐘");
  expect(pairingAnnouncement(10_000)).toBe("配對連結剩 10 秒");
  expect(pairingAnnouncement(0)).toBe("");
});

test("疑難排解 ends with the privacy sentence and a summary copy, with only fixed text", () => {
  const { snapshot } = demo("tunnel-auth");
  const view = deriveDesktopView(snapshot, { now: NOW });
  const markup = renderToStaticMarkup(
    <DiagnosticsPage
      snapshot={snapshot}
      statusLine={null}
      statusAction={view.action}
      now={NOW}
      busyAction={null}
      loadDiagnostics={() => new Promise(noop)}
      copyText={async () => undefined}
      onControl={noop}
      onCopyFailed={noop}
    />,
  );
  expect(markup).toContain("診斷摘要只含狀態代碼與版本，不含金鑰、路徑或專案內容。");
  expect(markup).toContain("複製診斷摘要");
  expect(markup).toContain("檢查項目");
  // Only the failing row is toned; the status line's fix is not repeated in a row.
  expect(markup.match(/data-state="fail"/g)).toHaveLength(1);
  expect(buttons(markup).join(" ")).not.toContain("更新金鑰");
  const text = markup.replace(/<svg[\s\S]*?<\/svg>/g, "");
  expect(text).not.toMatch(/control plane|401|https?:|[A-Za-z]:\\/);
});

/** Buttons rendered with the `disabled` attribute: they would drop keyboard focus when pressed. */
const disabledButtons = (markup: string) =>
  [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter((match) => / disabled=""/.test(match[1] ?? ""))
    .map((match) => (match[2] ?? "").replace(/<[^>]+>/g, ""));

test("while an action runs, buttons wait with aria-disabled and keep keyboard focus", () => {
  // 產生配對連結 is running: every waiting button stays focusable.
  const markup = connection("ready", null, 0, "create_pairing");
  expect(disabledButtons(markup)).toEqual([]);
  expect(markup).toMatch(
    /aria-busy="true"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-busy="true"/,
  );
  for (const label of ["產生配對連結", "重新啟動", "停止"])
    expect(markup).toMatch(
      new RegExp(`aria-disabled="true"[^>]*>(?:<svg[\\s\\S]*?</svg>)?${label}`),
    );
  // Each row is a focus region: a replaced control hands focus to the row's control or title.
  expect(markup.match(/data-focus-scope=""/g)).toHaveLength(3);
  expect(
    markup.match(/<h2 class="desk-setting__title"[^>]*data-focus-target="2"[^>]*tabindex="-1"/g),
  ).toHaveLength(3);
  // The submit button of the Extension ID form waits the same way.
  expect(disabledButtons(connection("setup", null, 0, "start_tunnel"))).toEqual([]);
});

test("疑難排解 rows and 重新檢查 wait without dropping focus", () => {
  const { snapshot } = demo("error");
  const markup = renderToStaticMarkup(
    <DiagnosticsPage
      snapshot={snapshot}
      statusLine={null}
      statusAction="none"
      now={NOW}
      busyAction="restart_tunnel"
      loadDiagnostics={() => new Promise(noop)}
      copyText={async () => undefined}
      onControl={noop}
      onCopyFailed={noop}
    />,
  );
  // The first render is checking: 重新檢查 waits, still focusable.
  expect(disabledButtons(markup)).toEqual([]);
  expect(markup).toMatch(/aria-disabled="true"[^>]*>[\s\S]*?重新檢查/);
  expect(markup).toMatch(/aria-busy="true"[^>]*aria-disabled="true"[^>]*>[\s\S]*?重新啟動安全通道/);
  expect(markup).toContain('class="desk-health__name"');
  expect(markup).toMatch(/class="desk-health__name"[^>]*data-focus-target="2"[^>]*tabindex="-1"/);
});
