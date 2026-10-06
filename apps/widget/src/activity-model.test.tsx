import { expect, test } from "bun:test";
import type { ActivityEntry, ActivitySnapshot, CommandResult } from "@kairomes/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import {
  activityLabel,
  activityTitle,
  unreadActivity,
  visibleActivity,
  workspaceFilterMessage,
} from "./activity-model.ts";
import { ActivityPanel, latestFocus } from "./activity-panel.tsx";
import type { WorkbenchBridge } from "./bridge.ts";
import { CommandOutput } from "./command-panel.tsx";
import { OverviewPanel } from "./overview-panel.tsx";
import { commandEvidence, outputEvidence } from "./result-evidence.ts";

const one = "10000000-0000-4000-8000-000000000001";
const two = "10000000-0000-4000-8000-000000000002";
const entry: ActivityEntry = {
  id: "file",
  seq: 2,
  focusSeq: 1,
  source: "mcp",
  kind: "tool",
  tool: "file_read",
  title: "讀取檔案",
  state: "completed",
  updatedAt: 0,
  workspaceId: one,
  resultId: "result",
};
const snapshot: ActivitySnapshot = {
  instanceId: "fixture",
  seq: 12,
  sessions: [],
  entries: [
    {
      ...entry,
      id: "command-old",
      kind: "command",
      commandId: "command",
      tool: undefined,
      seq: 3,
      focusSeq: 3,
      state: "running",
    },
    {
      ...entry,
      id: "command-new",
      kind: "command",
      commandId: "command",
      tool: undefined,
      seq: 12,
      focusSeq: 3,
      state: "succeeded",
    },
    { ...entry, id: "other", workspaceId: two, seq: 9, focusSeq: 8 },
    { ...entry, id: "unknown", workspaceId: undefined, seq: 10, focusSeq: 9 },
    { ...entry, id: "poll", tool: "terminal_poll", seq: 11, focusSeq: 11 },
    { ...entry, id: "local", source: "local-ui", seq: 13, focusSeq: 13 },
    entry,
  ],
};

test("workspace browsing does not infer unknown ownership; output updates do not inflate unread work", () => {
  expect(visibleActivity(snapshot, one).map((item) => item.id)).toEqual(["command-new", "file"]);
  expect(visibleActivity(snapshot).map((item) => item.id)).toEqual([
    "command-new",
    "unknown",
    "other",
    "file",
  ]);
  expect(unreadActivity(snapshot, 3, one)).toBe(0);
  expect(unreadActivity(snapshot, 3)).toBe(2);
  expect(latestFocus(snapshot, one)?.id).toBe("command-new");
  expect(latestFocus(snapshot)?.id).toBe("unknown");
});

test("read-only Git calls appear in the timeline without taking the follow focus", () => {
  const git: ActivityEntry = {
    ...entry,
    id: "git",
    tool: "git_diff",
    title: "查看 Git 差異",
    seq: 20,
    focusSeq: 20,
  };
  const observed: ActivitySnapshot = { ...snapshot, seq: 20, entries: [...snapshot.entries, git] };
  expect(visibleActivity(observed, one).map((item) => item.id)).toEqual([
    "git",
    "command-new",
    "file",
  ]);
  expect(latestFocus(observed, one)?.id).toBe("command-new");
});

test("trust boundary accepts only the workspace navigation envelope, never added privileges", () => {
  const message = { type: "kairomes:workspace-filter", version: 1, workspaceId: one };
  expect(workspaceFilterMessage(message)).toEqual({ workspaceId: one });
  expect(workspaceFilterMessage({ ...message, workspaceId: null })).toEqual({ workspaceId: null });
  for (const invalid of [
    [],
    { ...message, grant: "full" },
    { ...message, version: 2 },
    { ...message, workspaceId: "untrusted" },
    { ...message, type: "kairomes:approve" },
  ])
    expect(workspaceFilterMessage(invalid)).toBeUndefined();
});

test("operation status is rendered once; native approval counts are not duplicated by the iframe", () => {
  const change: ActivityEntry = {
    ...entry,
    kind: "file_change",
    title: "更新設定 · 已套用",
    state: "applied",
  };
  expect(activityTitle(change)).toBe("更新設定");
  expect(activityLabel(change)).toBe("已套用");
  expect(activityTitle({ ...entry, title: "真實名稱 · 已成功", state: "completed" })).toBe(
    "真實名稱 · 已成功",
  );
  const html = renderToStaticMarkup(
    <ActivityPanel
      snapshot={{ ...snapshot, entries: [change] }}
      error=""
      emptyWorkspace={false}
      following={false}
      unread={2}
      nativeControls
      onFollow={() => {}}
      onSelect={() => {}}
      workspaceName={() => "專案"}
    />,
  );
  expect(html.match(/已套用/g)?.length).toBe(1);
  expect(html).toContain("最新 2");
  expect(html).not.toContain("ChatGPT 即時操作");
  expect(html).not.toContain("上方核准卡");
});

test("paused overview preserves its entry and loaded content across a newer focus, including empty pauses", () => {
  const previous = { ...entry, title: "原先閱讀的檔案", path: "README.md" };
  const initial = { ...snapshot, entries: [previous] };
  // This is the capture used by the pause button, independently of detail selection.
  const incoming = {
    ...entry,
    id: "new",
    resultId: "new-result",
    seq: 20,
    focusSeq: 20,
    title: "後來的操作",
    path: "src/new.ts",
  };
  const next = { ...initial, entries: [incoming, previous], seq: 20 };
  const props = {
    snapshot: next,
    bridge: { mode: "workbench" } as WorkbenchBridge,
    file: {
      kind: "file" as const,
      workspace_id: one,
      path: "README.md",
      content: "原先保留的內容",
      version: "a".repeat(64),
      start_line: 1,
      total_lines: 1,
      next_line: null,
      truncated: false,
      redacted: false,
    },
    search: null,
    artifact: null,
    mcpCall: null,
    loadedResultId: "result",
    workspaceName: () => "專案",
    onFiles: () => {},
    onSelect: () => {},
  };
  const pausedOverview = {
    entry: latestFocus(initial),
    file: props.file,
    search: null,
    artifact: null,
    mcpCall: null,
    loadedResultId: props.loadedResultId,
  };
  // Opening another detail may clear or replace its live payload; returning must
  // retain the original overview's evidence without fetching or reopening it.
  const laterProps = {
    ...props,
    file: { ...props.file, path: "src/new.ts", content: "另一筆詳情內容" },
    loadedResultId: "new-result",
  };
  const locked = renderToStaticMarkup(
    <OverviewPanel {...laterProps} pausedOverview={pausedOverview} />,
  );
  expect(locked).toContain("原先閱讀的檔案");
  expect(locked).toContain("原先保留的內容");
  expect(locked).not.toContain("後來的操作");
  expect(locked).not.toContain("另一筆詳情內容");
  const cleared = renderToStaticMarkup(
    <OverviewPanel
      {...laterProps}
      file={null}
      loadedResultId={undefined}
      pausedOverview={pausedOverview}
    />,
  );
  expect(cleared).toContain("原先保留的內容");
  const resumed = renderToStaticMarkup(<OverviewPanel {...props} />);
  expect(resumed).toContain("後來的操作");
  expect(resumed).not.toContain("原先保留的內容");
  const pausedEmpty = renderToStaticMarkup(
    <OverviewPanel
      {...props}
      pausedOverview={{ file: null, search: null, artifact: null, mcpCall: null }}
    />,
  );
  expect(pausedEmpty).not.toContain("後來的操作");
});

const result: CommandResult = {
  kind: "command",
  command: {
    id: one,
    request_id: two,
    workspace_id: one,
    cwd: "",
    argv: ["bun", "test"],
    timeout_ms: 120000,
    state: "succeeded",
    created_at: 0,
    started_at: 1,
    ended_at: 2,
    expires_at: 100,
    exit_code: 0,
    signal: null,
    message: null,
  },
  stdout: "passed",
  stderr: "",
  stdout_cursor: 6,
  stderr_cursor: 0,
  stdout_truncated: false,
  stderr_truncated: false,
  has_more: false,
  output_complete: true,
};

test("exit zero is evidence only after final output has been drained without omissions", () => {
  expect(commandEvidence(result)).toBe(true);
  for (const next of [
    { ...result, has_more: true },
    { ...result, output_complete: false },
    { ...result, stdout_truncated: true },
    { ...result, stderr_truncated: true },
    { ...result, command: { ...result.command, exit_code: 1, state: "failed" as const } },
  ])
    expect(commandEvidence(next)).toBe(false);
  expect(commandEvidence(result, true)).toBe(false);
  expect(outputEvidence({ ...result, has_more: true })).toBe("輸出尚未讀完");
  expect(outputEvidence({ ...result, stdout_truncated: true })).toBe("輸出部分保留");
  expect(outputEvidence(result, true)).toBe("輸出待確認");
  const html = renderToStaticMarkup(<CommandOutput result={result} error="" />);
  expect(html).toContain("執行時結果");
  expect(html).not.toContain("目前版本通過");
});
