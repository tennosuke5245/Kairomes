import { expect, test } from "bun:test";
import {
  type FileChangeApproval,
  FileChangeListSchema,
  FileChangeResultSchema,
  FileSchema,
} from "@kairomes/protocol";
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
    expect((await client.listTools()).tools).toHaveLength(34);

    // Revert: only the paired panel creates one, and only for the record it was shown.
    const appliedReview = (
      (
        await (
          await post("/api/panel/approvals", panel.panelToken, { action: "list" }, extensionOrigin)
        ).json()
      ).changes as FileChangeApproval[]
    ).find((change) => change.id === pending.change.id);
    const revert = {
      action: "revert",
      change_id: pending.change.id,
      request_id: crypto.randomUUID(),
      fingerprint: appliedReview?.fingerprint,
    };
    for (const token of [connection.uiToken, connection.mcpToken, connection.adminToken])
      expect((await post("/api/panel/approvals", token, revert, extensionOrigin)).status).toBe(401);
    expect(
      (await post("/api/panel/approvals", panel.panelToken, revert, connection.origin)).status,
    ).toBe(403);
    const wrong = await post(
      "/api/panel/approvals",
      panel.panelToken,
      { ...revert, fingerprint: "0".repeat(64) },
      extensionOrigin,
    );
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe("APPROVAL_MISMATCH");
    const admin = await post("/api/approvals", connection.adminToken, revert);
    expect(admin.status).toBe(400);
    expect((await admin.json()).code).toBe("REVERT_PANEL_ONLY");
    const listed = FileChangeListSchema.parse(
      (await client.callTool({ name: "file_change_list", arguments: {} })).structuredContent,
    );
    expect(listed.changes).toHaveLength(1);

    const created = await post("/api/panel/approvals", panel.panelToken, revert, extensionOrigin);
    expect(created.status).toBe(200);
    const snapshot = await created.json();
    const inverse = (snapshot.changes as FileChangeApproval[]).find(
      (change) => change.id === snapshot.revert_change_id,
    );
    expect(inverse).toMatchObject({
      state: "pending",
      reverts_change_id: pending.change.id,
      summary: "復原：更新 README",
    });
    expect(inverse?.diff).toContain("-Hello reviewed change\n+Hello Kairomes");
    // Creating the revert approves nothing; the same request_id returns the same change.
    expect(await Bun.file(`${f.root}/README.md`).text()).toContain("Hello reviewed change");
    const retried = await (
      await post("/api/panel/approvals", panel.panelToken, revert, extensionOrigin)
    ).json();
    expect(retried.revert_change_id).toBe(snapshot.revert_change_id);
    expect(
      (
        await post(
          "/api/panel/approvals",
          panel.panelToken,
          { action: "approve", change_id: inverse?.id, fingerprint: inverse?.fingerprint },
          extensionOrigin,
        )
      ).status,
    ).toBe(200);
    expect(await Bun.file(`${f.root}/README.md`).text()).toContain("Hello Kairomes");
  } finally {
    await client.close();
    await app.close();
    await f.dispose();
  }
}, 15000);
