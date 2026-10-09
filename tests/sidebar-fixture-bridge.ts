import type { WorkbenchBridge } from "../apps/widget/src/bridge.ts";
import { ResultError } from "../apps/widget/src/tool-result.ts";
import type {
  ActivitySnapshot,
  Artifact,
  ArtifactImport,
  Command,
  CommandResult,
  FileChange,
  FileChangeResult,
  FileResult,
  McpCall,
  TerminalResult,
  TerminalSession,
  ToolData,
  Workspace,
} from "../packages/protocol/src/index.ts";
import { commandLabels, VERSION } from "../packages/protocol/src/index.ts";
import { studyWorkspaces } from "./study-fixture-data.ts";
import { StudyWidgetController } from "./study-widget-state.ts";
import {
  changeDiff,
  commandOutput,
  fileContent,
  folder,
  searchMatches,
} from "./workbench-fixture-content.ts";

// Pure UI fixture: no credentials, real filesystem, tool execution or ChatGPT host.
const studyFixture = new URLSearchParams(location.search).get("study") === "1";
const workspace: Workspace = {
  id: "00000000-0000-4000-8000-000000000010",
  name: studyFixture ? studyWorkspaces[0].name : "側欄測試專案（長名稱與範圍驗收）",
  capabilities: ["read", "write_request"],
};
const second: Workspace = {
  ...workspace,
  id: "00000000-0000-4000-8000-000000000020",
  name: studyFixture ? studyWorkspaces[1].name : "第二個專案",
};
const file: FileResult = {
  kind: "file",
  workspace_id: workspace.id,
  path: "src/main.ts",
  content: 'export const message = "Kairomes";\n',
  version: "1".repeat(64),
  start_line: 1,
  // As the daemon reports it: the final newline counts as a second, empty line.
  total_lines: 2,
  next_line: null,
  truncated: false,
  redacted: false,
};
const artifact: Artifact = {
  kind: "artifact",
  artifact_id: "3".repeat(64),
  workspace_id: workspace.id,
  path: "output/preview.png",
  media_kind: "image",
  mime_type: "image/png",
  byte_size: 10000,
  width: 128,
  height: 128,
  version: "1".repeat(64),
  modified_at: 0,
  previewable: true,
};
let snapshot: ActivitySnapshot = {
  instanceId: "sidebar-visual-fixture",
  seq: 3,
  workspaces: [workspace, second],
  sessions: [],
  commands: [],
  changes: [],
  imports: [],
  entries: [
    {
      id: "read-3",
      seq: 3,
      focusSeq: 3,
      source: "mcp",
      kind: "tool",
      title: "讀取 src/main.ts",
      state: "completed",
      updatedAt: Date.now(),
      tool: "file_read",
      workspaceId: workspace.id,
      path: file.path,
      resultId: "result-3",
    },
    {
      id: "read-2",
      seq: 2,
      focusSeq: 2,
      source: "mcp",
      kind: "tool",
      title: "查看第二個專案",
      state: "completed",
      updatedAt: Date.now() - 5000,
      tool: "workspace_snapshot",
      workspaceId: second.id,
    },
    {
      id: "read-1",
      seq: 1,
      focusSeq: 1,
      source: "mcp",
      kind: "tool",
      title: "列出工作區",
      state: "completed",
      updatedAt: Date.now() - 10000,
      tool: "workspace_list",
    },
  ],
};

const terminalFixture =
  location.pathname === "/terminal" || new URLSearchParams(location.search).has("terminal");
const artifactFixture = new URLSearchParams(location.search).has("artifact") || studyFixture;
const commandFixture = new URLSearchParams(location.search).get("command") === "1" || studyFixture;
const primaryCommandId = "00000003-0000-4000-8000-000000000010";
const commandResultId = "command-result-1";
const command: CommandResult = {
  kind: "command",
  command: {
    id: primaryCommandId,
    request_id: "00000004-0000-4000-8000-000000000010",
    workspace_id: workspace.id,
    cwd: "src",
    argv: ["synthetic-check", "--preview"],
    timeout_ms: 1000,
    state: "succeeded",
    created_at: 1,
    started_at: 2,
    ended_at: 3,
    expires_at: 100,
    exit_code: 0,
    signal: null,
    message: null,
  },
  stdout: "合成命令輸出。\n",
  stderr: "合成診斷：此行僅供錯誤輸出對比檢查。\n",
  stdout_cursor: "合成命令輸出。\n".length,
  stderr_cursor: "合成診斷：此行僅供錯誤輸出對比檢查。\n".length,
  stdout_truncated: true,
  stderr_truncated: false,
  has_more: false,
  output_complete: true,
};
const studyFile: FileResult = {
  ...file,
  content: 'export const message = "Kairomes 喵";\n',
  version: "2".repeat(64),
};
const studyCommand: CommandResult = {
  ...command,
  stdout: "合成檢查已結束。\n",
  stderr: "",
  stdout_cursor: "合成檢查已結束。\n".length,
  stderr_cursor: 0,
  stdout_truncated: false,
};
const studyChange: FileChangeResult = {
  kind: "file_change",
  change: {
    id: "00000008-0000-4000-8000-000000000010",
    request_id: "00000009-0000-4000-8000-000000000010",
    workspace_id: workspace.id,
    summary: "調整合成歡迎訊息",
    state: "applied",
    created_at: 1,
    applied_at: 2,
    expires_at: 100,
    message: null,
    files: [
      {
        operation: "edit",
        path: file.path,
        before_version: file.version,
        after_version: studyFile.version,
      },
    ],
  },
  diff: [
    "--- a/src/main.ts",
    "+++ b/src/main.ts",
    "@@ exact replacement @@",
    '-export const message = "Kairomes";',
    '+export const message = "Kairomes 喵";',
  ].join("\n"),
  diff_truncated: false,
};
// ?imports=1: image imports in the timeline (waiting for the image, written, uncertain).
const importsFixture = new URLSearchParams(location.search).get("imports") === "1";
if (importsFixture) {
  const base = (id: string, patch: Partial<ArtifactImport>): ArtifactImport => ({
    id,
    request_id: id.replace(/^1/, "2"),
    workspace_id: workspace.id,
    path: "design/placeholders/figure-default.png",
    summary: "合成圖片匯入",
    source_file_id: null,
    source_file_name: null,
    claimed_mime_type: null,
    mime_type: null,
    byte_size: null,
    width: null,
    height: null,
    version: null,
    state: "awaiting_file",
    write_outcome: "not_written",
    created_at: Date.now() - 20_000,
    applied_at: null,
    expires_at: Date.now() + 9 * 60_000,
    error_code: null,
    message: null,
    artifact: null,
    ...patch,
  });
  const waiting = base("10000001-0000-4000-8000-0000000000dd", {});
  const written = base("10000002-0000-4000-8000-0000000000dd", {
    path: artifact.path,
    state: "applied",
    write_outcome: "written_verified",
    mime_type: "image/png",
    byte_size: artifact.byte_size,
    width: artifact.width,
    height: artifact.height,
    version: artifact.version,
    applied_at: Date.now() - 60_000,
    artifact: { ...artifact },
  });
  const unknown = base("10000003-0000-4000-8000-0000000000dd", {
    path: "design/banner.png",
    state: "failed",
    write_outcome: "unknown",
    error_code: "WRITE_UNVERIFIED",
    message: "寫入後無法確認檔案內容，請先檢查目的檔案。",
  });
  const entry = (item: ArtifactImport, seq: number, label: string) => ({
    id: `import-${seq}`,
    seq,
    focusSeq: seq,
    source: "mcp" as const,
    kind: "artifact_import" as const,
    tool: "artifact_import_request" as const,
    title: `匯入圖片 · ${label}`,
    state: item.state,
    writeOutcome: item.write_outcome,
    updatedAt: Date.now() - (12 - seq) * 30_000,
    workspaceId: workspace.id,
    path: item.path,
    importId: item.id,
    ...(item.message ? { message: item.message } : {}),
    ...(item.state === "applied" ? { resultId: "import-result" } : {}),
  });
  snapshot = {
    ...snapshot,
    seq: 12,
    imports: [waiting, written, unknown],
    entries: [
      entry(waiting, 12, "等待圖片"),
      entry(unknown, 11, "結果待確認"),
      entry(written, 10, "已匯入"),
      ...snapshot.entries,
    ],
  };
}
if (artifactFixture && snapshot.entries[0]) {
  snapshot.entries[0] = {
    ...snapshot.entries[0],
    title: "預覽 output/preview.png",
    tool: "artifact_preview",
    path: artifact.path,
  };
}
const primaryTerminalId = "00000001-0000-4000-8000-000000000010";
const secondaryTerminalId = "00000002-0000-4000-8000-000000000010";
const terminalText = Array.from(
  { length: 240 },
  (_, index) => `第 ${index + 1} 行：純合成終端輸出；沒有主機程序。\n`,
).join("");
if (terminalFixture) {
  const primary: TerminalSession = {
    id: primaryTerminalId,
    workspace_id: workspace.id,
    cwd: "",
    shell: "powershell",
    mode: "host-pty",
    state: "running",
    created_at: Date.now(),
    expires_at: Date.now() + 15 * 60 * 1000,
    cols: 100,
    rows: 28,
    exit_code: null,
  };
  snapshot = {
    ...snapshot,
    seq: 5,
    sessions: [primary, { ...primary, id: secondaryTerminalId, shell: "cmd" }],
    entries: [
      ...[primaryTerminalId, secondaryTerminalId].map((id, index) => ({
        id: `terminal-${index + 1}`,
        seq: 5 - index,
        focusSeq: 5 - index,
        source: "mcp" as const,
        kind: "terminal" as const,
        sessionId: id,
        workspaceId: workspace.id,
        title: index === 0 ? "主要合成終端機" : "另一個合成終端機",
        state: "running" as const,
        updatedAt: Date.now(),
      })),
      ...snapshot.entries,
    ],
  };
}
if (commandFixture) {
  const seq = snapshot.seq + 1;
  snapshot = {
    ...snapshot,
    seq,
    commands: [command.command],
    entries: [
      {
        id: "command-1",
        seq,
        focusSeq: seq,
        source: "mcp",
        kind: "command",
        commandId: primaryCommandId,
        resultId: commandResultId,
        workspaceId: workspace.id,
        title: "合成命令成果",
        state: command.command.state,
        updatedAt: Date.now(),
      },
      ...snapshot.entries,
    ],
  };
}
if (studyFixture) {
  snapshot = {
    ...snapshot,
    seq: 6,
    sessions: [],
    commands: [studyCommand.command],
    changes: [studyChange.change],
    entries: [
      {
        id: "study-image",
        seq: 6,
        focusSeq: 6,
        source: "mcp",
        kind: "tool",
        title: "預覽 output/preview.png",
        state: "completed",
        updatedAt: 6,
        tool: "artifact_preview",
        workspaceId: workspace.id,
        path: artifact.path,
        resultId: "study-image-result",
      },
      {
        id: "study-command",
        seq: 5,
        focusSeq: 5,
        source: "mcp",
        kind: "command",
        title: "合成檢查已結束",
        state: "succeeded",
        updatedAt: 5,
        commandId: primaryCommandId,
        workspaceId: workspace.id,
        resultId: commandResultId,
      },
      {
        id: "study-diff",
        seq: 4,
        focusSeq: 4,
        source: "mcp",
        kind: "file_change",
        title: studyChange.change.summary,
        state: "applied",
        updatedAt: 4,
        changeId: studyChange.change.id,
        workspaceId: workspace.id,
        resultId: "study-diff-result",
      },
      {
        id: "study-file",
        seq: 3,
        focusSeq: 3,
        source: "mcp",
        kind: "tool",
        title: "讀取 src/main.ts",
        state: "completed",
        updatedAt: 3,
        tool: "file_read",
        workspaceId: workspace.id,
        path: file.path,
        resultId: "study-file-result",
      },
      ...snapshot.entries.filter((entry) => entry.id === "read-2" || entry.id === "read-1"),
    ],
  };
}
// ?timeline=1: a dense, synthetic timeline (every state, three time groups, paging) for
// visual checks of the workbench list. Commands and changes are records only; nothing runs.
const timelineFixture = new URLSearchParams(location.search).get("timeline") === "1";
if (timelineFixture) {
  const now = Date.now();
  const minute = 60_000;
  const today = (hour: number, minutes: number) => {
    const at = new Date(now);
    at.setHours(hour, minutes, 0, 0);
    // Keep "today" rows inside today but older than the 剛剛 window, whatever the clock says.
    return Math.min(at.getTime(), now - 20 * minute);
  };
  const id = (index: number) => `00000010-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const record = (
    index: number,
    argv: string[],
    state: Command["state"],
    times: Partial<Command>,
  ) =>
    ({
      id: id(index),
      request_id: id(index + 100),
      workspace_id: workspace.id,
      cwd: "",
      argv,
      timeout_ms: 120_000,
      state,
      created_at: now - 3 * minute,
      started_at: null,
      ended_at: null,
      expires_at: now + 5 * minute,
      exit_code: null,
      signal: null,
      message: null,
      ...times,
    }) satisfies Command;
  const commands = [
    record(1, ["bun", "test"], "running", { started_at: now - 14_000 }),
    record(2, ["bun", "run", "check"], "pending", { expires_at: now + 252_000 }),
    record(3, ["bun", "test", "--filter", "render"], "failed", {
      started_at: today(15, 12) - 4_200,
      ended_at: today(15, 12),
      exit_code: 1,
      message: "1 個測試未通過",
    }),
    record(4, ["bun", "run", "lint"], "succeeded", {
      started_at: today(14, 41) - 1_800,
      ended_at: today(14, 41),
      exit_code: 0,
    }),
    record(5, ["rm", "-rf", "dist"], "denied", { workspace_id: second.id }),
  ];
  const change = (index: number, summary: string, state: FileChange["state"], files: string[]) =>
    ({
      id: id(index),
      request_id: id(index + 100),
      workspace_id: index === 7 ? second.id : workspace.id,
      summary,
      state,
      created_at: now - 2 * minute,
      applied_at: null,
      expires_at: now + 580_000,
      message: null,
      files: files.map((path) => ({
        operation: "edit" as const,
        path,
        before_version: null,
        after_version: null,
      })),
    }) satisfies FileChange;
  const changes = [
    change(6, "修改 2 個檔案", "pending", ["src/main.ts", "src/view.ts"]),
    change(7, "套用 3 個檔案", "conflict", ["docs/a.md", "docs/b.md", "docs/c.md"]),
  ];
  const session: TerminalSession = {
    id: id(8),
    workspace_id: second.id,
    cwd: "",
    shell: "powershell",
    mode: "host-pty",
    state: "exited",
    created_at: today(13, 5) - 6 * minute,
    expires_at: 0,
    cols: 80,
    rows: 24,
    exit_code: 0,
  };
  type Entry = ActivitySnapshot["entries"][number];
  const entry = (seq: number, value: Partial<Entry>): Entry => ({
    id: `timeline-${seq}`,
    seq,
    focusSeq: seq,
    source: "mcp",
    kind: "tool",
    title: "讀取檔案",
    state: "completed",
    updatedAt: now,
    workspaceId: workspace.id,
    ...value,
  });
  const commandEntry = (seq: number, command: Command, updatedAt: number) =>
    entry(seq, {
      kind: "command",
      commandId: command.id,
      workspaceId: command.workspace_id,
      title: `${command.argv[0]} · ${commandLabels[command.state]}`,
      state: command.state,
      updatedAt,
      message: command.message ?? undefined,
    });
  const older = Array.from({ length: 48 }, (_, index) =>
    entry(80 - index, {
      id: `timeline-old-${index}`,
      tool: "file_read",
      path: `src/module-${String(index + 1).padStart(2, "0")}.ts`,
      resultId: `result-old-${index}`,
      updatedAt: now - (26 + index) * 60 * minute,
      workspaceId: index % 3 ? workspace.id : second.id,
    }),
  );
  snapshot = {
    ...snapshot,
    seq: 100,
    commands,
    changes,
    sessions: [session],
    entries: [
      commandEntry(99, commands[0] as Command, now - 30_000),
      commandEntry(98, commands[1] as Command, now - 60_000),
      entry(97, {
        kind: "file_change",
        changeId: changes[0]?.id,
        title: "修改 2 個檔案 · 等待核准",
        state: "pending",
        updatedAt: now - 70_000,
      }),
      entry(96, {
        id: "read-3",
        tool: "file_read",
        path: "src/main.ts",
        resultId: "result-3",
        updatedAt: now - 2 * minute,
      }),
      commandEntry(95, commands[2] as Command, today(15, 12)),
      entry(94, {
        kind: "file_change",
        changeId: changes[1]?.id,
        workspaceId: second.id,
        title: "套用 3 個檔案 · 檔案已變更",
        state: "conflict",
        updatedAt: today(14, 58),
      }),
      commandEntry(93, commands[3] as Command, today(14, 41)),
      commandEntry(92, commands[4] as Command, today(14, 20)),
      entry(91, {
        kind: "terminal",
        sessionId: session.id,
        workspaceId: second.id,
        title: "powershell · 已結束",
        state: "exited",
        updatedAt: today(13, 5),
      }),
      entry(90, {
        tool: "mcp_tool_call",
        title: "github · search_issues",
        workspaceId: undefined,
        state: "failed",
        message: "遠端工具回報錯誤：查詢逾時。",
        resultId: "result-mcp",
        updatedAt: today(12, 30),
      }),
      entry(89, {
        id: "search-approval",
        tool: "file_search",
        title: "搜尋「approval」",
        resultId: "result-search",
        updatedAt: today(12, 20),
      }),
      ...older,
    ],
  };
}
// The timeline's github · search_issues row: a failed downstream MCP call, so the preview shows
// the 呼叫參數 and 結構化結果 disclosures instead of falling back to the file fixture.
const mcpCallFixture: McpCall = {
  kind: "mcp_call",
  request_id: "00000010-0000-4000-8000-000000000090",
  catalog_revision: "fixture-1",
  tool: {
    ref: "github.search_issues",
    server_id: "00000010-0000-4000-8000-000000000091",
    server_name: "github",
    name: "search_issues",
  },
  is_error: true,
  arguments_preview: { query: "label:bug is:open", per_page: 20 },
  duration_ms: 30_012,
  content: [{ type: "text", text: "遠端工具回報錯誤：查詢逾時。" }],
  structured_content: { error: { code: "timeout", retry_after: 30 } },
  truncated: false,
};
const studyBaseline = structuredClone(snapshot);

export function createBridge(): WorkbenchBridge {
  let closed = false;
  let failNextRead = false;
  const study = new StudyWidgetController();
  let fileChanged = false,
    imageChanged = false;
  let studyTimer: ReturnType<typeof setTimeout> | undefined;
  const studyAbort = new AbortController();
  const studyResults = new Map<string, FileResult>();
  const currentFile = () =>
    studyFixture
      ? {
          ...studyFile,
          ...(fileChanged
            ? { content: 'export const message = "Kairomes 新版";\n', version: "5".repeat(64) }
            : {}),
        }
      : file;
  let delayedOnce = false;
  const receivers = new Set<(value: ActivitySnapshot) => void>();
  const watchCleanups = new Set<() => void>();
  const counts = { polls: 0, input: 0, resize: 0, start: 0, stop: 0, lateReplies: 0, timeouts: 0 };
  let held: { id: string; release: (late?: boolean) => void; cancel: () => void } | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const selectedTerminalId = () =>
    document.querySelector<HTMLElement>(".wb-terminal[data-terminal-id]")?.dataset.terminalId ||
    primaryTerminalId;
  const observe = () => {
    const probe = document.querySelector<HTMLOutputElement>("#terminal-fixture-probe");
    if (!probe) return;
    probe.textContent = `輪詢 ${counts.polls} · 延遲 ${held ? 1 : 0} · 舊回應 ${counts.lateReplies} · no-op ${counts.input + counts.resize + counts.start + counts.stop}`;
    for (const [key, value] of Object.entries(counts)) probe.dataset[key] = String(value);
    probe.dataset.delayed = held ? "1" : "0";
    probe.dataset.sessions = String(snapshot.sessions.length);
    probe.dataset.outputLength = String(terminalText.length);
  };
  const emit = () => {
    for (const receive of receivers) receive(structuredClone(snapshot));
    observe();
  };
  const pollStudy = async () => {
    if (!studyFixture || closed) return;
    try {
      const response = await fetch("/synthetic-study/widget-state", {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([studyAbort.signal, AbortSignal.timeout(3000)]),
      });
      if (!response.ok || closed) return;
      const accepted = study.receive(await response.json());
      if (!accepted || closed) return;
      const { state, reset, events } = accepted;
      fileChanged = state.fileChanged;
      imageChanged = state.imageChanged;
      if (reset) {
        snapshot = structuredClone(studyBaseline);
        snapshot.instanceId = `sidebar-study-${state.revision}`;
        studyResults.clear();
        failNextRead = false;
      }
      snapshot = {
        ...snapshot,
        workspaces: state.unmounted ? [second] : [workspace, second],
      };
      for (let index = Math.max(0, events - 24); index < events; index++) {
        const event = state.eventCount - events + index + 1;
        const resultId = `study-event-result-${event}`;
        const seq = snapshot.seq + 1;
        studyResults.set(resultId, structuredClone(currentFile()));
        snapshot = {
          ...snapshot,
          seq,
          entries: [
            {
              id: `study-event-${event}`,
              seq,
              focusSeq: seq,
              source: "mcp",
              kind: "tool",
              title: `讀取 ${file.path}`,
              state: "completed",
              updatedAt: Date.now(),
              tool: "file_read",
              workspaceId: workspace.id,
              path: file.path,
              resultId,
            } satisfies ActivitySnapshot["entries"][number],
            ...snapshot.entries,
          ].slice(0, 30),
        };
      }
      for (const id of studyResults.keys())
        if (!snapshot.entries.some((entry) => entry.resultId === id)) studyResults.delete(id);
      document.documentElement.dataset.studyRevision = String(state.revision);
      emit();
    } catch {
      // An invalid/late operator reply leaves the last fixed sample intact.
    } finally {
      if (!closed) studyTimer = setTimeout(() => void pollStudy(), 500);
    }
  };
  const terminalResult = (id: string, cursor = 0): TerminalResult => {
    const session = snapshot.sessions.find((item) => item.id === id);
    if (!session) throw new ResultError("合成終端機已移除。", "TERMINAL_NOT_FOUND");
    const text = cursor === 0 ? terminalText : "";
    return {
      kind: "terminal",
      session: structuredClone(session),
      output: text.replaceAll("\n", "\r\n"),
      text,
      cursor: terminalText.length,
      truncated: cursor === 0,
      has_more: false,
    };
  };
  const stopTerminal = () => {
    const id = selectedTerminalId();
    snapshot = {
      ...snapshot,
      seq: snapshot.seq + 1,
      sessions: snapshot.sessions.map((session) =>
        session.id === id ? { ...session, state: "stopped" as const } : session,
      ),
      entries: snapshot.entries.map((entry) =>
        entry.sessionId === id ? { ...entry, state: "stopped", seq: snapshot.seq + 1 } : entry,
      ),
    };
    // Deliver the live terminal state first; React gets a commit before the old poll resolves.
    emit();
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (!closed && held?.id === id) held.release(true);
      releaseTimer = undefined;
    }, 150);
  };
  const removeTerminal = () => {
    const id = selectedTerminalId();
    snapshot = {
      ...snapshot,
      seq: snapshot.seq + 1,
      sessions: snapshot.sessions.filter((session) => session.id !== id),
    };
    emit();
    if (held?.id === id) held.release(true);
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    clearTimeout(studyTimer);
    studyAbort.abort();
    clearTimeout(releaseTimer);
    held?.cancel();
    for (const cleanup of [...watchCleanups]) cleanup();
    window.removeEventListener("pagehide", dispose);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  observe();
  if (studyFixture) void pollStudy();
  return {
    mode: "workbench",
    activity: {
      async watch(receive, signal) {
        if (closed || signal.aborted) return;
        receivers.add(receive);
        receive(structuredClone(snapshot));
        const add = () => {
          const seq = snapshot.seq + 1;
          snapshot = {
            ...snapshot,
            seq,
            entries: [
              {
                // The newest file read is the template, so every fixture adds a visible read.
                ...(snapshot.entries.find((item) => item.tool === "file_read") ??
                  snapshot.entries[0]),
                id: `read-${seq}`,
                resultId: `result-${seq}`,
                seq,
                focusSeq: seq,
                title: `新活動 ${seq}`,
                updatedAt: Date.now(),
                source: "mcp",
                kind: "tool",
                state: "completed",
              },
              ...snapshot.entries,
            ],
          };
          emit();
        };
        const control = document.querySelector<HTMLButtonElement>("#fixture-new-event");
        const unmountControl = document.querySelector<HTMLButtonElement>("#fixture-unmount");
        const failReadControl = document.querySelector<HTMLButtonElement>("#fixture-fail-read");
        const failRead = () => {
          failNextRead = true;
        };
        const unmount = () => {
          snapshot = {
            ...snapshot,
            seq: snapshot.seq + 1,
            workspaces: snapshot.workspaces?.filter((item) => item.id !== workspace.id),
          };
          emit();
        };
        const stopControl = document.querySelector<HTMLButtonElement>("#fixture-terminal-stop");
        const removeControl = document.querySelector<HTMLButtonElement>("#fixture-terminal-remove");
        control?.addEventListener("click", add);
        unmountControl?.addEventListener("click", unmount);
        failReadControl?.addEventListener("click", failRead);
        stopControl?.addEventListener("click", stopTerminal);
        removeControl?.addEventListener("click", removeTerminal);
        await new Promise<void>((resolve) => {
          const cleanup = () => {
            signal.removeEventListener("abort", cleanup);
            control?.removeEventListener("click", add);
            unmountControl?.removeEventListener("click", unmount);
            failReadControl?.removeEventListener("click", failRead);
            stopControl?.removeEventListener("click", stopTerminal);
            removeControl?.removeEventListener("click", removeTerminal);
            receivers.delete(receive);
            watchCleanups.delete(cleanup);
            if (!receivers.size) {
              clearTimeout(releaseTimer);
              held?.cancel();
            }
            resolve();
          };
          watchCleanups.add(cleanup);
          signal.addEventListener("abort", cleanup, { once: true });
          if (closed || signal.aborted) cleanup();
        });
      },
      async result(id) {
        if (new URLSearchParams(location.search).has("delay") && id === "result-4") {
          await new Promise<void>((resolve) => setTimeout(resolve, 5000));
        }
        if (new URLSearchParams(location.search).has("expired")) {
          throw new ResultError("詳情已到期", "RESULT_EXPIRED");
        }
        if (studyFixture) {
          if (id === "study-image-result") return structuredClone(artifact);
          if (id === "study-file-result") return structuredClone(studyFile);
          if (id === "study-diff-result") return structuredClone(studyChange);
          const observed = studyResults.get(id);
          if (observed) return structuredClone(observed);
          if (id.startsWith("study-event-result-"))
            throw new ResultError("合成歷史成果已到期。", "RESULT_EXPIRED");
        }
        if (commandFixture && id === commandResultId)
          return structuredClone(studyFixture ? studyCommand : command);
        if (timelineFixture && id === "result-mcp") return structuredClone(mcpCallFixture);
        if (timelineFixture && id === "result-search")
          return {
            kind: "search",
            workspace_id: workspace.id,
            query: "approval",
            case_sensitive: false,
            matches: searchMatches("approval", false),
            truncated: false,
            scanned_files: 6,
            skipped_files: 0,
          };
        if (importsFixture && id === "import-result") return structuredClone(artifact);
        return structuredClone(artifactFixture ? artifact : file);
      },
    },
    async connect() {
      // ?connect=hold|fail shows the loading and error shells (no host, nothing is contacted).
      const mode = new URLSearchParams(location.search).get("connect");
      if (mode === "fail") throw new Error("請使用終端機輸出的完整預覽網址開啟本頁。");
      if (mode === "hold") await new Promise<never>(() => {});
    },
    async close() {
      dispose();
    },
    async fullscreen() {},
    async loadArtifact(value) {
      if (
        studyFixture
          ? value.version !== (imageChanged ? "2".repeat(64) : artifact.version)
          : value.version === artifact.version
      )
        throw new ResultError("圖片版本已更新。", "ARTIFACT_VERSION_CHANGED");
      const response = await fetch("/kairomes-k-128.png");
      return URL.createObjectURL(await response.blob());
    },
    async askAbout() {
      throw new Error("合成測試沒有聊天宿主");
    },
    async call(name, args = {}): Promise<ToolData> {
      if (closed) throw new Error("合成測試已結束。");
      if (timelineFixture) {
        // Dense synthetic content for the workbench preview; nothing touches a disk or a host.
        if (name === "workspace_snapshot") {
          const path = String(args.path ?? "");
          return {
            kind: "snapshot",
            workspace: args.workspace_id === second.id ? second : workspace,
            path,
            entries: folder(path),
            truncated: false,
          };
        }
        if (name === "file_read") {
          const lines = Number(args.max_lines ?? 150);
          const page = fileContent(String(args.path), Number(args.start_line ?? 1), lines);
          return {
            ...file,
            ...page,
            workspace_id: String(args.workspace_id),
            path: String(args.path),
            next_line: page.start_line + lines <= page.total_lines ? page.start_line + lines : null,
          };
        }
        if (name === "artifact_preview")
          return { ...artifact, workspace_id: String(args.workspace_id), path: String(args.path) };
        if (name === "file_search") {
          const caseSensitive = args.case_sensitive === true;
          return {
            kind: "search",
            workspace_id: String(args.workspace_id),
            query: String(args.query ?? ""),
            case_sensitive: caseSensitive,
            matches: searchMatches(String(args.query ?? ""), caseSensitive),
            truncated: false,
            scanned_files: 6,
            skipped_files: 0,
          };
        }
        if (name === "command_poll") {
          const found = snapshot.commands?.find((item) => item.id === args.command_id);
          if (!found) throw new ResultError("合成命令不存在。", "COMMAND_NOT_FOUND");
          const output = commandOutput(found);
          const out = Number(args.stdout_cursor ?? 0);
          const err = Number(args.stderr_cursor ?? 0);
          const active = ["pending", "starting", "running"].includes(found.state);
          return {
            kind: "command",
            command: structuredClone(found),
            stdout: output.stdout.slice(out),
            stderr: output.stderr.slice(err),
            stdout_cursor: output.stdout.length,
            stderr_cursor: output.stderr.length,
            stdout_truncated: false,
            stderr_truncated: false,
            has_more: false,
            output_complete: !active,
          };
        }
        if (name === "file_change_poll") {
          const found = snapshot.changes?.find((item) => item.id === args.change_id);
          if (!found) throw new ResultError("合成變更不存在。", "FILE_CHANGE_NOT_FOUND");
          return {
            kind: "file_change",
            change: structuredClone(found),
            diff: changeDiff(found),
            diff_truncated: false,
          };
        }
      }
      if (name === "workspace_list")
        return {
          kind: "workspaces",
          workspaces: studyFixture
            ? structuredClone(snapshot.workspaces ?? [])
            : [workspace, second],
        };
      if (name === "kairomes_status")
        return {
          kind: "status",
          version: VERSION,
          runtime: "fixture",
          platform: "win32",
          mounted_workspaces: 2,
          widget_available: true,
          capabilities: {
            read: true,
            write: true,
            terminal: true,
            command: true,
            mcp_mount: true,
            artifact: true,
          },
        };
      if (name === "mcp_catalog_search")
        return {
          kind: "mcp_catalog",
          catalog_revision: "fixture",
          servers: [],
          tools: [],
          truncated: false,
        };
      if (name === "workspace_snapshot")
        return {
          kind: "snapshot",
          workspace: args.workspace_id === second.id ? second : workspace,
          path: "",
          entries: [
            { name: "src", path: "src", kind: "directory" },
            { name: "README.md", path: "README.md", kind: "file" },
            { name: "main.ts", path: "src/main.ts", kind: "file" },
          ],
          truncated: false,
        };
      if (name === "file_read") {
        if (failNextRead || (studyFixture && study.consumeFailure())) {
          failNextRead = false;
          throw new ResultError("合成讀取失敗。", "FILE_NOT_FOUND");
        }
        const selected = snapshot.workspaces?.find((item) => item.id === args.workspace_id);
        if (!selected) throw new ResultError("合成專案已解除掛載。", "WORKSPACE_NOT_FOUND");
        return {
          ...currentFile(),
          workspace_id: selected.id,
          path: typeof args.path === "string" ? args.path : file.path,
        };
      }
      if (artifactFixture && name === "artifact_preview") {
        const selected = snapshot.workspaces?.find((item) => item.id === args.workspace_id);
        if (!selected) throw new ResultError("合成專案已解除掛載。", "WORKSPACE_NOT_FOUND");
        return {
          ...artifact,
          artifact_id: "4".repeat(64),
          version: studyFixture && !imageChanged ? artifact.version : "2".repeat(64),
          workspace_id: selected.id,
          path: String(args.path),
        };
      }
      if (name === "file_search")
        return {
          kind: "search",
          workspace_id: workspace.id,
          query: String(args.query ?? ""),
          matches: [{ path: file.path, line: 1, text: file.content }],
          truncated: false,
          scanned_files: 2,
          skipped_files: 0,
        };
      if (name === "terminal_list")
        return { kind: "terminals", sessions: structuredClone(snapshot.sessions) };
      if (terminalFixture && name === "terminal_poll") {
        counts.polls++;
        const id = String(args.session_id);
        const result = terminalResult(id, Number(args.cursor ?? 0));
        if (
          id === primaryTerminalId &&
          result.session.state === "running" &&
          !delayedOnce &&
          document.querySelector(".wb-terminal")
        ) {
          delayedOnce = true;
          return new Promise<TerminalResult>((resolve, reject) => {
            const finish = (late = false, cancelled = false) => {
              clearTimeout(timeout);
              held = undefined;
              if (late) counts.lateReplies++;
              observe();
              if (cancelled) reject(new Error("合成輪詢已取消。"));
              else resolve(result);
            };
            const timeout = setTimeout(() => {
              counts.timeouts++;
              finish();
            }, 30000);
            held = { id, release: (late) => finish(late), cancel: () => finish(false, true) };
            observe();
          });
        }
        observe();
        return result;
      }
      if (
        terminalFixture &&
        ["terminal_input", "terminal_resize", "terminal_start", "terminal_stop"].includes(name)
      ) {
        if (name === "terminal_input") counts.input++;
        if (name === "terminal_resize") counts.resize++;
        if (name === "terminal_start") counts.start++;
        if (name === "terminal_stop") counts.stop++;
        observe();
        // Count the requested action only: never start a process, resize a host or store input.
        return terminalResult(
          typeof args.session_id === "string" ? args.session_id : primaryTerminalId,
          terminalText.length,
        );
      }
      if (name === "command_list")
        return { kind: "commands", commands: structuredClone(snapshot.commands ?? []) };
      if (commandFixture && name === "command_poll") {
        if (args.command_id !== primaryCommandId)
          throw new ResultError("合成命令不存在。", "COMMAND_NOT_FOUND");
        const out = Number(args.stdout_cursor ?? 0);
        const err = Number(args.stderr_cursor ?? 0);
        if (!Number.isSafeInteger(out) || out < 0 || !Number.isSafeInteger(err) || err < 0)
          throw new ResultError("合成命令游標無效。", "INVALID_ARGUMENTS");
        return {
          ...structuredClone(studyFixture ? studyCommand : command),
          stdout: (studyFixture ? studyCommand : command).stdout.slice(out),
          stderr: (studyFixture ? studyCommand : command).stderr.slice(err),
          stdout_truncated: !studyFixture && out === 0,
        };
      }
      if (studyFixture && name === "file_change_poll") {
        if (args.change_id !== studyChange.change.id)
          throw new ResultError("合成變更不存在。", "CHANGE_NOT_FOUND");
        return structuredClone(studyChange);
      }
      if (name === "file_change_list")
        return { kind: "file_changes", changes: structuredClone(snapshot.changes ?? []) };
      throw new Error("合成測試未提供此動作");
    },
  };
}
