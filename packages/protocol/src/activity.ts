import type { ArtifactImport, ArtifactImportApproval } from "./artifact-import.ts";
import type { Command, CommandApproval } from "./command.ts";
import type { FileChange, FileChangeApproval } from "./file-change.ts";
import type { TerminalSession, ToolData, ToolName } from "./index.ts";

export type ActivitySource = "mcp" | "local-ui" | "system";
export interface ActivityEntry {
  id: string;
  seq: number;
  focusSeq: number;
  source: ActivitySource;
  kind: "tool" | "terminal" | "command" | "file_change" | "artifact_import";
  title: string;
  state:
    | "working"
    | "completed"
    | "failed"
    | TerminalSession["state"]
    | Command["state"]
    | FileChange["state"]
    | ArtifactImport["state"];
  updatedAt: number;
  /** Includes quarantined internal activity names that are not public MCP tools. */
  tool?: ToolName | "artifact_import_request";
  workspaceId?: string;
  path?: string;
  sessionId?: string;
  commandId?: string;
  changeId?: string;
  importId?: string;
  resultId?: string;
  message?: string;
}
export interface ActivitySnapshot {
  instanceId: string;
  seq: number;
  entries: ActivityEntry[];
  sessions: TerminalSession[];
  commands?: Command[];
  changes?: FileChange[];
  imports?: ArtifactImport[];
}
export interface ApprovalSession extends TerminalSession {
  fingerprint: string;
  absolute_cwd: string;
  command: string[];
  workspace_name: string;
}
export interface PanelSnapshot {
  instanceId: string;
  sessions: ApprovalSession[];
  workspaces?: { id: string; name: string }[];
  accessGrants?: AccessGrant[];
  commands?: CommandApproval[];
  changes?: FileChangeApproval[];
  imports?: ArtifactImportApproval[];
}
export interface AccessGrant {
  id: string;
  workspace_id: string;
  workspace_name: string;
  level: "files" | "full";
  /** Null means the trusted local user chose "until manually revoked". */
  expires_at: number | null;
}
export interface PanelConnection {
  instanceId: string;
  origin: string;
  panelToken: string;
  workbenchUrl: string;
}
export interface ActivityConnection {
  watch(onSnapshot: (snapshot: ActivitySnapshot) => void, signal: AbortSignal): Promise<void>;
  result(id: string): Promise<ToolData>;
}

export const terminalLabels: Record<TerminalSession["state"], string> = {
  pending: "等待核准",
  starting: "啟動中",
  running: "可接收輸入",
  exited: "已結束",
  denied: "已拒絕",
  stopped: "已停止",
  expired: "已到期",
  failed: "啟動失敗",
};
