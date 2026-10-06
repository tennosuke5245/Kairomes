import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TerminalListSchema, TerminalResultSchema, WIDGET_URI } from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../../../tests/fixtures.ts";
import { startWorkbench } from "./preview.ts";
import { loadWidget } from "./server.ts";
import { readWorkbenchConnection, verifyWorkbenchConnection } from "./workbench-connection.ts";

const minimalHtml = "<html><head><!--KAIROMES_MODE--></head><body>Workbench</body></html>";

test("connection descriptor rejects malformed, oversized and non-loopback destinations", async () => {
  const f = await fixture();
  try {
    const file = `${f.state}/workbench-connection.json`;
    const base = {
      instanceId: crypto.randomUUID(),
      pid: process.pid,
      uiToken: "a".repeat(64),
      mcpToken: "b".repeat(64),
      adminToken: "c".repeat(64),
    };
    for (const origin of [
      "https://example.com",
      "http://127.0.0.1:4318/approvals",
      "http://127.0.0.1:4318@evil.example",
      "http://2130706433:4318",
    ]) {
      await writeFile(file, JSON.stringify({ ...base, origin }));
      await expect(readWorkbenchConnection(f.state)).rejects.toMatchObject({
        code: "WORKBENCH_UNAVAILABLE",
      });
    }
    await writeFile(file, "x".repeat(4097));
    await expect(readWorkbenchConnection(f.state)).rejects.toMatchObject({
      code: "WORKBENCH_UNAVAILABLE",
    });
    await writeFile(file, "{");
    await expect(readWorkbenchConnection(f.state)).rejects.toMatchObject({
      code: "WORKBENCH_UNAVAILABLE",
    });
  } finally {
    await f.dispose();
  }
});

test("workbench defaults to no embedding and rejects stale instance identity", async () => {
  const f = await fixture();
  const app = await startWorkbench(f.registry, minimalHtml, 0);
  try {
    const c = await readWorkbenchConnection(f.state);
    const page = await fetch(c.origin);
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('<meta name="kairomes-parent-origin" content="">');
    await expect(
      verifyWorkbenchConnection({ ...c, instanceId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "WORKBENCH_UNAVAILABLE" });
  } finally {
    await app.close();
    await f.dispose();
  }
});

test("a stale descriptor with a recycled live PID is replaced by a verified new workbench", async () => {
  const f = await fixture();
  const previous = {
    instanceId: crypto.randomUUID(),
    pid: process.pid,
    origin: "http://127.0.0.1:65535",
    uiToken: "a".repeat(64),
    mcpToken: "b".repeat(64),
    adminToken: "c".repeat(64),
  };
  await writeFile(`${f.state}/workbench-connection.json`, JSON.stringify(previous));
  const app = await startWorkbench(f.registry, minimalHtml, 0);
  try {
    const current = await readWorkbenchConnection(f.state);
    expect(current.instanceId).not.toBe(previous.instanceId);
    await verifyWorkbenchConnection(current);
  } finally {
    await app.close();
    await f.dispose();
  }
});

test("web workbench has no chat backend; MCP/UI/admin authority and frame boundaries stay separate", async () => {
  const f = await fixture();
  const extensionId = "a".repeat(32);
  const app = await startWorkbench(f.registry, minimalHtml, 0, extensionId);
  try {
    const c = await readWorkbenchConnection(f.state);
    await verifyWorkbenchConnection(c);
    const request = (
      route: string,
      token: string,
      origin: string | null = c.origin,
      more: Record<string, string> = {},
    ) =>
      fetch(`${c.origin}${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
          ...(origin === null ? {} : { Origin: origin }),
          ...more,
        },
        body: JSON.stringify({ action: "list" }),
      });
    const page = await fetch(c.origin);
    const pageHtml = await page.text();
    expect(pageHtml).toContain('content="workbench"');
    expect(pageHtml).toContain(
      `<meta name="kairomes-parent-origin" content="chrome-extension://${extensionId}">`,
    );
    expect(pageHtml).not.toContain(c.adminToken);
    expect(pageHtml).not.toContain(c.mcpToken);
    expect(page.headers.get("Content-Security-Policy")).toContain(
      `frame-ancestors chrome-extension://${extensionId}`,
    );
    expect((await fetch(`${c.origin}/approvals`)).headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect((await request("/api/chat", c.uiToken)).status).toBe(404);
    expect((await request("/api/approvals", c.mcpToken)).status).toBe(401);
    expect((await request("/api/tools", c.mcpToken)).status).toBe(401);
    expect((await request("/api/mcp", c.uiToken, null)).status).toBe(401);
    expect((await request("/api/mcp", c.adminToken, null)).status).toBe(401);
    expect((await request("/api/mcp", c.mcpToken, "https://evil.example")).status).toBe(403);
    expect((await request("/api/mcp", c.mcpToken, null, { Host: "evil.example" })).status).toBe(
      403,
    );
    expect(
      (await request("/api/mcp", c.mcpToken, null, { "Content-Type": "text/plain" })).status,
    ).toBe(415);
    expect((await request("/api/connection", c.uiToken, null)).status).toBe(403);
    const status = await (await request("/api/connection", c.uiToken)).json();
    expect(status).toEqual({ mode: "workbench", instanceId: c.instanceId, lastMcpRequestAt: null });
    expect(JSON.stringify(status)).not.toContain(c.mcpToken);
    await expect(startWorkbench(f.registry, minimalHtml, 0)).rejects.toMatchObject({
      code: "WORKBENCH_RUNNING",
    });
    expect((await readWorkbenchConnection(f.state)).instanceId).toBe(c.instanceId);
    await expect(startWorkbench(f.registry, minimalHtml, 0, "bad-id")).rejects.toMatchObject({
      code: "USAGE",
    });
    expect(await Bun.file(`${f.state}/codex/auth.json`).exists()).toBe(false);
  } finally {
    await app.close();
    await f.dispose();
  }
}, 10000);

test("real stdio attach relay and sidebar share pending terminals, resources and lifetime", async () => {
  const f = await fixture();
  const html = await loadWidget();
  if (!html) throw new Error("Build widget first");
  const app = await startWorkbench(f.registry, html, 0);
  const client = new Client({ name: "attached-relay-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)),
      "serve",
      "--attach",
      "--stdio",
      "--data-dir",
      f.state,
    ],
    stderr: "pipe",
  });
  try {
    const c = await readWorkbenchConnection(f.state);
    await client.connect(transport, { timeout: 7000 });
    expect((await client.listTools()).tools).toHaveLength(30);
    expect((await client.readResource({ uri: WIDGET_URI })).contents[0]).toHaveProperty(
      "text",
      html,
    );
    const started = await client.callTool({
      name: "terminal_start",
      arguments: {
        workspace_id: f.workspace.id,
        shell: process.platform === "win32" ? "cmd" : "bash",
      },
    });
    const session = TerminalResultSchema.parse(started.structuredContent).session;
    expect(session.state).toBe("pending");
    const local = async (name: string, args = {}) =>
      (
        await fetch(`${c.origin}/api/tools`, {
          method: "POST",
          headers: {
            Origin: c.origin,
            "Content-Type": "application/json",
            Authorization: `Bearer ${c.uiToken}`,
          },
          body: JSON.stringify({ name, arguments: args }),
        })
      ).json();
    const listed = TerminalListSchema.parse((await local("terminal_list")).structuredContent);
    expect(listed.sessions.find((item) => item.id === session.id)?.state).toBe("pending");
    // Closing each stateless request must not close the shared TerminalManager.
    const polled = await client.callTool({
      name: "terminal_poll",
      arguments: { session_id: session.id, cursor: 0 },
    });
    expect(TerminalResultSchema.parse(polled.structuredContent).session.state).toBe("pending");
    await client.close();
    await transport.close();
    expect(
      TerminalListSchema.parse((await local("terminal_list")).structuredContent).sessions,
    ).toHaveLength(1);
    const evidence = await (
      await fetch(`${c.origin}/api/connection`, {
        method: "POST",
        headers: {
          Origin: c.origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.uiToken}`,
        },
        body: "{}",
      })
    ).json();
    expect(evidence.lastMcpRequestAt).toBeString();
    expect(evidence).not.toHaveProperty("chatgptConnected");
    await local("terminal_stop", { session_id: session.id });
    await app.close();
    await expect(readWorkbenchConnection(f.state)).rejects.toMatchObject({
      code: "WORKBENCH_UNAVAILABLE",
    });
  } finally {
    await client.close();
    await transport.close();
    await app.close();
    await f.dispose();
  }
}, 15000);
