import type { Artifact, FileResult, ToolData } from "@kairomes/protocol";

export function invalidateHostViewerRead(
  result: Pick<ToolData, "kind">,
  request: { current: number },
): boolean {
  switch (result.kind) {
    case "snapshot":
    case "file":
    case "search":
    case "artifact":
    case "mcp_call":
    case "file_change":
    case "command":
    case "terminal":
      request.current++;
      return true;
    default:
      return false;
  }
}

export async function readCurrentResult(
  expected: { kind: "file" | "artifact"; workspaceId: string; path: string },
  read: () => Promise<ToolData>,
  stillCurrent: () => boolean,
): Promise<FileResult | Artifact | undefined> {
  const data = await read();
  if (!stillCurrent()) return;
  if (
    (data.kind !== "file" && data.kind !== "artifact") ||
    data.kind !== expected.kind ||
    data.workspace_id !== expected.workspaceId ||
    data.path !== expected.path
  )
    throw new Error("讀取結果與選擇的檔案不符。");
  return data;
}
