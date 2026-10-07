import { expect, test } from "bun:test";
import type { ActivityEntry, ActivitySnapshot } from "@kairomes/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityPanel } from "./activity-panel.tsx";
import { TIMELINE_PAGE } from "./timeline-model.ts";

const one = "10000000-0000-4000-8000-000000000001";
const two = "10000000-0000-4000-8000-000000000002";
const now = new Date(2026, 9, 6, 15, 30).getTime();
const read: ActivityEntry = {
  id: "read",
  seq: 3,
  focusSeq: 3,
  source: "mcp",
  kind: "tool",
  tool: "file_read",
  title: "讀取檔案",
  state: "completed",
  updatedAt: now - 30_000,
  workspaceId: one,
  path: "src/main.ts",
  resultId: "result",
};
const failed: ActivityEntry = {
  ...read,
  id: "failed",
  seq: 2,
  focusSeq: 2,
  kind: "command",
  tool: undefined,
  path: undefined,
  resultId: undefined,
  commandId: "command",
  title: "bun · 已失敗",
  state: "failed",
  message: "1 個測試未通過",
  updatedAt: new Date(2026, 9, 6, 9, 12).getTime(),
  workspaceId: two,
};
const listed: ActivityEntry = {
  ...read,
  id: "listed",
  seq: 1,
  focusSeq: 1,
  tool: "git_status",
  title: "查看 Git 狀態",
  path: undefined,
  resultId: undefined,
  workspaceId: undefined,
  updatedAt: new Date(2026, 9, 5, 9, 0).getTime(),
};
const snapshot: ActivitySnapshot = {
  instanceId: "fixture",
  seq: 3,
  sessions: [],
  entries: [read, failed, listed],
};
const names: Record<string, string> = { [one]: "Kairomes", [two]: "docs-site" };
const render = (props: Partial<Parameters<typeof ActivityPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <ActivityPanel
      snapshot={snapshot}
      error=""
      emptyWorkspace={false}
      following
      onResume={() => {}}
      onSelect={() => {}}
      onFiles={() => {}}
      onSearch={() => {}}
      workspaceName={(id) => (id ? (names[id] ?? "其他本機操作") : "其他本機操作")}
      now={now}
      {...props}
    />,
  );

test("the toolbar names the timeline once and states following as a status, not a toggle", () => {
  const html = render();
  expect(html).toContain('<h1 id="');
  expect(html.match(/>動態<\/h1>/g)?.length).toBe(1);
  expect(html).toContain('class="k-live" data-state="live" role="status"');
  expect(html).toContain("即時");
  expect(html).not.toContain('aria-pressed="true" aria-label="暫停');
  expect(html).toContain('aria-label="搜尋專案內容"');
  expect(html).toContain('aria-label="檔案"');
  expect(html).not.toContain("k-newpill");
  const paused = render({ following: false, unread: 3 });
  expect(paused).toContain('data-state="paused"');
  expect(paused).toContain("已暫停跟隨");
  expect(paused).toContain('class="k-newpill"');
  expect(paused).toContain("有 3 則新動態 · 回到最新");
  // Paused with nothing new: no pill to cover the list.
  expect(render({ following: false, unread: 0 })).not.toContain("k-newpill");
});

test("rows are grouped, dense and whole-row buttons; reasons and tags appear once", () => {
  const html = render({ currentId: "read" });
  const labels = [...html.matchAll(/class="k-group-label">([^<]+)</g)].map((match) => match[1]);
  expect(labels).toEqual(["剛剛", "今天", "更早"]);
  expect(html).toContain(
    '<button type="button" class="k-row" aria-current="true" data-activity-id="read" data-roving-item="">',
  );
  expect(html).toContain('讀取 <span class="k-mono">src/main.ts</span>');
  expect(html).toContain("30 秒前");
  // A row under 剛剛 that happened 剛剛 does not repeat the group label.
  const fresh = render({
    snapshot: { ...snapshot, entries: [{ ...read, updatedAt: now - 2_000 }] },
  });
  expect(fresh).toContain('class="k-group-label">剛剛</h2>');
  expect(fresh).not.toContain("<span>剛剛</span>");
  // Each meta dot travels with the item after it, so a wrapped line never ends in one.
  expect(html).toMatch(
    /<span class="wb-mi wb-mi--tag"><span class="k-sep" aria-hidden="true">·<\/span><span class="k-tag"/,
  );
  expect(html).toContain("上午 9:12");
  expect(html).toContain('data-tone="danger">1 個測試未通過</span>');
  expect(html).toContain('執行 <span class="k-mono">bun</span>');
  // No separate small 查看 button: two toolbar icons, four chips and two row buttons.
  expect(html.match(/<button/g)?.length).toBe(8);
  // The failed command row opens a detail; a result-less Git status row is a static record.
  expect(html).toContain('data-activity-id="failed"');
  expect(html).toContain('<div class="k-row" data-static="">');
  expect(html).toContain("<span>Kairomes</span>");
  expect(html).toContain("<span>docs-site</span>");
  expect(html.match(/失敗/g)?.length).toBe(2); // the 失敗 chip and the row's pill
  const filtered = render({ workspaceId: one });
  expect(filtered).not.toContain("<span>Kairomes</span>");
  expect(filtered).not.toContain("docs-site");
});

test("the changed-files button and the 變更 chip never share a label", () => {
  const html = render({ onChanges: () => {}, changeCount: 5 });
  expect(html).toContain('aria-label="本次變更的 5 個檔案"');
  expect(html).toContain("5 個檔案</button>");
  expect(html).not.toMatch(/>變更<span class="k-badge"/);
  expect(html).toContain('aria-pressed="false">變更</button>');
});

test("filter chips show counts only when non-zero and filter without touching unread", () => {
  const html = render();
  expect(html).toContain(
    '<fieldset class="wb-chips k-chips"><legend class="k-sr-only">篩選動態</legend>',
  );
  expect(html).toContain('aria-pressed="true">全部</button>');
  expect(html).toContain('data-tone="danger">失敗<span class="k-chip__count">1</span>');
  expect(html).toContain('aria-pressed="false">命令<span class="k-chip__count">1</span>');
  expect(html).toContain('aria-pressed="false">變更</button>');
  const onlyFailed = render({ defaultFilter: "failed" });
  expect(onlyFailed).toContain('data-activity-id="failed"');
  expect(onlyFailed).not.toContain('data-activity-id="read"');
  const none = render({ defaultFilter: "changes" });
  expect(none).toContain("沒有符合的動態");
  expect(none).toContain("顯示全部");
});

test("paging reaches every retained entry instead of silently capping the list", () => {
  const many: ActivityEntry[] = Array.from({ length: TIMELINE_PAGE + 5 }, (_, index) => ({
    ...read,
    id: `read-${index}`,
    seq: 500 - index,
    focusSeq: 500 - index,
    resultId: `result-${index}`,
  }));
  const html = render({ snapshot: { ...snapshot, entries: many } });
  expect(html.match(/data-activity-id=/g)?.length).toBe(TIMELINE_PAGE);
  expect(html).toContain("顯示更早");
  const short = render();
  expect(short).not.toContain("顯示更早");
});

test("empty, error and pending states use one notice each; approval stays in the side panel", () => {
  const empty = render({ snapshot: { ...snapshot, entries: [] } });
  expect(empty).toContain("還沒有動態");
  expect(empty).not.toContain("篩選動態");
  expect(render({ snapshot: { ...snapshot, entries: [] }, emptyWorkspace: true })).toContain(
    "還沒有專案",
  );
  expect(render({ error: "即時連線中斷。" })).toContain('data-tone="danger" role="alert"');
  const pending: ActivitySnapshot = {
    ...snapshot,
    commands: [
      {
        id: "command",
        request_id: "request",
        workspace_id: one,
        cwd: "",
        argv: ["bun", "test"],
        timeout_ms: 1000,
        state: "pending",
        created_at: now,
        started_at: null,
        ended_at: null,
        expires_at: now + 252_000,
        exit_code: null,
        signal: null,
        message: null,
      },
    ],
  };
  const inline = render({ snapshot: pending });
  expect(inline).toContain("1 件需確認");
  // The same wording as every detail's notice.
  expect(inline).toContain("1 件需確認</span> · 請在側欄審核");
  expect(inline).not.toMatch(/允許|核准這次|approve/i);
  expect(render({ snapshot: pending, nativeControls: true })).not.toContain("件需確認");
  expect(render({ snapshot: pending, workspaceId: two })).not.toContain("件需確認");
});
