import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fixture } from "../../../tests/fixtures.ts";
import { createMcpServer, loadWidget } from "./server.ts";

test("ChatGPT-to-local image import stays off the public MCP surface", async () => {
  const f = await fixture();
  const html = await loadWidget();
  if (!html) throw new Error("Run bun run build before tests");
  const server = createMcpServer(f.registry, html);
  const client = new Client({ name: "artifact-import-disabled-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("artifact_preview");
    expect(names.some((name) => name.startsWith("artifact_import_"))).toBe(false);
  } finally {
    await client.close();
    await server.close();
    await f.dispose();
  }
});
