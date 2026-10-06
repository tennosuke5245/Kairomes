import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArtifactSchema,
  FileSchema,
  GitStatusSchema,
  MCP_RESULT_URI,
  StatusSchema,
  TerminalResultSchema,
  VERSION,
  WIDGET_URI,
} from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fixture } from "../../../tests/fixtures.ts";
import { startPreview } from "./preview.ts";
import { createMcpServer, loadMcpResultWidget, loadWidget } from "./server.ts";
import { ToolService } from "./tools.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.dispose();
});

async function connect() {
  const html = await loadWidget();
  const mcpResultHtml = await loadMcpResultWidget();
  if (!html || !mcpResultHtml) throw new Error("Run bun run build before tests");
  const server = createMcpServer(f.registry, html, undefined, undefined, mcpResultHtml);
  const client = new Client({ name: "kairomes-tests", version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP contracts", () => {
  test("stdio terminal request, separate local approval, input, output and shutdown", async () => {
    const client = new Client({ name: "terminal-stdio", version: VERSION });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)),
        "serve",
        "--data-dir",
        f.state,
      ],
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    try {
      await client.connect(transport, { timeout: 5000 });
      const start = await client.callTool({
        name: "terminal_start",
        arguments: {
          workspace_id: f.workspace.id,
          shell: process.platform === "win32" ? "cmd" : "bash",
        },
      });
      const { session } = TerminalResultSchema.parse(start.structuredContent);
      expect(session.state).toBe("pending");
      const adminLink = stderr.match(
        /http:\/\/127\.0\.0\.1:\d+\/approvals#session=[a-f0-9]{64}/,
      )?.[0];
      if (!adminLink) throw new Error("Local approval URL not emitted on stderr");
      const admin = new URL(adminLink);
      const headers = {
        "Content-Type": "application/json",
        Origin: admin.origin,
        Authorization: `Bearer ${new URLSearchParams(admin.hash.slice(1)).get("session")}`,
      };
      const endpoint = `${admin.origin}/api/approvals`;
      const listing = await (
        await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ action: "list" }) })
      ).json();
      const review = listing.sessions.find((item: { id: string }) => item.id === session.id);
      const approve = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "approve",
          session_id: session.id,
          fingerprint: review.fingerprint,
        }),
      });
      expect(approve.status).toBe(200);
      const entered = await client.callTool({
        name: "terminal_input",
        arguments: {
          session_id: session.id,
          input_id: crypto.randomUUID(),
          data: `echo KAIROMES_MCP_FLOW${process.platform === "win32" ? "\r" : "\n"}`,
        },
      });
      expect(entered.isError).not.toBe(true);
      let text = "";
      let cursor = 0;
      const deadline = Date.now() + 5000;
      const outputSeen = () => /\nKAIROMES_MCP_FLOW/.test(text.replaceAll("\r", ""));
      while (!outputSeen() && Date.now() < deadline) {
        const result = await client.callTool({
          name: "terminal_poll",
          arguments: { session_id: session.id, cursor },
        });
        const page = TerminalResultSchema.parse(result.structuredContent);
        text += page.text;
        cursor = page.cursor;
        if (!outputSeen()) await Bun.sleep(25);
      }
      expect(outputSeen()).toBe(true);
      const stopped = await client.callTool({
        name: "terminal_stop",
        arguments: { session_id: session.id },
      });
      expect(TerminalResultSchema.parse(stopped.structuredContent).session.state).toBe("stopped");
    } finally {
      await client.close();
      await transport.close();
    }
  }, 15000);
  test("limits concurrent reads and releases the slot after completion", async () => {
    const service = new ToolService(f.registry, true);
    const reads = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.call("file_read", {
          workspace_id: f.workspace.id,
          path: "README.md",
        }),
      ),
    );
    expect(reads.filter((result) => result.isError).length).toBe(1);
    expect(JSON.stringify(reads)).toContain("BUSY");
    expect(
      (await service.call("file_read", { workspace_id: f.workspace.id, path: "README.md" }))
        .isError,
    ).not.toBe(true);
  });
  test("handshake, bounded tool surface and UI resource", async () => {
    const c = await connect();
    try {
      const { tools } = await c.client.listTools();
      expect(tools.length).toBe(28);
      expect(
        tools
          .filter(
            (tool) =>
              !tool.name.startsWith("terminal_") &&
              ![
                "command_request",
                "command_cancel",
                "file_change_request",
                "file_change_cancel",
                "mcp_tool_call",
              ].includes(tool.name),
          )
          .every((tool) => tool.annotations?.readOnlyHint === true),
      ).toBe(true);
      expect(tools.find((tool) => tool.name === "terminal_input")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
      for (const name of ["git_status", "git_diff", "git_log"]) {
        expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
      const gitStatus = await c.client.callTool({
        name: "git_status",
        arguments: { workspace_id: f.workspace.id },
      });
      expect(GitStatusSchema.parse(gitStatus.structuredContent)).toMatchObject({
        state: "unavailable",
        reason: "not_repository",
      });
      expect(JSON.stringify(gitStatus)).not.toContain(f.root);
      expect(tools.some((tool) => tool.name.includes("approve"))).toBe(false);
      expect(tools.some((tool) => tool.name.startsWith("artifact_import_"))).toBe(false);
      expect(
        tools
          .filter((tool) => (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri)
          .map((tool) => [
            tool.name,
            (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri,
          ])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ).toEqual([
        ["artifact_preview", MCP_RESULT_URI],
        ["mcp_read_call", MCP_RESULT_URI],
        ["mcp_tool_call", MCP_RESULT_URI],
        ["workbench_open", WIDGET_URI],
      ]);
      for (const name of ["artifact_preview", "mcp_read_call", "mcp_tool_call"]) {
        expect(tools.find((tool) => tool.name === name)?._meta?.["openai/outputTemplate"]).toBe(
          MCP_RESULT_URI,
        );
      }
      const resource = await c.client.readResource({ uri: WIDGET_URI });
      expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      const first = resource.contents[0];
      expect(first && "text" in first ? first.text : "").toContain('id="root"');
      expect(first?._meta).toMatchObject({
        ui: {
          prefersBorder: false,
          csp: { connectDomains: [], resourceDomains: [] },
        },
      });
      const mcpResultResource = await c.client.readResource({ uri: MCP_RESULT_URI });
      expect(mcpResultResource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      const mcpResultFirst = mcpResultResource.contents[0];
      expect(mcpResultFirst && "text" in mcpResultFirst ? mcpResultFirst.text : "").toContain(
        'id="root"',
      );
      expect(mcpResultFirst?._meta).toMatchObject({
        ui: {
          prefersBorder: false,
          csp: { connectDomains: [], resourceDomains: [] },
        },
      });
      const listing = await c.client.callTool({ name: "workspace_list", arguments: {} });
      expect(listing.structuredContent).toEqual({ kind: "workspaces", workspaces: [f.workspace] });
      expect(JSON.stringify(listing)).not.toContain(f.root);
    } finally {
      await c.close();
    }
  });

  test("returns a verified workspace image to the MCP model content", async () => {
    await writeFile(path.join(f.root, "preview.png"), onePixelPng);
    const c = await connect();
    try {
      const result = await c.client.callTool({
        name: "artifact_preview",
        arguments: { workspace_id: f.workspace.id, path: "preview.png" },
      });
      expect(ArtifactSchema.parse(result.structuredContent)).toMatchObject({
        path: "preview.png",
        mime_type: "image/png",
        width: 1,
        height: 1,
      });
      const content = result.content as Array<{
        type: string;
        data?: string;
        mimeType?: string;
      }>;
      const image = content.find((item) => item.type === "image");
      expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(image?.data ? Buffer.from(image.data, "base64") : undefined).toEqual(onePixelPng);
    } finally {
      await c.close();
    }
  });

  test("SDK enforces schemas and tool errors never expose local paths", async () => {
    const c = await connect();
    try {
      const invalid = await c.client.callTool({
        name: "file_read",
        arguments: { workspace_id: f.workspace.id, path: "README.md", max_lines: 9999 },
      });
      expect(invalid.isError).toBe(true);
      const denied = await c.client.callTool({
        name: "file_read",
        arguments: { workspace_id: f.workspace.id, path: "../outside.txt" },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).not.toContain(f.root);
      const read = await c.client.callTool({
        name: "file_read",
        arguments: { workspace_id: f.workspace.id, path: "README.md", max_lines: 1 },
      });
      const data = FileSchema.parse(read.structuredContent);
      expect(data.content).toBe("# Fixture");
      expect(data.next_line).toBe(2);
    } finally {
      await c.close();
    }
  });

  test("actual Bun stdio process initializes, responds and shuts down", async () => {
    const client = new Client({ name: "stdio-integration", version: VERSION });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)),
        "serve",
        "--data-dir",
        f.state,
      ],
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport, { timeout: 5000 });
      expect((await client.listTools()).tools.length).toBe(28);
      const result = await client.callTool({ name: "kairomes_status", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(StatusSchema.parse(result.structuredContent).mounted_workspaces).toBe(1);
    } finally {
      await client.close();
      await transport.close();
    }
  });
});

describe("loopback preview boundary", () => {
  test("requires same origin and session token; only serves explicit routes", async () => {
    const preview = startPreview(
      f.registry,
      '<html><head><!--KAIROMES_MODE--></head><body><div id="root"></div><script>window.test=true;</script></body></html>',
      0,
    );
    const url = new URL(preview.url);
    const token = new URLSearchParams(url.hash.slice(1)).get("session");
    const endpoint = `${url.origin}/api/tools`;
    const body = JSON.stringify({ name: "workspace_list", arguments: {} });
    try {
      const page = await fetch(url.origin);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(await page.text()).not.toContain(f.root);
      const headers = { "Content-Type": "application/json", Origin: url.origin };
      expect((await fetch(endpoint, { method: "POST", headers, body })).status).toBe(401);
      expect(
        (
          await fetch(endpoint, {
            method: "POST",
            headers: {
              ...headers,
              Origin: "https://attacker.example",
              Authorization: `Bearer ${token}`,
            },
            body,
          })
        ).status,
      ).toBe(403);
      const valid = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body,
      });
      expect((await valid.json()).structuredContent.workspaces).toEqual([f.workspace]);
      expect((await fetch(`${url.origin}/state.sqlite`)).status).toBe(404);
      expect((await fetch(`${url.origin}/`, { headers: { Host: "evil.example" } })).status).toBe(
        403,
      );
      const unknown = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "terminal_approve", arguments: {} }),
      });
      expect(unknown.status).toBe(404);
    } finally {
      await preview.close();
    }
  });
});
