import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "../../../tests/fixtures.ts";
import { McpHostManager } from "./mcp-host.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let managers: McpHostManager[];

beforeEach(async () => {
  f = await fixture();
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
  await f.dispose();
});

async function configured() {
  const manager = new McpHostManager(f.state);
  managers.push(manager);
  const fixturePath = fileURLToPath(new URL("./__fixtures__/read-mcp.ts", import.meta.url));
  const config = await manager.addStdio({
    name: "Read fixture",
    command: process.execPath,
    args: [fixturePath],
  });
  await manager.refresh(config.id);
  return { manager, config, fixturePath };
}

describe("downstream MCP broker", () => {
  test("trusts a newly mounted server by default without exposing launch configuration", async () => {
    const { manager, config, fixturePath } = await configured();
    const catalog = await manager.catalog({ query: "", limit: 30, refresh: false });

    expect(catalog.servers).toEqual([
      expect.objectContaining({
        id: config.id,
        name: "Read fixture",
        enabled: true,
        state: "ready",
        tool_count: 2,
        enabled_tool_count: 2,
      }),
    ]);
    expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(["lookup", "mutate"]);
    expect(catalog.tools.every((tool) => tool.enabled && tool.availability === "ready")).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain(fixturePath);
    expect(JSON.stringify(catalog)).not.toContain(process.execPath);
  });

  test("calls trusted action tools, enforces the read-only route and forwards images", async () => {
    const { manager, config } = await configured();
    const catalog = await manager.catalog({ query: "", limit: 10, refresh: false });
    const lookup = catalog.tools.find((tool) => tool.name === "lookup");
    const mutate = catalog.tools.find((tool) => tool.name === "mutate");
    if (!lookup || !mutate) throw new Error("fixture tools were not discovered");

    const described = await manager.describe(lookup.ref);
    expect(described.tool.input_schema).toMatchObject({
      type: "object",
      required: ["query"],
    });

    const requestId = crypto.randomUUID();
    const result = await manager.call({
      tool_ref: lookup.ref,
      catalog_revision: catalog.catalog_revision,
      arguments: { query: "喵" },
      request_id: requestId,
    });
    expect(result).toMatchObject({
      kind: "mcp_call",
      request_id: requestId,
      is_error: false,
      content: [{ type: "text", text: "fixture:喵" }],
      structured_content: { echoed: "喵" },
      truncated: false,
    });
    expect(
      await manager.call({
        tool_ref: lookup.ref,
        catalog_revision: catalog.catalog_revision,
        arguments: { query: "喵" },
        request_id: requestId,
      }),
    ).toEqual(result);

    const screenshot = await manager.callWithMedia(
      {
        tool_ref: lookup.ref,
        catalog_revision: catalog.catalog_revision,
        arguments: { query: "image" },
        request_id: crypto.randomUUID(),
      },
      true,
    );
    expect(screenshot.data.content).toEqual([
      {
        type: "image",
        media_id: expect.any(String),
        mime_type: "image/png",
        byte_length: 68,
        width: 1,
        height: 1,
      },
    ]);
    expect(screenshot.images).toEqual([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        mediaId: expect.any(String),
      }),
    ]);
    expect(screenshot.data.arguments_preview).toEqual({ query: "image" });
    expect(screenshot.data.duration_ms).toBeGreaterThanOrEqual(0);
    const mediaId =
      screenshot.data.content[0]?.type === "image" ? screenshot.data.content[0].media_id : "";
    expect(manager.media(mediaId)).toMatchObject({ mimeType: "image/png" });
    expect(JSON.stringify(screenshot.data)).not.toContain("iVBORw0KGgo");

    const mutation = await manager.call({
      tool_ref: mutate.ref,
      catalog_revision: catalog.catalog_revision,
      arguments: { value: "run" },
      request_id: crypto.randomUUID(),
    });
    expect(mutation.content).toEqual([{ type: "text", text: "must not be called" }]);
    await expect(
      manager.callWithMedia(
        {
          tool_ref: mutate.ref,
          catalog_revision: catalog.catalog_revision,
          arguments: { value: "compatibility check" },
          request_id: crypto.randomUUID(),
        },
        true,
      ),
    ).rejects.toThrow("未明確宣告為唯讀");

    const hiddenLocalResource = await manager.call({
      tool_ref: lookup.ref,
      catalog_revision: catalog.catalog_revision,
      arguments: { query: "local-link" },
      request_id: crypto.randomUUID(),
    });
    expect(hiddenLocalResource).toMatchObject({
      content: [{ type: "text", text: "下游 MCP 回傳了不安全的資源連結；內容已省略。" }],
      truncated: true,
    });
    expect(JSON.stringify(hiddenLocalResource)).not.toContain("C:/Users/example");

    await manager.setToolEnabled(config.id, "mutate", false);
    const disabled = await manager.catalog({ query: "mutate", limit: 10, refresh: false });
    expect(disabled.tools[0]).toMatchObject({ enabled: false, availability: "disabled" });
    await expect(
      manager.call({
        tool_ref: mutate.ref,
        catalog_revision: disabled.catalog_revision,
        arguments: { value: "blocked" },
        request_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow("本機使用者停用");
  });

  test("validates arguments and stale revisions, then persists tool and server switches", async () => {
    const { manager, config } = await configured();
    const catalog = await manager.catalog({ query: "lookup", limit: 10, refresh: false });
    const tool = catalog.tools[0];
    if (!tool) throw new Error("lookup was not discovered");

    await expect(
      manager.call({
        tool_ref: tool.ref,
        catalog_revision: "stale",
        arguments: { query: "test" },
        request_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow("MCP 目錄已變更");
    await expect(
      manager.call({
        tool_ref: tool.ref,
        catalog_revision: catalog.catalog_revision,
        arguments: {},
        request_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow("參數不符合");

    await manager.setToolEnabled(config.id, "lookup", false);
    await manager.close();
    managers = managers.filter((item) => item !== manager);
    const restored = new McpHostManager(f.state);
    managers.push(restored);
    const next = await restored.catalog({ query: "lookup", limit: 10, refresh: false });
    expect(next.tools[0]).toMatchObject({
      name: "lookup",
      enabled: false,
      availability: "disabled",
    });

    await restored.setServerEnabled(config.id, false);
    const disabledServer = await restored.panelState();
    expect(disabledServer.servers[0]).toMatchObject({ enabled: false, state: "disconnected" });
    expect(
      (await restored.catalog({ query: "", limit: 10, refresh: false })).servers[0],
    ).toMatchObject({ enabled: false, enabled_tool_count: 0 });
    await restored.setServerEnabled(config.id, true);
    const reconnected = await restored.panelState();
    expect(reconnected.servers[0]).toMatchObject({ enabled: true, state: "ready" });
    expect(reconnected.servers[0]?.tools.find((item) => item.name === "lookup")?.enabled).toBe(
      false,
    );

    const saved = JSON.parse(await readFile(path.join(f.state, "mcp-servers.json"), "utf8"));
    expect(saved.servers[0]).toMatchObject({ enabled: true, disabled_tools: ["lookup"] });
  });

  test("does not follow redirects from an HTTP MCP", async () => {
    let redirectedRequests = 0;
    let targetPort = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        if (new URL(request.url).pathname === "/redirected") {
          redirectedRequests++;
          return new Response("must not be reached");
        }
        return Response.redirect(`http://127.0.0.1:${targetPort}/redirected`, 307);
      },
    });
    const boundPort = target.port;
    if (!boundPort) {
      target.stop(true);
      throw new Error("Redirect fixture did not bind a TCP port");
    }
    targetPort = boundPort;
    try {
      const manager = new McpHostManager(f.state);
      managers.push(manager);
      const config = await manager.addHttp({
        name: "Redirect fixture",
        url: `http://127.0.0.1:${target.port}/mcp`,
      });
      await manager.refresh(config.id);
      expect((await manager.localState())[0]?.state).toBe("unavailable");
      expect(redirectedRequests).toBe(0);
    } finally {
      target.stop(true);
    }
  });
});
