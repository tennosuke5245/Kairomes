import { expect, test } from "bun:test";
import { McpMountConfigSchema, mcpConfigFingerprint } from "./mcp-host.ts";

const config = (transport: unknown, name = "服務") =>
  McpMountConfigSchema.parse({ id: "00000000-0000-4000-8000-000000000001", name, transport });

test("parsed launch identity includes full argv/cwd/environment and HTTP header references", async () => {
  const stdio = {
    kind: "stdio",
    command: "program",
    args: ["first", "second"],
    cwd: "directory",
    env: ["KEY"],
  };
  const hash = await mcpConfigFingerprint(config(stdio));
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  for (const change of [
    { command: "other-program" },
    { args: ["second", "first"] },
    { cwd: "other-directory" },
    { env: ["OTHER_KEY"] },
  ])
    expect(await mcpConfigFingerprint(config({ ...stdio, ...change }))).not.toBe(hash);
  const http = {
    kind: "http",
    url: "https://example.test/mcp",
    header_env: { Authorization: "KEY" },
  };
  const httpHash = await mcpConfigFingerprint(config(http));
  expect(
    await mcpConfigFingerprint(config({ ...http, url: "https://example.test/other" })),
  ).not.toBe(httpHash);
  expect(
    await mcpConfigFingerprint(config({ ...http, header_env: { Authorization: "OTHER_KEY" } })),
  ).not.toBe(httpHash);
});

test("defaults and object-key order are canonical while enablement does not change launch identity", async () => {
  expect(
    await mcpConfigFingerprint(config({ kind: "stdio", command: "program" }, "  服務  ")),
  ).toBe(
    await mcpConfigFingerprint(config({ kind: "stdio", command: "program", args: [], env: [] })),
  );
  const one = config({
    kind: "http",
    url: "https://example.test/mcp",
    header_env: { First: "ONE", Second: "TWO" },
  });
  const two = config({
    kind: "http",
    url: "https://example.test/mcp",
    header_env: { Second: "TWO", First: "ONE" },
  });
  expect(await mcpConfigFingerprint(one)).toBe(await mcpConfigFingerprint(two));
  const disabled = { ...one, enabled: false };
  expect(await mcpConfigFingerprint(disabled)).toBe(await mcpConfigFingerprint(one));
});
