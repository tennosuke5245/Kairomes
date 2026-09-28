import { expect, test } from "bun:test";
import type { ActivityEntry, ActivitySnapshot } from "@kairomes/protocol";
import { latestFocus } from "./activity-panel.tsx";

test("follow selects meaningful MCP focus, not arrival order, output noise or local browsing", () => {
  const base: ActivityEntry = {
    id: "read",
    seq: 2,
    focusSeq: 1,
    source: "mcp",
    kind: "tool",
    tool: "file_read",
    title: "讀取檔案",
    state: "completed",
    updatedAt: 0,
    resultId: "result",
  };
  const terminal: ActivityEntry = {
    ...base,
    id: "terminal",
    kind: "terminal",
    tool: undefined,
    sessionId: "session",
    resultId: undefined,
    state: "running",
    seq: 9,
    focusSeq: 3,
  };
  const snapshot: ActivitySnapshot = {
    instanceId: "test",
    seq: 12,
    sessions: [],
    entries: [
      { ...base, id: "manual", source: "local-ui", seq: 12, focusSeq: 0 },
      { ...base, id: "poll", tool: "terminal_poll", seq: 11, focusSeq: 11 },
      { ...base, id: "list", tool: "workspace_list", seq: 10, focusSeq: 10 },
      terminal,
      base,
    ],
  };
  expect(latestFocus(snapshot)?.id).toBe("terminal");
  snapshot.entries.push({ ...base, id: "new-read", seq: 5, focusSeq: 4 });
  // Later output from an older shell must not steal a newer read's viewer.
  expect(latestFocus(snapshot)?.id).toBe("new-read");
  expect(latestFocus()).toBeUndefined();
  snapshot.entries.push({
    ...terminal,
    id: "command",
    kind: "command",
    commandId: "command-id",
    sessionId: undefined,
    focusSeq: 6,
    seq: 7,
  });
  expect(latestFocus(snapshot)?.commandId).toBe("command-id");
  snapshot.entries.push({
    ...base,
    id: "artifact-import",
    kind: "artifact_import",
    tool: "artifact_import_request",
    importId: "import-id",
    focusSeq: 7,
    seq: 8,
  });
  expect(latestFocus(snapshot)?.importId).toBe("import-id");
  snapshot.entries.unshift({ ...terminal, seq: 100 });
  expect(latestFocus(snapshot)?.id).toBe("artifact-import");
});
