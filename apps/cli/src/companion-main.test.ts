import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWorkbench } from "@kairomes/daemon";
import { VERSION } from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "../../../tests/fixtures.ts";

const entry = fileURLToPath(new URL("./companion-main.ts", import.meta.url));
const minimalHtml = "<html><head><!--KAIROMES_MODE--></head><body>Workbench</body></html>";
const packagedRuntime = process.env.KAIROMES_TEST_PACKAGED_RUNTIME;

function runtimeCommand(args: string[]): { command: string; args: string[] } {
  return packagedRuntime
    ? { command: packagedRuntime, args }
    : { command: process.execPath, args: [entry, ...args] };
}

test("packaged runtime entry serves the attached MCP relay without starting Companion", async () => {
  const f = await fixture();
  const app = await startWorkbench(f.registry, minimalHtml, 0);
  const transport = new StdioClientTransport({
    ...runtimeCommand(["relay", "--stdio", "--data-dir", f.state]),
    env: { ...process.env, CONTROL_PLANE_API_KEY: "unused-test-key" },
    stderr: "pipe",
  });
  const client = new Client({ name: "kairomes-packaged-relay-test", version: VERSION });
  try {
    await client.connect(transport, { timeout: 7000 });
    const tools = (await client.listTools({}, { timeout: 7000 })).tools.map((tool) => tool.name);
    expect(tools).toContain("workspace_list");
    expect(tools).toContain("file_search");
    await expect(access(path.join(f.state, "companion-connection.json"))).rejects.toThrow();
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await app.close();
    await f.dispose();
  }
}, 15000);

test("relay mode rejects missing stdio flag on stderr without writing a Companion startup log", async () => {
  const f = await fixture();
  try {
    const { command, args } = runtimeCommand(["relay", "--data-dir", f.state]);
    const child = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CONTROL_PLANE_API_KEY: "unused-test-key" },
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("USAGE");
    expect(stderr).not.toContain("unused-test-key");
    await expect(access(path.join(f.state, "companion-startup-error.txt"))).rejects.toThrow();
  } finally {
    await f.dispose();
  }
});
