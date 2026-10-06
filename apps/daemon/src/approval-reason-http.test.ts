import { expect, test } from "bun:test";
import {
  CommandListSchema,
  CommandResultSchema,
  FileChangeListSchema,
  FileChangeResultSchema,
  type PanelSnapshot,
  TerminalListSchema,
  TerminalResultSchema,
} from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture } from "../../../tests/fixtures.ts";
import { startWorkbench } from "./preview.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

const char = (code: number) => String.fromCodePoint(code);

test("only the trusted deny routes attach a reason, which the model reads from poll and list", async () => {
  const f = await fixture();
  const extensionId = "a".repeat(32);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const app = await startWorkbench(
    f.registry,
    "<html><head><!--KAIROMES_MODE--></head></html>",
    0,
    extensionId,
  );
  const client = new Client({ name: "approval-reason-test", version: "1" });
  try {
    const c = await readWorkbenchConnection(f.state);
    const post = (route: string, token: string, body: unknown, origin = c.origin) =>
      fetch(`${c.origin}${route}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${c.origin}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${c.mcpToken}` } },
      }),
    );
    const tool = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const pairLink = await (
      await post("/api/pairing/create", c.adminToken, { extensionId })
    ).json();
    const fragment = new URLSearchParams(new URL(pairLink.pairingUrl).hash.slice(1));
    const panel = await (
      await post(
        "/api/panel/pair",
        "",
        { code: fragment.get("code"), instanceId: c.instanceId },
        extensionOrigin,
      )
    ).json();
    const panelPost = (body: unknown) =>
      post("/api/panel/approvals", panel.panelToken, body, extensionOrigin);
    const adminPost = (body: unknown) => post("/api/approvals", c.adminToken, body);
    const snapshot = async () =>
      (await (await panelPost({ action: "list" })).json()) as PanelSnapshot;
    const requestChange = async (path: string) =>
      FileChangeResultSchema.parse(
        (
          await tool("file_change_request", {
            workspace_id: f.workspace.id,
            request_id: crypto.randomUUID(),
            summary: `新增 ${path}`,
            changes: [{ operation: "write", path, content: "內容\n" }],
          })
        ).structuredContent,
      ).change;
    const pollChange = async (id: string) =>
      FileChangeResultSchema.parse(
        (await tool("file_change_poll", { change_id: id })).structuredContent,
      ).change;

    // The paired panel denies with a reason; the model sees it trimmed in poll and list.
    const first = await requestChange("first.md");
    const firstReview = (await snapshot()).changes?.find((item) => item.id === first.id);
    const denied = await panelPost({
      action: "deny",
      change_id: first.id,
      fingerprint: firstReview?.fingerprint,
      reason: "  請先讀取 README 再修改  ",
    });
    expect(denied.status).toBe(200);
    const deniedSnapshot = (await denied.json()) as PanelSnapshot;
    expect(deniedSnapshot.changes?.find((item) => item.id === first.id)).toMatchObject({
      state: "denied",
      fingerprint: firstReview?.fingerprint,
      denial_reason: "請先讀取 README 再修改",
    });
    expect(await pollChange(first.id)).toMatchObject({
      state: "denied",
      denial_reason: "請先讀取 README 再修改",
    });
    expect(
      FileChangeListSchema.parse(
        (await tool("file_change_list", {})).structuredContent,
      ).changes.find((item) => item.id === first.id)?.denial_reason,
    ).toBe("請先讀取 README 再修改");

    // Reasons with the wrong action or invalid text are rejected on both trusted routes.
    const second = await requestChange("second.md");
    const secondReview = (await snapshot()).changes?.find((item) => item.id === second.id);
    const target = { change_id: second.id, fingerprint: secondReview?.fingerprint };
    for (const body of [
      { action: "approve", ...target, reason: "可以" },
      { action: "stop", change_id: second.id, reason: "停止" },
      { action: "deny", ...target, reason: `第一行${char(10)}第二行` },
      { action: "deny", ...target, reason: `響鈴${char(7)}` },
      { action: "deny", ...target, reason: `反轉${char(0x202e)}文字` },
      { action: "deny", ...target, reason: "長".repeat(201) },
      { action: "deny", ...target, reason: "   " },
    ]) {
      expect((await panelPost(body)).status).toBe(400);
      expect((await adminPost(body)).status).toBe(400);
    }
    expect(await pollChange(second.id)).toMatchObject({ state: "pending" });
    expect(await pollChange(second.id)).not.toHaveProperty("denial_reason");
    expect((await adminPost({ action: "deny", ...target, reason: "長".repeat(200) })).status).toBe(
      200,
    );
    expect((await pollChange(second.id)).denial_reason).toBe("長".repeat(200));

    // The admin channel denies a command with a reason.
    const command = CommandResultSchema.parse(
      (
        await tool("command_request", {
          workspace_id: f.workspace.id,
          request_id: crypto.randomUUID(),
          argv: ["bun", "-e", "console.log('never runs')"],
          timeout_ms: 5000,
        })
      ).structuredContent,
    ).command;
    const commandReview = (await snapshot()).commands?.find((item) => item.id === command.id);
    expect(
      (
        await adminPost({
          action: "deny",
          command_id: command.id,
          fingerprint: commandReview?.fingerprint,
          reason: "不要執行完整建置",
        })
      ).status,
    ).toBe(200);
    expect(
      CommandResultSchema.parse(
        (await tool("command_poll", { command_id: command.id })).structuredContent,
      ),
    ).toMatchObject({
      command: { state: "denied", denial_reason: "不要執行完整建置" },
      stdout: "",
    });
    expect(
      CommandListSchema.parse((await tool("command_list", {})).structuredContent).commands.find(
        (item) => item.id === command.id,
      )?.denial_reason,
    ).toBe("不要執行完整建置");

    // The panel denies a terminal with a reason.
    const session = TerminalResultSchema.parse(
      (
        await tool("terminal_start", {
          workspace_id: f.workspace.id,
          shell: process.platform === "win32" ? "cmd" : "bash",
        })
      ).structuredContent,
    ).session;
    const sessionReview = (await snapshot()).sessions.find((item) => item.id === session.id);
    expect(
      (
        await panelPost({
          action: "deny",
          session_id: session.id,
          fingerprint: sessionReview?.fingerprint,
          reason: "改用 command_request",
        })
      ).status,
    ).toBe(200);
    expect(
      TerminalResultSchema.parse(
        (await tool("terminal_poll", { session_id: session.id })).structuredContent,
      ).session,
    ).toMatchObject({ state: "denied", denial_reason: "改用 command_request" });
    expect(
      TerminalListSchema.parse((await tool("terminal_list", {})).structuredContent).sessions.find(
        (item) => item.id === session.id,
      )?.denial_reason,
    ).toBe("改用 command_request");

    // MCP and the widget's /api/tools route have no way to attach a reason.
    const third = await requestChange("third.md");
    for (const [name, args] of [
      ["file_change_cancel", { change_id: third.id, reason: "模型自填" }],
      ["file_change_cancel", { change_id: third.id, denial_reason: "模型自填" }],
      ["command_cancel", { command_id: command.id, reason: "模型自填" }],
      ["terminal_stop", { session_id: session.id, reason: "模型自填" }],
    ] as const) {
      expect((await tool(name, args)).isError).toBe(true);
      const widget = await (await post("/api/tools", c.uiToken, { name, arguments: args })).json();
      expect(widget.isError).toBe(true);
    }
    expect(await pollChange(third.id)).toMatchObject({ state: "pending" });
    for (const definition of (await client.listTools()).tools) {
      const fields = Object.keys(definition.inputSchema.properties ?? {});
      expect(fields).not.toContain("reason");
      expect(fields).not.toContain("denial_reason");
    }
    const thirdReview = (await snapshot()).changes?.find((item) => item.id === third.id);
    const deny = {
      action: "deny",
      change_id: third.id,
      fingerprint: thirdReview?.fingerprint,
      reason: "模型自填",
    };
    for (const token of [c.uiToken, c.mcpToken]) {
      expect((await post("/api/approvals", token, deny)).status).toBe(401);
      expect((await post("/api/panel/approvals", token, deny, extensionOrigin)).status).toBe(401);
    }
    // A model cancellation is not a denial and carries no reason.
    await tool("file_change_cancel", { change_id: third.id });
    const cancelled = await pollChange(third.id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled).not.toHaveProperty("denial_reason");
  } finally {
    await client.close();
    await app.close();
    await f.dispose();
  }
}, 20_000);
