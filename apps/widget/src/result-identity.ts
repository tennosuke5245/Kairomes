import type { CommandResult, FileChangeResult, ToolData } from "@kairomes/protocol";

/** Reject another operation before its payload or pagination can be consumed. */
export function requireCommandResult(data: ToolData, id: string): CommandResult {
  if (data.kind !== "command" || data.command.id !== id)
    throw new Error("命令結果與選擇的命令不符。");
  return data;
}

export function requireFileChangeResult(
  data: ToolData,
  expected: { id: string; workspaceId: string },
): FileChangeResult {
  if (
    data.kind !== "file_change" ||
    data.change.id !== expected.id ||
    data.change.workspace_id !== expected.workspaceId
  )
    throw new Error("差異結果與選擇的變更不符。");
  return data;
}
