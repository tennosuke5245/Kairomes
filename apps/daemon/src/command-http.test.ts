import { expect, test } from "bun:test";
import { type CommandApproval, CommandResultSchema } from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture } from "../../../tests/fixtures.ts";
import { startWorkbench } from "./preview.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

test("MCP command waits for a separate native approval and cannot approve through tool or iframe tokens", async () => {
  const f = await fixture();
  const extensionId = "a".repeat(32);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const app = await startWorkbench(
    f.registry,
    "<html><head><!--KAIROMES_MODE--></head></html>",
    0,
    extensionId,
  );
  const client = new Client({ name: "command-test", version: "1" });
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
    const args = {
      workspace_id: f.workspace.id,
      argv: [
        "bun.cmd",
        "-e",
        "console.log('command HTTP ok');console.error('separate stderr');process.exit(3)",
      ],
      request_id: crypto.randomUUID(),
      timeout_ms: 5000,
    };
    const requested = await client.callTool({ name: "command_request", arguments: args });
    const pending = CommandResultSchema.parse(requested.structuredContent);
    expect(pending.command.state).toBe("pending");
    expect(JSON.stringify(pending)).not.toContain("fingerprint");
    expect(JSON.stringify(pending)).not.toContain(f.root);
    const pairedUrl = await (
      await post("/api/pairing/create", c.adminToken, { extensionId })
    ).json();
    const fragment = new URLSearchParams(new URL(pairedUrl.pairingUrl).hash.slice(1));
    const panel = await (
      await post(
        "/api/panel/pair",
        "",
        { code: fragment.get("code"), instanceId: c.instanceId },
        extensionOrigin,
      )
    ).json();
    const list = await (
      await post("/api/panel/approvals", panel.panelToken, { action: "list" }, extensionOrigin)
    ).json();
    const review = (list.commands as CommandApproval[]).find((j) => j.id === pending.command.id);
    expect(review?.argv).toEqual(args.argv);
    expect(review?.absolute_cwd).toBe(f.root);
    const decision = {
      action: "approve",
      command_id: pending.command.id,
      fingerprint: review?.fingerprint,
    };
    for (const token of [c.uiToken, c.mcpToken, c.adminToken])
      expect((await post("/api/panel/approvals", token, decision, extensionOrigin)).status).toBe(
        401,
      );
    expect((await post("/api/panel/approvals", panel.panelToken, decision)).status).toBe(403);
    expect((await post("/api/approvals", c.mcpToken, decision)).status).toBe(401);
    expect(
      (
        await post(
          "/api/panel/approvals",
          panel.panelToken,
          { ...decision, fingerprint: "bad" },
          extensionOrigin,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/api/panel/approvals",
          panel.panelToken,
          { ...decision, session_id: crypto.randomUUID() },
          extensionOrigin,
        )
      ).status,
    ).toBe(400);
    expect(
      (await post("/api/panel/approvals", panel.panelToken, decision, extensionOrigin)).status,
    ).toBe(200);
    expect(
      (await post("/api/panel/approvals", panel.panelToken, decision, extensionOrigin)).status,
    ).toBe(400);
    let done = pending;
    const deadline = Date.now() + 5000;
    while (!done.output_complete && Date.now() < deadline) {
      done = CommandResultSchema.parse(
        (
          await client.callTool({
            name: "command_poll",
            arguments: { command_id: pending.command.id },
          })
        ).structuredContent,
      );
      await Bun.sleep(10);
    }
    expect(done.command.state).toBe("failed");
    expect(done.command.exit_code).toBe(3);
    expect(done.stdout).toContain("command HTTP ok");
    expect(done.stderr).toContain("separate stderr");
    expect(
      CommandResultSchema.parse(
        (await client.callTool({ name: "command_request", arguments: args })).structuredContent,
      ).command.id,
    ).toBe(pending.command.id);
    expect(
      (await client.listTools()).tools.find((t) => t.name === "command_request")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: true,
    });
  } finally {
    await client.close();
    await app.close();
    await f.dispose();
  }
}, 15000);
