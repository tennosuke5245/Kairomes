import { expect, test } from "bun:test";
import { fixture } from "../../../tests/fixtures.ts";
import { doctor } from "./doctor.ts";

test("doctor discovers the complete command-enabled MCP surface without executing a command", async () => {
  const f = await fixture();
  try {
    const result = await doctor(f.state);
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "mcp-stdio")).toMatchObject({ status: "pass" });
    expect(result.checks.find((c) => c.name === "mcp-stdio")?.detail).toContain(
      "4 個固定下游 MCP Broker",
    );
  } finally {
    await f.dispose();
  }
}, 15000);
