import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type ApprovalSession,
  type CommandApproval,
  CommandResultSchema,
  type FileChangeApproval,
  FileChangeResultSchema,
  FileSchema,
  McpCatalogSchema,
  TerminalResultSchema,
} from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startPreviewServer } from "../../../scripts/preview-sidebar.ts";
import { fixture } from "../../../tests/fixtures.ts";
import { McpHostManager } from "./mcp-host.ts";
import { startWorkbench } from "./preview.ts";
import { loadMcpResultWidget, loadWidget } from "./server.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

const f = await fixture();
const mcpFixturePath = fileURLToPath(new URL("./__fixtures__/read-mcp.ts", import.meta.url));
const previewMcp = new McpHostManager(f.state);
await previewMcp.addStdio({
  name: "Chrome DevTools Preview",
  command: process.execPath,
  args: [mcpFixturePath],
});
await previewMcp.close();
const previewImage = Buffer.from(
  await Bun.file(new URL("../../widget/assets/kairomes-k-128.png", import.meta.url)).arrayBuffer(),
);
await Bun.write(path.join(f.root, "kairomes-preview.png"), previewImage);
const html = await loadWidget();
const mcpResultHtml = await loadMcpResultWidget();
if (!html) throw new Error("Run bun run build first");
const app = await startWorkbench(f.registry, html, 0, undefined, { mcpResultHtml });
const connection = await readWorkbenchConnection(f.state);
const client = new Client({ name: "isolated-live-preview", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${connection.origin}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${connection.mcpToken}` } },
  }),
);
// The side panel pages are the maintained synthetic ones (scripts/preview-sidebar.ts: tokens,
// components, icon sprite and a swap that fails on markup drift). The live workbench sends
// frame-ancestors, so it is opened directly at its own URL instead of inside a page here.
const preview = await startPreviewServer();
console.log(
  `Isolated workbench: ${app.url}\nSynthetic side panel: ${preview.origin}/setup, ${preview.origin}/approvals, ${preview.origin}/settings (fixture data, not this workbench)\nCommands: read, search, artifact, mcp, change, change-applied, terminal, terminal-output, command, command-output, quit (fixture approvals stay in this test runner)`,
);
const lines = createInterface({ input: process.stdin });
try {
  for await (const line of lines) {
    const command = line.trim();
    if (command === "quit") break;
    if (command === "read")
      await client.callTool({
        name: "file_read",
        arguments: { workspace_id: f.workspace.id, path: "README.md", start_line: 2, max_lines: 2 },
      });
    if (command === "search")
      await client.callTool({
        name: "file_search",
        arguments: { workspace_id: f.workspace.id, query: "Kairomes" },
      });
    if (command === "artifact")
      await client.callTool({
        name: "artifact_preview",
        arguments: { workspace_id: f.workspace.id, path: "kairomes-preview.png" },
      });
    if (command === "mcp") {
      const catalog = McpCatalogSchema.parse(
        (
          await client.callTool({
            name: "mcp_catalog_search",
            arguments: { query: "lookup" },
          })
        ).structuredContent,
      );
      const tool = catalog.tools.find((item) => item.name === "lookup");
      if (!tool) throw new Error("MCP preview tool missing");
      await client.callTool({
        name: "mcp_read_call",
        arguments: {
          tool_ref: tool.ref,
          catalog_revision: catalog.catalog_revision,
          arguments: { query: "image" },
          request_id: crypto.randomUUID(),
        },
      });
    }
    if (command === "change" || command === "change-applied") {
      const read = FileSchema.parse(
        (
          await client.callTool({
            name: "file_read",
            arguments: { workspace_id: f.workspace.id, path: "README.md" },
          })
        ).structuredContent,
      );
      const result = FileChangeResultSchema.parse(
        (
          await client.callTool({
            name: "file_change_request",
            arguments: {
              workspace_id: f.workspace.id,
              request_id: crypto.randomUUID(),
              summary: "將 fixture 問候語改成 Kairomes 喵",
              changes: [
                {
                  operation: "edit",
                  path: "README.md",
                  expected_version: read.version,
                  replacements: [
                    {
                      old_text: "Hello Kairomes",
                      new_text: "Hello Kairomes 喵",
                      replace_all: false,
                    },
                  ],
                },
              ],
            },
          })
        ).structuredContent,
      );
      if (command === "change-applied") {
        const admin = async (body: unknown) => {
          const response = await fetch(`${connection.origin}/api/approvals`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: connection.origin,
              Authorization: `Bearer ${connection.adminToken}`,
            },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`Fixture approval failed: ${response.status}`);
          return response.json() as Promise<{ changes: FileChangeApproval[] }>;
        };
        const pending = (await admin({ action: "list" })).changes.find(
          (change) => change.id === result.change.id,
        );
        if (!pending) throw new Error("Fixture change missing");
        await admin({
          action: "approve",
          change_id: pending.id,
          fingerprint: pending.fingerprint,
        });
      }
    }
    if (command === "command" || command === "command-output") {
      const result = CommandResultSchema.parse(
        (
          await client.callTool({
            name: "command_request",
            arguments: {
              workspace_id: f.workspace.id,
              request_id: crypto.randomUUID(),
              argv: [
                "bun.cmd",
                "-e",
                "console.log('Kairomes 一次性命令測試 🐱'); console.error('這是 stderr 範例，不代表命令失敗'); await Bun.sleep(1500); console.log('所有步驟已完成');",
              ],
              timeout_ms: 5000,
            },
          })
        ).structuredContent,
      );
      if (command === "command-output") {
        // Test runner authorizes only its own harmless fixture command; no credentials reach the UI.
        const admin = async (body: unknown) => {
          const response = await fetch(`${connection.origin}/api/approvals`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: connection.origin,
              Authorization: `Bearer ${connection.adminToken}`,
            },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`Fixture approval failed: ${response.status}`);
          return response.json() as Promise<{ commands: CommandApproval[] }>;
        };
        const pending = (await admin({ action: "list" })).commands.find(
          (c) => c.id === result.command.id,
        );
        if (!pending) throw new Error("Fixture command missing");
        await admin({
          action: "approve",
          command_id: pending.id,
          fingerprint: pending.fingerprint,
        });
      }
    }
    if (command === "terminal" || command === "terminal-output") {
      const result = await client.callTool({
        name: "terminal_start",
        arguments: {
          workspace_id: f.workspace.id,
          shell: process.platform === "win32" ? "cmd" : "bash",
        },
      });
      if (command === "terminal-output") {
        // Explicit test-runner-only approval of this newly created fixture session.
        // Browser fixture has no access to these credentials or this control path.
        const terminal = TerminalResultSchema.parse(result.structuredContent);
        const admin = async (body: unknown) => {
          const response = await fetch(`${connection.origin}/api/approvals`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: connection.origin,
              Authorization: `Bearer ${connection.adminToken}`,
            },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`Fixture approval failed: ${response.status}`);
          return response.json() as Promise<{ sessions: ApprovalSession[] }>;
        };
        const pending = (await admin({ action: "list" })).sessions.find(
          (s) => s.id === terminal.session.id,
        );
        if (!pending) throw new Error("Fixture session missing");
        await admin({
          action: "approve",
          session_id: pending.id,
          fingerprint: pending.fingerprint,
        });
        await client.callTool({
          name: "terminal_input",
          arguments: {
            session_id: pending.id,
            input_id: crypto.randomUUID(),
            data:
              process.platform === "win32"
                ? "for /L %i in (1,1,80) do @echo Kairomes viewport test row %i\r"
                : "for i in $(seq 1 80); do echo Kairomes viewport test row $i; done\r",
          },
        });
      }
    }
    console.log(`Fixture action completed: ${command}`);
  }
} finally {
  lines.close();
  await client.close();
  await preview.stop();
  await app.close();
  await f.dispose();
}
