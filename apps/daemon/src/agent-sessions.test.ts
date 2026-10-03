import { expect, test } from "bun:test";
import { handoffCoverageTruncated } from "@kairomes/protocol";
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
  turnCursor: string | null = "older";
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
    if (method === "thread/turns/list") return { data: this.page, nextCursor: this.turnCursor };
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
    for (let i = 0; i < 9; i++) await source.list();
    await expect(source.list()).rejects.toMatchObject({ code: "SESSION_PAGES" });
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

test("handoff message/action count boundaries retain newest evidence and report actual clipping", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake();
  rpc.cwd = rpc.listCwd = f.root;
  rpc.turnCursor = null;
  const source = await CodexSessionSource.open(rpc, f.root);
  try {
    await source.list();
    for (const messageCount of [32, 33]) {
      for (const actionCount of [40, 41]) {
        const messages = Array.from({ length: messageCount }, (_, index) =>
          index % 2
            ? { type: "agentMessage", text: `message-${index}` }
            : { type: "userMessage", content: [{ type: "text", text: `message-${index}` }] },
        );
        const actions = Array.from({ length: actionCount }, (_, index) => ({
          type: "commandExecution",
          command: `command-${index}`,
          status: "completed",
          exitCode: 0,
        }));
        rpc.page = [
          {
            id: "bounded-turn",
            status: "completed",
            items: [
              ...actions,
              { type: "reasoning", content: "REASONING_PRIVATE" },
              { type: "userMessage", content: [{ type: "image", url: "IMAGE_PRIVATE" }] },
              ...messages,
              { type: "mcpToolCall", result: "TOOL_PRIVATE" },
            ],
          },
        ];
        const snapshot = await source.snapshot("mine");
        const turn = snapshot.completedTurns[0];
        expect(turn?.messages.map((message) => message.text)).toEqual(
          Array.from({ length: 32 }, (_, index) => `message-${messageCount - 32 + index}`),
        );
        // Filling the message budget must not discard independently budgeted commands.
        expect(turn?.actions.map((action) => action.command)).toEqual(
          Array.from({ length: 40 }, (_, index) => `command-${actionCount - 40 + index}`),
        );
        expect(turn?.omittedItems).toBe(3 + (messageCount - 32) + (actionCount - 40));
        expect(snapshot.coverage.hasOlderTurns).toBe(false);
        expect(snapshot.coverage.textTruncated).toBe(false);
        expect(snapshot.coverage.itemsTruncated).toBe(messageCount > 32 || actionCount > 40);
        expect(handoffCoverageTruncated(snapshot.coverage)).toBe(
          messageCount > 32 || actionCount > 40,
        );
        expect(snapshot.partialTurns).toEqual([]);
        expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
      }
    }
  } finally {
    await source.close();
    await f.dispose();
  }
});

test("handoff safe filtering does not claim eligible evidence was clipped", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake();
  rpc.cwd = rpc.listCwd = f.root;
  rpc.turnCursor = null;
  rpc.page = [
    {
      id: "safe-filtering",
      status: "interrupted",
      items: [
        ...Array.from({ length: 50 }, () => ({ type: "reasoning", content: "PRIVATE" })),
        { type: "agentMessage", text: "public" },
      ],
    },
  ];
  const source = await CodexSessionSource.open(rpc, f.root);
  try {
    await source.list();
    const snapshot = await source.snapshot("mine");
    expect(snapshot.partialTurns[0]?.omittedItems).toBe(50);
    expect(snapshot.partialTurns[0]?.messages).toEqual([
      { role: "assistant", text: "public", truncated: false },
    ]);
    expect(snapshot.coverage.itemsTruncated).toBe(false);
    expect(handoffCoverageTruncated(snapshot.coverage)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
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
