import { expect, test } from "bun:test";
import type { Command, FileChange, FileResult, SearchResult, Snapshot } from "@kairomes/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkbenchBridge } from "./bridge.ts";
import { CommandPanel } from "./command-panel.tsx";
import { DiffPreview, DiffView } from "./diff-view.tsx";
import { FileBrowser, FileViewer } from "./file-browser.tsx";
import { FileChangePanel } from "./file-change-panel.tsx";
import { type FilesView, filesPane, filesResultPatch } from "./files-state.ts";
import { OutputView } from "./output-view.tsx";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const pendingBridge = {
  mode: "workbench",
  call: () => new Promise<never>(() => {}),
} as unknown as WorkbenchBridge;
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, "");

const command: Command = {
  id: "20000000-0000-4000-8000-000000000001",
  request_id: "20000000-0000-4000-8000-000000000002",
  workspace_id: workspaceId,
  cwd: "",
  argv: ["bun", "test", "--filter", "render"],
  timeout_ms: 120_000,
  state: "failed",
  created_at: 0,
  started_at: 1_000,
  ended_at: 5_200,
  expires_at: 100_000,
  exit_code: 1,
  signal: null,
  message: "1 個測試未通過",
};

test("command detail: one head, facts, workspace-relative cwd and no id or class names", () => {
  const html = renderToStaticMarkup(
    <CommandPanel
      bridge={pendingBridge}
      workspaceId={workspaceId}
      liveCommands={[command]}
      focus={{ id: command.id, seq: 1 }}
      workspaceName={() => "Kairomes"}
    />,
  );
  expect(html.match(/class="insp-head"/g)?.length).toBe(1);
  expect([...html.matchAll(/class="insp-argv__item">([^<]+)</g)].map((match) => match[1])).toEqual([
    "bun",
    "test",
    "--filter",
    "render",
  ]);
  expect(html).toContain(">失敗<");
  expect(html).toContain("<dt>結束碼</dt>");
  expect(html).toContain('data-tone="danger">1</dd>');
  expect(html).toContain("<dt>耗時</dt><dd>4.2 秒</dd>");
  expect(html).toContain("專案根目錄");
  expect(html).toContain('aria-label="複製指令"');
  expect(html).toContain("1 個測試未通過");
  expect(html).toContain("正在讀取輸出…");
  // Ids live only in the 技術資訊 disclosure.
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, "");
  expect(visible).not.toContain(command.id.slice(0, 8));
  expect(html).toContain("技術資訊");
  expect(html).not.toContain("<select");
  expect(html).not.toMatch(/Error:|已驗證|Exit 1/);
  // Finished: no cancel. The only negative action ever offered is cancel.
  expect(html).not.toContain("取消命令");
  const running = renderToStaticMarkup(
    <CommandPanel
      bridge={pendingBridge}
      workspaceId={workspaceId}
      liveCommands={[
        { ...command, state: "pending", started_at: null, ended_at: null, exit_code: null },
      ]}
      focus={{ id: command.id, seq: 1 }}
    />,
  );
  expect(running).toContain("取消命令");
  // A rejected command never ran: no output card, no 執行時結果, 沒有輸出 nowhere.
  const rejected = renderToStaticMarkup(
    <CommandPanel
      bridge={pendingBridge}
      workspaceId={workspaceId}
      liveCommands={[
        {
          ...command,
          state: "denied",
          started_at: null,
          ended_at: null,
          exit_code: null,
          message: null,
        },
      ]}
      focus={{ id: command.id, seq: 1 }}
    />,
  );
  expect(rejected).toContain("命令沒有執行。");
  expect(rejected).not.toContain("k-output");
  expect(rejected).not.toContain("執行時結果");
  expect(rejected).not.toContain("沒有輸出");
  expect(rejected).not.toContain("正在讀取輸出");
  expect(running).toContain("請在側欄審核");
  expect(running).not.toMatch(/允許|核准這次|拒絕/);
});

test("without a focus the command panel is a record list, never a native select", () => {
  const html = renderToStaticMarkup(
    <CommandPanel bridge={pendingBridge} workspaceId={workspaceId} liveCommands={[command]} />,
  );
  expect(html).toContain(`data-record-id="${command.id}"`);
  expect(html).toContain('<span class="k-mono">bun test --filter render</span>');
  expect(html).not.toContain("<select");
  expect(html).not.toContain(`${command.id.slice(0, 8)} ·`);
});

test("output: stderr filter only when stderr has lines, a tail with line numbers and copy", () => {
  const both = renderToStaticMarkup(
    <OutputView stdout={"a\nb\nc\n"} stderr={"boom\n"} tail={2} status="執行時結果" />,
  );
  expect(both).toContain("只看 stderr");
  expect(both).toContain("最後 2 行 · 執行時結果");
  expect(both).toContain("完整輸出");
  expect(both).toContain('aria-label="複製輸出"');
  expect(both).toContain('data-kind="err"');
  const plain = renderToStaticMarkup(<OutputView stdout={"a\n"} stderr="" />);
  expect(plain).not.toContain("只看 stderr");
  expect(plain).not.toContain("完整輸出");
  expect(plain).toContain('<span class="k-output__ln">1</span><span class="k-output__tx">a</span>');
});

test("one diff renderer: per-file sections, counts, gutters, hunk labels and truncation", () => {
  const diff = [
    "--- a/src/main.ts",
    "+++ b/src/main.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "",
    "--- /dev/null",
    "+++ b/src/view.ts",
    "@@ create file @@",
    "+export {};",
  ].join("\n");
  const html = renderToStaticMarkup(<DiffView diff={diff} truncated />);
  expect(html.match(/class="k-diff"/g)?.length).toBe(2);
  expect(html).toContain(
    '<span class="k-diff__dir">src/</span><span class="k-diff__file">main.ts</span>',
  );
  expect(html).toContain("新檔案");
  expect(html).toContain(
    '<span class="k-diff__plus">+1</span><span class="k-diff__minus">−1</span>',
  );
  expect(html).toContain("第 1 行起");
  expect(html).toContain("差異只顯示部分內容");
  // The diff was cut: counts are a minimum and the change's own file count is used.
  expect(html).toContain("2 個檔案 · 至少 +2 −1");
  expect(renderToStaticMarkup(<DiffView diff={diff} truncated fileCount={4} />)).toContain(
    "4 個檔案 · 至少 +2 −1",
  );
  expect(html.match(/wb-diff__partial/g)?.length).toBe(1);
  expect(renderToStaticMarkup(<DiffView diff={diff} truncated={false} />)).toContain(
    "2 個檔案 · +2 −1",
  );
  // Old and new line numbers sit in separate gutters.
  expect(html).toContain(
    '<span class="k-diff__ln k-diff__ln--old">2</span><span class="k-diff__ln"></span>',
  );
  expect(html).not.toContain("data-numbers");
  // Exact replacements carry no numbers, so their section reserves no gutter.
  const replacement = renderToStaticMarkup(
    <DiffView
      diff={["--- a/a.md", "+++ b/a.md", "@@ exact replacement 1 @@", "-a", "+b"].join("\n")}
      truncated={false}
    />,
  );
  expect(replacement).toContain('data-numbers="off"');
});

test("loading a diff is a status line, never a fake numbered diff row", () => {
  const change: FileChange = {
    id: "30000000-0000-4000-8000-000000000001",
    request_id: "30000000-0000-4000-8000-000000000002",
    workspace_id: workspaceId,
    summary: "合成變更",
    state: "pending",
    created_at: 0,
    applied_at: null,
    expires_at: 100,
    message: null,
    files: [{ operation: "edit", path: "src/a.ts", before_version: null, after_version: null }],
  };
  const preview = renderToStaticMarkup(<DiffPreview bridge={pendingBridge} change={change} />);
  expect(preview).toBe('<p class="insp-status" role="status">正在取得差異…</p>');
  const list = renderToStaticMarkup(
    <FileChangePanel
      bridge={pendingBridge}
      workspaceId={null}
      liveChanges={[change]}
      workspaceName={() => "Kairomes"}
    />,
  );
  expect(list).toContain(`data-record-id="${workspaceId}:src/a.ts"`);
  expect(list).toContain('<span class="k-mono">a.ts</span>');
  expect(list).toContain("需確認");
  expect(list).not.toMatch(/允許|拒絕/);
});

const snapshot: Snapshot = {
  kind: "snapshot",
  workspace: { id: workspaceId, name: "Kairomes", capabilities: ["read"] },
  path: "apps/extension/src",
  entries: [
    { name: "icons", path: "apps/extension/src/icons", kind: "directory" },
    { name: "a.ts", path: "apps/extension/src/a.ts", kind: "file" },
    { name: "logo.png", path: "apps/extension/src/logo.png", kind: "file" },
  ],
  truncated: true,
};
const browserProps = {
  onTab: noop,
  snapshot,
  search: null,
  query: "",
  onQuery: noop,
  caseSensitive: false,
  onCaseSensitive: noop,
  onSearch: noop,
  onClearSearch: noop,
  busy: false,
  disabled: false,
  onBrowse: noop,
  onOpenEntry: noop,
  onOpenHit: noop,
};

test("the file browser: breadcrumbs without the project name, filename rows, limit note", () => {
  const html = renderToStaticMarkup(
    <FileBrowser {...browserProps} tab="files" currentPath="apps/extension/src/a.ts" />,
  );
  expect(html).toContain('aria-label="專案根目錄"');
  expect(text(html)).toContain("appsextensionsrc");
  expect(html).not.toContain("Kairomes");
  expect(html).toContain('<span class="k-row__title">a.ts</span>');
  expect(html).toContain('aria-current="true"');
  // The note counts what was returned (a model snapshot may stop at 100, a scan cap sooner).
  expect(html).toContain("只顯示前 3 個項目");
  expect(html).not.toContain("唯讀");
  // 瀏覽／搜尋 are tabs with one tab stop, controlling the panel below them.
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((match) => match[0]);
  expect(tabs.length).toBe(2);
  const panel = /<div id="([^"]+)" class="fb-body" role="tabpanel" aria-labelledby="([^"]+)"/.exec(
    html,
  );
  expect(panel).not.toBeNull();
  for (const tab of tabs) expect(tab).toContain(`aria-controls="${panel?.[1]}"`);
  expect(tabs[0]).toContain('tabindex="0"');
  expect(tabs[0]).toContain(`id="${panel?.[2]}"`);
  expect(tabs[1]).toContain('tabindex="-1"');
});

test("in 全部專案 the browser and viewer name the project the switcher does not", () => {
  const project = { id: workspaceId, name: "第二個專案", hue: 3 };
  const html = renderToStaticMarkup(
    <FileBrowser {...browserProps} tab="files" project={project} />,
  );
  expect(html).toContain('aria-label="第二個專案 專案根目錄"');
  expect(html).toContain(
    '<span class="k-tag" data-ws="3" title="第二個專案"><span>第二個專案</span>',
  );
  const searching = renderToStaticMarkup(
    <FileBrowser {...browserProps} tab="search" project={project} />,
  );
  expect(searching).toContain("<span>第二個專案</span>");
  // One project in the switcher: never repeated.
  expect(renderToStaticMarkup(<FileBrowser {...browserProps} tab="files" />)).not.toContain(
    "k-tag",
  );
});

test("search results: grouped by file, filename first, marked match and one summary line", () => {
  const search: SearchResult = {
    kind: "search",
    workspace_id: workspaceId,
    query: "approval",
    matches: [
      { path: "apps/extension/src/approval-panel.ts", line: 16, text: "const a = approval;" },
      { path: "apps/extension/src/approval-panel.ts", line: 20, text: "Approval()" },
      { path: "README.md", line: 2, text: "# approval" },
    ],
    truncated: false,
    scanned_files: 6,
    skipped_files: 4,
  };
  const html = renderToStaticMarkup(
    <FileBrowser {...browserProps} tab="search" search={search} query="approval" />,
  );
  expect(html.match(/class="k-card srch-group"/g)?.length).toBe(2);
  expect(html).toContain(
    '<span class="k-mono">approval-panel.ts</span><span class="hit-file__dir">apps/extension/src</span>',
  );
  expect(html.match(/<mark class="k-mark">/g)?.length).toBe(3);
  expect(html).toContain("3 筆 · 已掃描 6 個檔案");
  // The summary sits under the field, before the results.
  expect(html.indexOf("srch-summary")).toBeLessThan(html.indexOf("srch-groups"));
  expect(html).not.toContain("略過");
  expect(html).toContain("區分大小寫");
  expect(html).toContain('role="tab"');
  // No match is said once, without a 0 筆 summary beside it.
  const none = renderToStaticMarkup(
    <FileBrowser
      {...browserProps}
      tab="search"
      search={{ ...search, query: "message", matches: [] }}
      query="message"
    />,
  );
  expect(none).toContain("沒有符合「message」的結果。");
  expect(none).not.toContain("0 筆");
});

test("a search result opened over a loaded file shows the search, not the old file", () => {
  const loaded: FilesView = {
    file: {
      kind: "file",
      workspace_id: workspaceId,
      path: "src/main.ts",
      content: "x\n",
      version: "f".repeat(64),
      start_line: 1,
      total_lines: 2,
      next_line: null,
      truncated: false,
      redacted: false,
    },
    fileFocus: { path: "src/main.ts", line: 1 },
    search: null,
    snapshot,
    artifact: null,
    tab: "files",
  };
  const search: SearchResult = {
    kind: "search",
    workspace_id: workspaceId,
    query: "approval",
    matches: [{ path: "README.md", line: 2, text: "# approval" }],
    truncated: false,
    scanned_files: 6,
    skipped_files: 0,
  };
  const next = { ...loaded, ...filesResultPatch(search) };
  expect(next.file).toBeNull();
  expect(next.fileFocus).toBeUndefined();
  expect(next.snapshot).toBe(snapshot);
  expect(filesPane(next)).toBe("search");
  const html = renderToStaticMarkup(
    <FileBrowser
      {...browserProps}
      tab={next.tab}
      search={next.search}
      snapshot={next.snapshot}
      query="approval"
    />,
  );
  expect(html).toContain('class="srch-groups"');
  expect(html).not.toContain('class="fv"');
  // A folder result closes the file too; a file result opens on 瀏覽.
  expect(filesPane({ ...loaded, ...filesResultPatch(snapshot) })).toBe("files");
  expect(filesResultPatch(snapshot)).toMatchObject({ file: null, search: null });
  const reopened = { ...next, ...filesResultPatch(loaded.file as FileResult) };
  expect(filesPane(reopened)).toBe("viewer");
  expect(reopened.search).toBe(search);
});

test("the viewer marks the hit line, keeps meta to one line and hides the version", () => {
  const file: FileResult = {
    kind: "file",
    workspace_id: workspaceId,
    path: "src/main.ts",
    content: "a\nb\nc\n",
    version: "f".repeat(64),
    start_line: 40,
    total_lines: 300,
    next_line: 190,
    truncated: false,
    redacted: false,
  };
  const html = renderToStaticMarkup(
    <FileViewer
      file={file}
      focusLine={41}
      busy={false}
      disabled={false}
      onPage={noop}
      onBack={noop}
      backLabel="返回搜尋結果"
    />,
  );
  expect(html).toMatch(/<div class="fv-line" data-focus="">.*?41/);
  expect(html.match(/data-focus/g)?.length).toBe(1);
  expect(text(html)).toContain("300 行·第 40–42 行");
  expect(html).toContain("技術資訊");
  expect(html).not.toMatch(/UTF-8|READ ONLY|唯讀/);
  expect(html).toContain('aria-label="返回搜尋結果"');
  expect(html).toContain("複製這頁");
});
