import { expect, test } from "bun:test";
import { type FileChangeApproval, FileChangeResultSchema, FileSchema } from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture } from "../../../tests/fixtures.ts";
import { startWorkbench } from "./preview.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

test("MCP file changes expose review data only to the trusted native approval channel", async () => {
  const f = await fixture();
  const extensionId = "a".repeat(32);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const app = await startWorkbench(
    f.registry,
    "<html><head><!--KAIROMES_MODE--></head></html>",
    0,
    extensionId,
  );
  const client = new Client({ name: "file-change-test", version: "1" });
  try {
    const connection = await readWorkbenchConnection(f.state);
    const post = (route: string, token: string, body: unknown, origin = connection.origin) =>
      fetch(`${connection.origin}${route}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${connection.origin}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${connection.mcpToken}` } },
      }),
    );
    const read = FileSchema.parse(
      (
        await client.callTool({
          name: "file_read",
          arguments: { workspace_id: f.workspace.id, path: "README.md" },
        })
      ).structuredContent,
    );
    const request = {
      workspace_id: f.workspace.id,
      request_id: crypto.randomUUID(),
      summary: "更新 README",
      changes: [
        {
          operation: "edit",
          path: "README.md",
          expected_version: read.version,
          replacements: [
            {
              old_text: "Hello Kairomes",
              new_text: "Hello reviewed change",
              replace_all: false,
            },
          ],
        },
      ],
    };
    const pending = FileChangeResultSchema.parse(
      (await client.callTool({ name: "file_change_request", arguments: request }))
        .structuredContent,
    );
    expect(pending.change.state).toBe("pending");
    expect(JSON.stringify(pending)).not.toContain("fingerprint");
    expect(JSON.stringify(pending)).not.toContain(f.root);
    expect(await Bun.file(`${f.root}/README.md`).text()).toContain("Hello Kairomes");

    const pairedUrl = await (
      await post("/api/pairing/create", connection.adminToken, { extensionId })
    ).json();
    const fragment = new URLSearchParams(new URL(pairedUrl.pairingUrl).hash.slice(1));
    const panel = await (
      await post(
        "/api/panel/pair",
        "",
        { code: fragment.get("code"), instanceId: connection.instanceId },
        extensionOrigin,
      )
    ).json();
    const list = await (
      await post("/api/panel/approvals", panel.panelToken, { action: "list" }, extensionOrigin)
    ).json();
    const review = (list.changes as FileChangeApproval[]).find(
      (change) => change.id === pending.change.id,
    );
    expect(review?.diff).toContain("+Hello reviewed change");
    expect(review?.workspace_name).toBe("測試專案");
    expect(JSON.stringify(review)).not.toContain(f.root);
    const decision = {
      action: "approve",
      change_id: pending.change.id,
      fingerprint: review?.fingerprint,
    };
    for (const token of [connection.uiToken, connection.mcpToken, connection.adminToken])
      expect((await post("/api/panel/approvals", token, decision, extensionOrigin)).status).toBe(
        401,
      );
    expect(
      (await post("/api/panel/approvals", panel.panelToken, decision, connection.origin)).status,
    ).toBe(403);
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
      (await post("/api/panel/approvals", panel.panelToken, decision, extensionOrigin)).status,
    ).toBe(200);
    const applied = FileChangeResultSchema.parse(
      (
        await client.callTool({
          name: "file_change_poll",
          arguments: { change_id: pending.change.id },
        })
      ).structuredContent,
    );
    expect(applied.change.state).toBe("applied");
    expect(await Bun.file(`${f.root}/README.md`).text()).toContain("Hello reviewed change");
    expect(
      (await client.listTools()).tools.find((tool) => tool.name === "file_change_request")
        ?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: true,
    });
  } finally {
    await client.close();
    await app.close();
    await f.dispose();
  }
}, 15000);
