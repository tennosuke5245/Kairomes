import type { WorkbenchBridge } from "../apps/widget/src/bridge.ts";
import { ResultError } from "../apps/widget/src/tool-result.ts";
import type {
  ActivitySnapshot,
  Artifact,
  CommandResult,
  FileChangeResult,
  FileResult,
  TerminalResult,
  TerminalSession,
  ToolData,
  Workspace,
} from "../packages/protocol/src/index.ts";
import { VERSION } from "../packages/protocol/src/index.ts";
import { studyWorkspaces } from "./study-fixture-data.ts";
import { StudyWidgetController } from "./study-widget-state.ts";

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
  total_lines: 1,
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
    document.querySelector<HTMLSelectElement>('select[aria-label="選擇終端機"]')?.value ||
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
                ...snapshot.entries[0],
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
        return structuredClone(artifactFixture ? artifact : file);
      },
    },
    async connect() {},
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
    async sendMessage() {
      throw new Error("合成測試沒有聊天宿主");
    },
    async askAbout() {
      throw new Error("合成測試沒有聊天宿主");
    },
    async call(name, args = {}): Promise<ToolData> {
      if (closed) throw new Error("合成測試已結束。");
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
          document.querySelector(".terminal-panel")
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
