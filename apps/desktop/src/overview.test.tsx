import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoState, type DemoMode, demoSnapshot, demoWorkspacePaths } from "./demo.ts";
import { deriveAttention, deriveDesktopView } from "./model.ts";
import {
  OverviewPage,
  OverviewSkeleton,
  type SetupHandlers,
  StatusLine,
  statusLineContent,
} from "./overview.tsx";
import { Sidebar } from "./shell.tsx";

// Static markup of the real components over synthetic demo data: no DOM, host or network.
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const noop = () => undefined;
const handlers: SetupHandlers = {
  busy: false,
  mcpCommand: '"C:/Program Files/Kairomes/kairomes-runtime.exe" relay --stdio',
  mcpCommandError: "",
  profileMissing: false,
  onAddProject: noop,
  onOpenExternal: noop,
  onCopyCommand: noop,
  onAcknowledgeProfile: noop,
  onRestartTunnel: noop,
  onConfigureKey: noop,
  onPair: noop,
  onOpenConnectors: noop,
};

function render(mode: DemoMode) {
  const state = createDemoState(mode, NOW);
  const snapshot = demoSnapshot(state, NOW);
  const view = deriveDesktopView(snapshot, { now: NOW });
  const attention = deriveAttention(snapshot, NOW);
  const companion = snapshot.companion;
  const overview = renderToStaticMarkup(
    <OverviewPage
      view={view}
      statusLine={
        <StatusLine
          view={view}
          {...(statusLineContent("overview", view, snapshot, NOW, NOW) ?? { meta: "" })}
          busyAction={null}
          onAction={noop}
        />
      }
      attention={attention}
      grantsReadable={Boolean(companion)}
      now={NOW}
      setupHandlers={handlers}
      projects={
        companion
          ? {
              workspaces: companion.workspaces,
              paths: new Map(demoWorkspacePaths(state).map((entry) => [entry.id, entry.root])),
              attention,
              unavailable: view.chatgptUnavailable,
              addWaiting: false,
              onAdd: noop,
            }
          : null
      }
    />,
  );
  const sidebar = renderToStaticMarkup(
    <Sidebar route="overview" onNavigate={noop} projectCount={1} view={view} version="0.2.0" />,
  );
  return { overview, sidebar, view };
}

const buttons = (markup: string) =>
  [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    (match[1] ?? "").replace(/<[^>]+>/g, ""),
  );
const primaries = (markup: string) => markup.match(/k-btn--primary/g)?.length ?? 0;

test("ready states the connection once, in the sidebar chip only", () => {
  const { overview, sidebar } = render("attention");
  expect(sidebar).toContain("已連上 ChatGPT");
  expect(overview).not.toContain("已連上");
  expect(overview).not.toContain("已就緒");
  expect(overview).toContain("本機服務與安全通道運作正常");
  expect(primaries(overview)).toBe(1);
});

test("需注意 shows counts and grant facts but never a way to decide or revoke", () => {
  const { overview } = render("attention");
  for (const text of [
    "需確認",
    "2 件",
    "最快 剩 4:12",
    "1 個命令",
    "1 個檔案變更",
    "請在瀏覽器側欄審核",
  ])
    expect(overview).toContain(text);
  for (const fact of [
    "全自主 · Athori",
    "主機權限",
    "可操作工作區外",
    "可連網",
    "到期後改回逐步確認。",
  ])
    expect(overview).toContain(fact);
  // Approvals happen in the browser side panel: no approve, deny or revoke control on Desktop.
  for (const label of buttons(overview)) expect(label).not.toMatch(/允許|拒絕|收回|核准|延長/);
  expect(overview).not.toMatch(/fingerprint|argv|--token/);
  expect(overview).not.toMatch(/沙箱|只限此聊天/);
});

test("project cards show the Desktop-only root with the full value in title", () => {
  const { overview } = render("attention");
  expect(overview).toContain('title="C:\\Users\\you\\Projects\\Athori"');
  expect(overview).toContain("全自主");
  expect(overview).toContain("逐步確認");
});

test("setup is a neutral checklist with one ink action and the MCP command in its step", () => {
  const { overview, sidebar } = render("setup");
  expect(sidebar).toContain("尚未連上 ChatGPT");
  expect(overview).toContain("還差 4 步，就能讓 ChatGPT 讀取你的專案");
  expect(overview).toContain('aria-current="step"');
  expect(overview).toContain("本機 MCP 指令");
  expect(primaries(overview)).toBe(1);
  expect(overview).not.toContain('data-tone="danger"');
  expect(overview).not.toContain("需注意");
});

test("an error leads with the pathway and offers one fix", () => {
  const { overview, sidebar } = render("tunnel-auth");
  expect(sidebar).toContain('data-tone="danger"');
  expect(sidebar).toContain("安全通道中斷");
  expect(overview).toContain('aria-label="連線路徑"');
  expect(overview).toContain('data-state="fail"');
  expect(overview).toContain('data-state="broken"');
  expect(overview).toContain("ChatGPT 拒絕了 Runtime API Key");
  expect(overview).toContain("更新金鑰");
  expect(primaries(overview)).toBe(1);
  // Projects stay listed but never look healthy while ChatGPT cannot reach them.
  expect(overview).toContain("ChatGPT 目前無法使用");
});

test("疑難排解 leads every problem with the pathway and stays silent while all is well", () => {
  const lineFor = (mode: DemoMode) => {
    const snapshot = demoSnapshot(createDemoState(mode, NOW), NOW);
    const view = deriveDesktopView(snapshot, { now: NOW });
    return {
      overview: statusLineContent("overview", view, snapshot, NOW, NOW),
      diagnostics: statusLineContent("diagnostics", view, snapshot, NOW, NOW),
    };
  };
  const ready = lineFor("ready");
  // Connection is stated only by the sidebar chip, so the ready 疑難排解 has no line at all.
  expect(ready.diagnostics).toBeNull();
  expect(ready.overview?.pathway).toBeNull();
  const setup = lineFor("setup");
  expect(setup.overview?.pathway).toBeNull();
  expect(setup.diagnostics).toMatchObject({
    meta: "已完成 2／6 步，其餘步驟在總覽。",
    progress: false,
  });
  expect(setup.overview?.progress).toBe(true);
  expect(setup.diagnostics?.pathway?.nodes).toEqual(["ok", "off", "off"]);
  const attention = lineFor("mismatch");
  expect(attention.diagnostics?.pathway?.nodes[0]).toBe("ok");
  const rejected = lineFor("tunnel-auth");
  expect(rejected.overview?.pathway).toEqual(rejected.diagnostics?.pathway ?? null);
  expect(rejected.diagnostics?.pathway?.nodes).toEqual(["ok", "fail", "off"]);
});

test("first paint is a neutral skeleton, never a setup prompt", () => {
  const skeleton = renderToStaticMarkup(<OverviewSkeleton />);
  const sidebar = renderToStaticMarkup(
    <Sidebar route="overview" onNavigate={noop} projectCount={null} view={null} version="0.2.0" />,
  );
  for (const markup of [skeleton, sidebar]) {
    expect(markup).not.toMatch(/設定安全連線|設定金鑰|金鑰|尚未連上|已連上|需要你處理/);
    expect(primaries(markup)).toBe(0);
  }
  expect(skeleton).toContain("正在讀取 Kairomes 狀態");
});

test("the tray hint is not a sidebar card: it waits for the first close", () => {
  const { view, overview } = render("ready");
  const sidebar = renderToStaticMarkup(
    <Sidebar route="overview" onNavigate={noop} projectCount={1} view={view} version="0.2.0" />,
  );
  // The sidebar holds the nav, the one status chip and the version; no tip, no extra tab stop.
  expect(sidebar).not.toMatch(/系統匣|關閉後仍執行|desk-tip/);
  expect(sidebar.match(/<button/g)).toHaveLength(5);
  expect(overview).not.toMatch(/系統匣|關閉後仍執行/);
});

test("a waiting status action and setup step keep focus, and the step title can take it", () => {
  const state = createDemoState("error", NOW);
  const snapshot = demoSnapshot(state, NOW);
  const view = deriveDesktopView(snapshot, { now: NOW });
  const line = renderToStaticMarkup(
    <StatusLine
      view={view}
      {...(statusLineContent("overview", view, snapshot, NOW, NOW) ?? { meta: "" })}
      busyAction="restart_tunnel"
      onAction={noop}
    />,
  );
  // The pressed button spins and waits; it is never `disabled`, which would drop focus.
  expect(line).not.toContain('disabled=""');
  expect(line).toMatch(/aria-busy="true"[^>]*data-focus-target="1"[^>]*aria-disabled="true"/);
  // When the action is done and its button goes, the status sentence takes focus.
  expect(line).toContain("data-focus-scope");
  expect(line).toMatch(/class="k-statusline__title"[^>]*data-focus-target="2"[^>]*tabindex="-1"/);

  const setup = createDemoState("setup", NOW);
  const setupSnapshot = demoSnapshot(setup, NOW);
  const setupView = deriveDesktopView(setupSnapshot, { now: NOW });
  const busy = renderToStaticMarkup(
    <OverviewPage
      view={setupView}
      statusLine={null}
      attention={deriveAttention(setupSnapshot, NOW)}
      grantsReadable
      now={NOW}
      setupHandlers={{ ...handlers, busy: true }}
      projects={null}
    />,
  );
  expect(busy).not.toMatch(
    /<button[^>]*disabled=""[^>]*>[^<]*(<svg[\s\S]*?<\/svg>)?(加入專案|下載|我已建立|設定金鑰)/,
  );
  expect(busy).toMatch(/aria-disabled="true"/);
  // The checklist is one focus region; the current step's title is where a finished step hands focus.
  expect(busy).toMatch(/<ol class="k-card k-steps desk-steps"[^>]*data-focus-scope=""/);
  expect(busy).toMatch(/<h3 class="k-step__title"[^>]*data-focus-target="2"[^>]*tabindex="-1"/);
});

test("a card with nothing below its value is compact, so no empty body is drawn", () => {
  const { overview } = render("ready");
  expect(overview).toMatch(
    /class="k-card desk-attn" data-size="compact" aria-labelledby="attn-recent"/,
  );
  const busy = render("attention").overview;
  expect(busy).toMatch(/class="k-card desk-attn" data-tone="brand" aria-labelledby="attn-pending"/);
});
