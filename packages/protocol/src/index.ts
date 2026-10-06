import { z } from "zod";
import { ArtifactInputs, ArtifactSchema } from "./artifact.ts";
import { CommandInputs, CommandListSchema, CommandResultSchema } from "./command.ts";
import { FileChangeInputs, FileChangeListSchema, FileChangeResultSchema } from "./file-change.ts";
import { GitDiffSchema, GitInputs, GitLogSchema, GitStatusSchema } from "./git.ts";
import {
  McpCallSchema,
  McpCatalogSchema,
  McpInputs,
  McpToolDescriptionSchema,
} from "./mcp-host.ts";

export * from "./activity.ts";
export * from "./artifact.ts";
export * from "./artifact-import.ts";
export * from "./command.ts";
export { readSnapshots } from "./event-stream.ts";
export * from "./file-change.ts";
export * from "./git.ts";
export * from "./handoff.ts";
export * from "./mcp-auth.ts";
export * from "./mcp-host.ts";
export * from "./panel-access.ts";
export { z };
export const VERSION = "0.2.0";
export const WIDGET_URI = "ui://kairomes/workbench/v6.html";
export const MCP_RESULT_URI = "ui://kairomes/mcp-result/v2.html";
export const LIMITS = {
  concurrentCalls: 4,
  fileBytes: 1024 * 1024,
  artifactBytes: 25 * 1024 * 1024,
  artifactPixels: 80 * 1024 * 1024,
  responseBytes: 48 * 1024,
  directoryEntries: 200,
  /** Directory entries read by one workspace_snapshot call. */
  scanEntries: 1000,
  /** Directory entries visited by one file_search or file_find walk. */
  walkEntries: 4000,
  scanBytes: 8 * 1024 * 1024,
  scanMilliseconds: 3000,
  readManyFiles: 8,
  searchIncludePatterns: 8,
  searchContextLines: 3,
  findResults: 200,
  patternLength: 200,
} as const;

function hasUnsafeCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (
      code < 32 ||
      code === 127 ||
      code === 0xfffd ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}

/** file_find treats a query with *, ? or { as a glob; anything else is a literal substring. */
export function isGlobQuery(value: string): boolean {
  return /[*?{]/.test(value);
}

/**
 * Glob patterns are only matched against workspace-relative strings, never used to open
 * paths, but still must look relative: no root, parent segments, backslashes or negation.
 */
export function isSafeGlobPattern(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("!") &&
    !value.includes("..") &&
    !value.includes("\\") &&
    !hasUnsafeCharacters(value)
  );
}

const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  capabilities: z.array(z.enum(["read", "write_request"])),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
export const WorkspaceListSchema = z.object({
  kind: z.literal("workspaces"),
  workspaces: z.array(WorkspaceSchema),
});
const EntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["directory", "file"]),
});
export const SnapshotSchema = z.object({
  kind: z.literal("snapshot"),
  workspace: WorkspaceSchema,
  path: z.string(),
  entries: z.array(EntrySchema),
  truncated: z.boolean(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const FileSchema = z.object({
  kind: z.literal("file"),
  workspace_id: z.string(),
  path: z.string(),
  content: z.string(),
  version: z.string(),
  start_line: z.number().int(),
  total_lines: z.number().int(),
  next_line: z.number().int().nullable(),
  truncated: z.boolean(),
  redacted: z.boolean(),
});
export type FileResult = z.infer<typeof FileSchema>;
const ContextLines = z.array(z.string()).max(LIMITS.searchContextLines);
export const SearchSchema = z.object({
  kind: z.literal("search"),
  workspace_id: z.string(),
  query: z.string(),
  /** Relative directory scope; "" is the workspace root. Absent in results from older services. */
  path: z.string().optional(),
  case_sensitive: z.boolean().optional(),
  include: z.array(z.string()).max(LIMITS.searchIncludePatterns).optional(),
  context_lines: z.number().int().min(0).max(LIMITS.searchContextLines).optional(),
  matches: z.array(
    z.object({
      path: z.string(),
      line: z.number().int(),
      text: z.string(),
      /** Present only when context_lines > 0. */
      before: ContextLines.optional(),
      after: ContextLines.optional(),
    }),
  ),
  truncated: z.boolean(),
  scanned_files: z.number().int(),
  skipped_files: z.number().int(),
});
export type SearchResult = z.infer<typeof SearchSchema>;
const FileReadManyEntrySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      path: z.string(),
      content: z.string(),
      version: z.string(),
      start_line: z.number().int(),
      total_lines: z.number().int(),
      next_line: z.number().int().nullable(),
      truncated: z.boolean(),
      redacted: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      path: z.string(),
      start_line: z.number().int(),
      error: z.object({ code: z.string().max(64), message: z.string().max(500) }).strict(),
    })
    .strict(),
]);
export type FileReadManyEntry = z.infer<typeof FileReadManyEntrySchema>;
export const FileReadManySchema = z
  .object({
    kind: z.literal("file_read_many"),
    workspace_id: z.string(),
    files: z.array(FileReadManyEntrySchema).min(1).max(LIMITS.readManyFiles),
    /** True when any file has unread lines, including lines cut by the shared budget. */
    truncated: z.boolean(),
  })
  .strict();
export type FileReadManyResult = z.infer<typeof FileReadManySchema>;
export const FileFindSchema = z
  .object({
    kind: z.literal("file_find"),
    workspace_id: z.string(),
    query: z.string(),
    mode: z.enum(["substring", "glob"]),
    path: z.string(),
    entries: z
      .array(z.object({ path: z.string(), type: z.enum(["file", "directory"]) }).strict())
      .max(LIMITS.findResults),
    truncated: z.boolean(),
    scanned_entries: z.number().int().nonnegative(),
  })
  .strict();
export type FileFindResult = z.infer<typeof FileFindSchema>;
export const StatusSchema = z.object({
  kind: z.literal("status"),
  version: z.string(),
  runtime: z.string(),
  platform: z.string(),
  mounted_workspaces: z.number().int(),
  widget_available: z.boolean(),
  capabilities: z.object({
    read: z.literal(true),
    write: z.boolean(),
    terminal: z.boolean(),
    mcp_mount: z.literal(true),
    command: z.boolean(),
    artifact: z.literal(true),
  }),
});
const TerminalSessionSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  cwd: z.string(),
  shell: z.enum(["powershell", "cmd", "bash", "sh"]),
  mode: z.literal("host-pty"),
  state: z.enum([
    "pending",
    "starting",
    "running",
    "exited",
    "denied",
    "stopped",
    "expired",
    "failed",
  ]),
  created_at: z.number(),
  expires_at: z.number(),
  cols: z.number().int(),
  rows: z.number().int(),
  exit_code: z.number().int().nullable(),
});
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
export const TerminalResultSchema = z.object({
  kind: z.literal("terminal"),
  session: TerminalSessionSchema,
  output: z.string(),
  text: z.string(),
  cursor: z.number().int().nonnegative(),
  truncated: z.boolean(),
  has_more: z.boolean(),
});
export type TerminalResult = z.infer<typeof TerminalResultSchema>;
export const TerminalListSchema = z.object({
  kind: z.literal("terminals"),
  sessions: z.array(TerminalSessionSchema),
});
export const ToolDataSchema = z.discriminatedUnion("kind", [
  WorkspaceListSchema,
  SnapshotSchema,
  FileSchema,
  FileReadManySchema,
  SearchSchema,
  FileFindSchema,
  StatusSchema,
  TerminalResultSchema,
  TerminalListSchema,
  CommandResultSchema,
  CommandListSchema,
  FileChangeResultSchema,
  FileChangeListSchema,
  ArtifactSchema,
  McpCatalogSchema,
  McpToolDescriptionSchema,
  McpCallSchema,
  GitStatusSchema,
  GitDiffSchema,
  GitLogSchema,
]);
export type ToolData = z.infer<typeof ToolDataSchema>;
export const WorkspaceId = z.string().uuid();
const RelativePath = z.string().max(1024);
const FileLines = {
  start_line: z.number().int().min(1).default(1),
  max_lines: z.number().int().min(1).max(300).default(150),
};
const SearchText = z
  .string()
  .min(1)
  .max(LIMITS.patternLength)
  .refine((value) => !value.includes("\uFFFD"), {
    message: "搜尋內容包含無法辨識的字元，請重新輸入搜尋文字。",
  });
const TerminalId = z.string().uuid();
const TerminalSize = {
  cols: z.number().int().min(20).max(240),
  rows: z.number().int().min(5).max(100),
};
export const Inputs = {
  ...ArtifactInputs,
  ...CommandInputs,
  ...FileChangeInputs,
  ...GitInputs,
  ...McpInputs,
  terminal_start: z
    .object({
      workspace_id: WorkspaceId,
      cwd: RelativePath.default(""),
      shell: z.enum(["powershell", "cmd", "bash", "sh"]).optional(),
      cols: TerminalSize.cols.default(100),
      rows: TerminalSize.rows.default(28),
    })
    .strict(),
  terminal_list: z.object({}).strict(),
  terminal_poll: z
    .object({
      session_id: TerminalId,
      cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    })
    .strict(),
  terminal_input: z
    .object({
      session_id: TerminalId,
      data: z.string().min(1).max(4096),
      input_id: z.string().uuid(),
    })
    .strict(),
  terminal_resize: z.object({ session_id: TerminalId, ...TerminalSize }).strict(),
  terminal_stop: z.object({ session_id: TerminalId }).strict(),
  kairomes_status: z.object({}).strict(),
  workbench_open: z.object({}).strict(),
  workspace_list: z.object({}).strict(),
  workspace_snapshot: z
    .object({
      workspace_id: WorkspaceId,
      path: RelativePath.default(""),
      limit: z.number().int().min(1).max(LIMITS.directoryEntries).default(100),
    })
    .strict(),
  file_read: z
    .object({
      workspace_id: WorkspaceId,
      path: RelativePath.min(1),
      ...FileLines,
    })
    .strict(),
  file_read_many: z
    .object({
      workspace_id: WorkspaceId,
      files: z
        .array(z.object({ path: RelativePath.min(1), ...FileLines }).strict())
        .min(1)
        .max(LIMITS.readManyFiles),
    })
    .strict(),
  file_search: z
    .object({
      workspace_id: WorkspaceId,
      query: SearchText,
      limit: z.number().int().min(1).max(50).default(30),
      path: RelativePath.default(""),
      case_sensitive: z.boolean().default(false),
      include: z
        .array(
          z.string().max(LIMITS.patternLength).refine(isSafeGlobPattern, {
            message: "檔案樣式必須是工作區內的相對樣式，不能包含 ..、開頭的 / 或 !。",
          }),
        )
        .max(LIMITS.searchIncludePatterns)
        .optional(),
      context_lines: z.number().int().min(0).max(LIMITS.searchContextLines).default(0),
    })
    .strict(),
  file_find: z
    .object({
      workspace_id: WorkspaceId,
      query: SearchText.refine(
        (value) => !hasUnsafeCharacters(value) && (!isGlobQuery(value) || isSafeGlobPattern(value)),
        { message: "檔名樣式必須是工作區內的相對樣式，不能包含 ..、開頭的 / 或 !。" },
      ),
      path: RelativePath.default(""),
      limit: z.number().int().min(1).max(LIMITS.findResults).default(50),
    })
    .strict(),
} as const;
export type ToolName = keyof typeof Inputs;

export class KairomesError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KairomesError";
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof KairomesError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { code: "VALIDATION", message: "工具參數格式不正確。" };
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  switch (code) {
    case "ENOENT":
      return { code: "PATH_NOT_FOUND", message: "找不到指定的檔案或資料夾，請確認路徑後再試。" };
    case "EACCES":
    case "EPERM":
      return { code: "ACCESS_DENIED", message: "目前帳號沒有存取該檔案、資料夾或連接埠的權限。" };
    case "EADDRINUSE":
      return {
        code: "PORT_UNAVAILABLE",
        message: "指定連接埠正在使用中，請改用 --port 0 或選擇其他連接埠。",
      };
    case "SQLITE_BUSY":
    case "SQLITE_LOCKED":
      return {
        code: "STATE_BUSY",
        message: "Kairomes 狀態資料正在被另一個程序使用，請關閉重複的 Kairomes 指令後再試。",
      };
  }
  return { code: "IO_ERROR", message: "無法完成操作；請檢查本機檔案或工作區狀態。" };
}
