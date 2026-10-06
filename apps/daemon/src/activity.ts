import {
  type ActivityEntry,
  type ActivitySource,
  type Artifact,
  type ArtifactImport,
  artifactImportLabels,
  type Command,
  commandLabels,
  type FileChange,
  fileChangeLabels,
  KairomesError,
  type TerminalSession,
  type ToolData,
  type ToolName,
  terminalLabels,
} from "@kairomes/protocol";

const tracked = new Set<ToolName>([
  "artifact_preview",
  "file_read",
  "file_search",
  "workspace_snapshot",
  "workspace_list",
  "mcp_tool_call",
  "mcp_read_call",
  "git_status",
  "git_diff",
  "git_log",
]);
const titles = {
  artifact_preview: "預覽圖片",
  file_read: "讀取檔案",
  file_search: "搜尋內容",
  workspace_snapshot: "瀏覽資料夾",
  workspace_list: "列出工作區",
  mcp_tool_call: "呼叫 MCP 工具",
  mcp_read_call: "呼叫 MCP 工具",
  git_status: "查看 Git 狀態",
  git_diff: "查看 Git 差異",
  git_log: "查看 Git 紀錄",
};

/** Instance-local, bounded observation. Reading never creates another activity. */
export class ActivityStore {
  seq = 0;
  private entries = new Map<string, ActivityEntry>();
  private results = new Map<string, { value: ToolData; size: number; expires: number }>();
  private resultBytes = 0;
  private listeners = new Set<() => void>();
  constructor(private readonly now = Date.now) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed() {
    this.seq++;
    for (const listener of this.listeners) listener();
  }
  private publish(entry: ActivityEntry) {
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    while (this.entries.size > 200) {
      const first = this.entries.keys().next().value;
      if (first) this.entries.delete(first);
    }
    for (const listener of this.listeners) listener();
  }
  private retainResult(id: string, value: ToolData) {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > 256 * 1024) return false;
    const previous = this.results.get(id);
    if (previous) this.resultBytes -= previous.size;
    this.results.set(id, {
      value: structuredClone(value),
      size,
      expires: this.now() + 5 * 60_000,
    });
    this.resultBytes += size;
    return true;
  }
  list() {
    return [...this.entries.values()].reverse().map((item) => ({ ...item }));
  }
  start(tool: ToolName, args: unknown, source: ActivitySource, title?: string) {
    if (!tracked.has(tool)) return undefined;
    const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const workspaceId =
      typeof input.workspace_id === "string" ? input.workspace_id.slice(0, 64) : undefined;
    const path = typeof input.path === "string" ? input.path.slice(0, 1024) : undefined;
    const seq = ++this.seq;
    const entry: ActivityEntry = {
      id: crypto.randomUUID(),
      seq,
      focusSeq: source === "mcp" ? seq : 0,
      source,
      kind: "tool",
      tool,
      workspaceId,
      path,
      title: title ?? titles[tool as keyof typeof titles],
      state: "working",
      updatedAt: this.now(),
    };
    this.publish(entry);
    return entry.id;
  }
  finish(id: string | undefined, data?: ToolData, message?: string) {
    if (!id) return;
    const entry = this.entries.get(id);
    if (!entry) return;
    if (data) {
      if (this.retainResult(id, data)) entry.resultId = id;
    }
    this.trimResults();
    const mcpFailure = data?.kind === "mcp_call" && data.is_error;
    const mcpMessage =
      mcpFailure && data.content[0]?.type === "text"
        ? data.content[0].text.slice(0, 1000)
        : undefined;
    this.publish({
      ...entry,
      seq: ++this.seq,
      ...(data?.kind === "mcp_call"
        ? { title: `${data.tool.server_name} · ${data.tool.title ?? data.tool.name}` }
        : {}),
      state: message || mcpFailure ? "failed" : "completed",
      message: message ?? mcpMessage,
      updatedAt: this.now(),
    });
  }
  terminal(session: TerminalSession, source: ActivitySource, kind: "state" | "input" | "output") {
    const id = `terminal:${session.id}`;
    const prior = this.entries.get(id);
    const seq = ++this.seq;
    const focus = source === "mcp" && ((!prior && session.state === "pending") || kind === "input");
    this.publish({
      id,
      seq,
      focusSeq: focus ? seq : (prior?.focusSeq ?? 0),
      // xterm can send protocol replies via local-ui input too. Local typing or
      // terminal replies must not erase an existing MCP session's follow target.
      source: source === "mcp" || prior?.source === "mcp" ? "mcp" : (prior?.source ?? source),
      kind: "terminal",
      workspaceId: session.workspace_id,
      sessionId: session.id,
      title: `${session.shell} · ${terminalLabels[session.state]}`,
      state: session.state,
      updatedAt: this.now(),
    });
  }
  private trimResults() {
    for (const [id, result] of this.results) {
      if (
        this.now() >= result.expires ||
        this.results.size > 40 ||
        this.resultBytes > 4 * 1024 * 1024
      ) {
        this.results.delete(id);
        this.resultBytes -= result.size;
      }
    }
  }
  command(command: Command, source: ActivitySource) {
    const id = `command:${command.id}`;
    const prior = this.entries.get(id);
    const seq = ++this.seq;
    this.publish({
      id,
      seq,
      focusSeq: prior?.focusSeq ?? (source === "mcp" ? seq : 0),
      source,
      kind: "command",
      workspaceId: command.workspace_id,
      commandId: command.id,
      title: `${command.argv[0] ?? "命令"} · ${commandLabels[command.state]}`,
      state: command.state,
      updatedAt: this.now(),
      message: command.message ?? undefined,
    });
  }
  fileChange(change: FileChange, source: ActivitySource) {
    const id = `file-change:${change.id}`;
    const prior = this.entries.get(id);
    const seq = ++this.seq;
    this.publish({
      id,
      seq,
      focusSeq: prior?.focusSeq ?? (source === "mcp" ? seq : 0),
      source,
      kind: "file_change",
      workspaceId: change.workspace_id,
      changeId: change.id,
      title: `${change.summary} · ${fileChangeLabels[change.state]}`,
      state: change.state,
      updatedAt: this.now(),
      message: change.message ?? undefined,
    });
  }
  artifactImport(value: ArtifactImport, source: ActivitySource, artifact?: Artifact) {
    const id = `artifact-import:${value.id}`;
    const prior = this.entries.get(id);
    const seq = ++this.seq;
    const resultId = artifact ? (prior?.resultId ?? crypto.randomUUID()) : prior?.resultId;
    if (artifact && resultId) this.retainResult(resultId, artifact);
    this.trimResults();
    this.publish({
      id,
      seq,
      focusSeq: prior?.focusSeq ?? (source === "mcp" ? seq : 0),
      source,
      kind: "artifact_import",
      tool: "artifact_import_request",
      workspaceId: value.workspace_id,
      path: value.path,
      importId: value.id,
      resultId,
      title: `${value.summary} · ${artifactImportLabels[value.state]}`,
      state: value.state,
      updatedAt: this.now(),
      message: value.message ?? undefined,
    });
  }
  result(id: string) {
    this.trimResults();
    const result = this.results.get(id);
    if (!result)
      throw new KairomesError(
        "RESULT_EXPIRED",
        "這筆操作的內容已超過保留期限；請從檔案瀏覽器重新讀取目前版本。",
      );
    return structuredClone(result.value);
  }
  close() {
    this.listeners.clear();
    this.entries.clear();
    this.results.clear();
    this.resultBytes = 0;
  }
}
