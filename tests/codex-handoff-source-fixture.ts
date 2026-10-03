// Fixed synthetic stdio peer. No Codex binary, login, model, network or commands.
import { createInterface } from "node:readline";

const workspace = process.argv[2];
const mode = process.argv[3] ?? "valid";
if (!workspace) throw new Error("Missing synthetic workspace");
const calls: string[] = [];
const thread = {
  id: "synthetic-listed",
  cwd: workspace,
  name: "合成來源",
  updatedAt: 1,
  status: { type: "idle" },
};
const reply = (id: unknown, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const call = JSON.parse(line);
  calls.push(call.method);
  if (call.id === undefined) return;
  if (call.method === "initialize") return reply(call.id, {});
  if (call.method === "fixture/keep-alive") {
    reply(call.id, { pid: process.pid });
    setInterval(() => {}, 1000);
    return;
  }
  if (call.method === "fixture/wait") return;
  if (call.method === "fixture/report")
    return reply(call.id, {
      calls,
      secretInherited: "KAIROMES_HANDOFF_SYNTHETIC_SECRET" in process.env,
      sourceHomeMatchesCwd: process.env.CODEX_HOME === process.cwd(),
    });
  if (call.method === "thread/list")
    return reply(call.id, {
      data: [thread, { ...thread, id: "foreign", cwd: `${workspace}/another-project` }],
      nextCursor: null,
    });
  if (call.method === "thread/read")
    return reply(call.id, {
      thread: mode === "malformed-thread" ? { ...thread, cwd: null } : thread,
    });
  if (call.method === "thread/turns/list")
    return reply(call.id, {
      data:
        mode === "malformed-turn"
          ? [{ id: "broken", status: "completed", items: [null] }]
          : [
              {
                id: "pending",
                status: "inProgress",
                items: [{ type: "agentMessage", text: "PRIVATE_ACTIVE_TEXT" }],
              },
              {
                id: "partial",
                status: "interrupted",
                items: [
                  { type: "reasoning", content: "PRIVATE_REASONING" },
                  { type: "userMessage", content: [{ type: "text", text: "合成下一步" }] },
                  { type: "agentMessage", text: `合成憑證 ghp_${"a".repeat(36)}` },
                  {
                    type: "commandExecution",
                    command: "synthetic-command-never-executed",
                    status: "completed",
                    exitCode: 1,
                    aggregatedOutput: "PRIVATE_COMMAND_OUTPUT",
                  },
                  { type: "mcpToolCall", result: "PRIVATE_TOOL_OUTPUT" },
                ],
              },
              {
                id: "done",
                status: "completed",
                items: [{ type: "agentMessage", text: "合成完成" }],
              },
            ],
      nextCursor: "synthetic-older-page",
    });
  process.stdout.write(
    `${JSON.stringify({ id: call.id, error: { code: -32601, message: "Unsupported fixture method" } })}\n`,
  );
});
