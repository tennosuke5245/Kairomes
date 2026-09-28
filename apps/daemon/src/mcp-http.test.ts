import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { McpCallSchema, McpCatalogSchema, McpPanelStateSchema } from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture } from "../../../tests/fixtures.ts";
import { startWorkbench } from "./preview.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

test("trusted sidebar mounts an MCP while the fixed ChatGPT broker schema stays connected", async () => {
  const f = await fixture();
  const extensionId = "a".repeat(32);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const app = await startWorkbench(
    f.registry,
    "<html><head><!--KAIROMES_MODE--></head></html>",
    0,
    extensionId,
  );
  const client = new Client({ name: "mcp-broker-http-test", version: "1" });
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
    const initialTools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(initialTools).toContain("mcp_catalog_search");
    expect(initialTools).toContain("mcp_tool_call");
    expect(initialTools).toContain("mcp_read_call");

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
    for (const token of [connection.uiToken, connection.mcpToken, connection.adminToken])
      expect(
        (await post("/api/panel/mcp", token, { action: "list" }, extensionOrigin)).status,
      ).toBe(401);
    expect((await post("/api/panel/mcp", panel.panelToken, { action: "list" })).status).toBe(403);

    const fixturePath = fileURLToPath(new URL("./__fixtures__/read-mcp.ts", import.meta.url));
    const mounted = McpPanelStateSchema.parse(
      await (
        await post(
          "/api/panel/mcp",
          panel.panelToken,
          {
            action: "add_stdio",
            name: "Sidebar fixture",
            command: process.execPath,
            args: [fixturePath],
          },
          extensionOrigin,
        )
      ).json(),
    );
    expect(mounted.servers[0]).toMatchObject({
      name: "Sidebar fixture",
      enabled: true,
      state: "ready",
      tools: expect.arrayContaining([expect.objectContaining({ name: "lookup", enabled: true })]),
    });
    const serverId = mounted.servers[0]?.id;
    if (!serverId) throw new Error("MCP server was not mounted");

    const disabled = McpPanelStateSchema.parse(
      await (
        await post(
          "/api/panel/mcp",
          panel.panelToken,
          {
            action: "set_tool_enabled",
            server_id: serverId,
            tool_name: "mutate",
            enabled: false,
          },
          extensionOrigin,
        )
      ).json(),
    );
    expect(disabled.servers[0]?.tools.find((tool) => tool.name === "mutate")?.enabled).toBe(false);

    const catalog = McpCatalogSchema.parse(
      (
        await client.callTool({
          name: "mcp_catalog_search",
          arguments: { query: "lookup" },
        })
      ).structuredContent,
    );
    const tool = catalog.tools[0];
    if (!tool) throw new Error("Enabled tool missing from catalog");
    const called = McpCallSchema.parse(
      (
        await client.callTool({
          name: "mcp_tool_call",
          arguments: {
            tool_ref: tool.ref,
            catalog_revision: catalog.catalog_revision,
            arguments: { query: "live" },
            request_id: crypto.randomUUID(),
          },
        })
      ).structuredContent,
    );
    expect(called.content).toEqual([{ type: "text", text: "fixture:live" }]);
    const screenshot = await client.callTool({
      name: "mcp_read_call",
      arguments: {
        tool_ref: tool.ref,
        catalog_revision: catalog.catalog_revision,
        arguments: { query: "image" },
        request_id: crypto.randomUUID(),
      },
    });
    const screenshotData = McpCallSchema.parse(screenshot.structuredContent);
    expect(screenshotData.content).toEqual([
      expect.objectContaining({ type: "image", mime_type: "image/png", width: 1, height: 1 }),
    ]);
    expect(JSON.stringify(screenshotData)).not.toContain("iVBORw0KGgo");
    expect(
      (screenshot.content as Array<{ type: string; mimeType?: string }>).some(
        (item) => item.type === "image" && item.mimeType === "image/png",
      ),
    ).toBe(true);
    const image = screenshotData.content.find((item) => item.type === "image");
    if (image?.type !== "image") throw new Error("Expected cached MCP image metadata");
    const media = await post(
      "/api/mcp/media",
      connection.uiToken,
      { media_id: image.media_id },
      connection.origin,
    );
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/png");
    expect((await media.arrayBuffer()).byteLength).toBe(68);
    expect(
      (await post("/api/mcp/media", connection.mcpToken, { media_id: image.media_id })).status,
    ).toBe(401);
    expect((await client.listTools()).tools.map((item) => item.name)).toEqual(initialTools);
  } finally {
    await client.close();
    await app.close();
    await f.dispose();
  }
}, 15000);
