import { KairomesError } from "@kairomes/protocol";
import { openHandoffSource } from "../../daemon/src/handoff-source.ts";
import { readHandoffWorkingTree } from "../../daemon/src/handoff-working-tree.ts";

/** Explicit local CLI only. No automatic history discovery by MCP/browser clients. */
export async function handoff(
  action: string | undefined,
  sessionId: string | undefined,
  workspace: string | undefined,
  sourceHome: string | undefined,
) {
  if (!workspace || !["list", "snapshot"].includes(action ?? ""))
    throw new KairomesError(
      "USAGE",
      "請使用 handoff list 或 snapshot <id>，並指定 --workspace <folder>。",
    );
  if (action === "snapshot" && !sessionId)
    throw new KairomesError("USAGE", "請從 handoff list 選擇一個工作階段 ID。");
  const source = await openHandoffSource(workspace, sourceHome);
  try {
    let page = await source.list();
    if (action === "list") {
      console.log(
        JSON.stringify(
          {
            ...page,
            note: "唯讀本機預覽；最多顯示最近 50 筆同專案紀錄，不會啟動 Agent 或送到 ChatGPT。",
          },
          null,
          2,
        ),
      );
      return;
    }
    // Find explicit local selection within a bounded number of pages. There is no
    // MCP history endpoint; a granted host shell can still invoke this local CLI.
    for (let i = 0; i < 9 && !page.sessions.some((s) => s.id === sessionId) && page.nextCursor; i++)
      page = await source.list(page.nextCursor);
    const snapshot = await source.snapshot(sessionId as string);
    console.log(
      JSON.stringify(
        { ...snapshot, workingTree: await readHandoffWorkingTree(source.cwd) },
        null,
        2,
      ),
    );
  } finally {
    await source.close();
  }
}
