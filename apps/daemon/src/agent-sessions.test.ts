import { expect, test } from "bun:test";
import { fixture } from "../../../tests/fixtures.ts";
import { CodexSessionSource } from "./agent-sessions.ts";
import type { CodexConnection } from "./codex-rpc.ts";
import { readHandoffWorkingTree } from "./handoff-working-tree.ts";

class ReadOnlyFake implements CodexConnection {
  connected = false;
  calls: { method: string; params: unknown }[] = [];
  cwd = "";
  listCwd = "";
  page: unknown[] = [];
  async start() {
    this.connected = true;
  }
  async close() {
    this.connected = false;
  }
  async request(method: string, params?: unknown) {
    this.calls.push({ method, params });
    const thread = { id: "mine", cwd: this.cwd, updatedAt: 1, name: "測試交接" };
    if (method === "thread/list")
      return {
        data: [
          { ...thread, cwd: this.listCwd },
          { ...thread, id: "elsewhere", cwd: `${this.listCwd}/another` },
        ],
        nextCursor: null,
      };
    if (method === "thread/read") return { thread };
    if (method === "thread/turns/list") return { data: this.page, nextCursor: "older" };
    throw new Error(`Mutating/unsupported method: ${method}`);
  }
}

test("handoff selects only exact-workspace listed sessions and never resumes a turn", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake();
  rpc.cwd = rpc.listCwd = f.root;
  const source = await CodexSessionSource.open(rpc, f.root);
  try {
    await expect(source.snapshot("mine")).rejects.toThrow("清單");
    const page = await source.list();
    expect(page.sessions.map((s) => s.id)).toEqual(["mine"]);
    await expect(source.list("invented")).rejects.toThrow("游標");
    await expect(source.snapshot("elsewhere")).rejects.toThrow("清單");
    const snapshot = await source.snapshot("mine");
    expect(snapshot.permissions).toBe("not-transferred");
    expect(snapshot.taskState.plan).toBeNull();
    expect(rpc.calls.map((c) => c.method)).toEqual([
      "thread/list",
      "thread/read",
      "thread/turns/list",
    ]);
    expect(rpc.calls[0]?.params).toMatchObject({ cwd: f.root, useStateDbOnly: true });
    rpc.cwd = f.state;
    await expect(source.snapshot("mine")).rejects.toThrow("已改變");
  } finally {
    await source.close();
    await f.dispose();
  }
});

test("partial turns retain public evidence, omit active text, reasoning and tool outputs", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake();
  rpc.cwd = rpc.listCwd = f.root;
  rpc.page = [
    {
      id: "active",
      status: "inProgress",
      items: [{ type: "agentMessage", text: "ACTIVE_PRIVATE" }],
    },
    {
      id: "partial",
      status: "interrupted",
      items: [
        {
          type: "userMessage",
          content: [
            { type: "text", text: "請繼續喵" },
            { type: "image", url: "IMAGE_PRIVATE" },
          ],
        },
        { type: "reasoning", content: "REASONING_PRIVATE" },
        {
          type: "commandExecution",
          command: "bun.cmd run check",
          status: "completed",
          exitCode: 1,
          aggregatedOutput: "OUTPUT_PRIVATE",
        },
        { type: "agentMessage", text: "檢查還沒通過" },
        { type: "mcpToolCall", result: "MCP_PRIVATE" },
      ],
    },
    { id: "done", status: "completed", items: [{ type: "agentMessage", text: "上一個步驟" }] },
  ];
  const source = await CodexSessionSource.open(rpc, f.root);
  try {
    await source.list();
    const snapshot = await source.snapshot("mine");
    expect(snapshot.completedTurns).toHaveLength(1);
    expect(snapshot.partialTurns[0]?.sourceStatus).toBe("interrupted");
    expect(snapshot.partialTurns[0]?.actions[0]?.exitCode).toBe(1);
    expect(snapshot.lastMessageTurnStatus).toBe("interrupted");
    expect(snapshot.lastUserRequest).toBe("請繼續喵");
    expect(snapshot.lastAgentResponse).toBe("檢查還沒通過");
    expect(snapshot.pendingTurns).toEqual([{ id: "active", sourceStatus: "inProgress" }]);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
    expect(snapshot.coverage.hasOlderTurns).toBe(true);
  } finally {
    await source.close();
    await f.dispose();
  }
});

test("handoff bounds text, keeps newest public messages and masks known credentials", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake();
  rpc.cwd = rpc.listCwd = f.root;
  rpc.page = [
    {
      id: "turn",
      status: "failed",
      items: [
        ...Array.from({ length: 10 }, () => ({ type: "agentMessage", text: "x".repeat(20000) })),
        { type: "userMessage", content: [{ type: "text", text: `token ghp_${"a".repeat(36)}` }] },
        { type: "agentMessage", text: "最新工作尚未完成" },
      ],
    },
  ];
  const source = await CodexSessionSource.open(rpc, f.root);
  try {
    await source.list();
    const data = await source.snapshot("mine");
    expect(data.lastAgentResponse).toBe("最新工作尚未完成");
    expect(data.coverage.textTruncated).toBe(true);
    expect(JSON.stringify(data)).not.toContain("ghp_");
    expect(
      data.partialTurns.flatMap((t) => t.messages).reduce((n, m) => n + m.text.length, 0),
    ).toBeLessThanOrEqual(24000);
    await expect(source.snapshot("mine", 11)).rejects.toThrow("1～10");
  } finally {
    await source.close();
    await f.dispose();
  }
});

test("handoff Git observation accepts unborn HEAD without inventing a commit", async () => {
  const f = await fixture();
  try {
    expect((await readHandoffWorkingTree(f.root)).state).toBe("unavailable");
    const init = Bun.spawn(["git", "init", "--initial-branch=main", f.root], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await init.exited).toBe(0);
    const tree = await readHandoffWorkingTree(f.root);
    expect(tree.state).toBe("available");
    if (tree.state === "available") {
      expect(tree.head).toBeNull();
      expect(tree.branch).toBe("main");
      expect(tree.files.some((f) => f.status === "??" && f.path === "README.md")).toBe(true);
    }
  } finally {
    await f.dispose();
  }
});
