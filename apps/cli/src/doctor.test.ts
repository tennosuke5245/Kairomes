import { expect, test } from "bun:test";
import { DIAGNOSTIC_CHECK_IDS, VERSION } from "@kairomes/protocol";
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
    // The CLI cannot see a Tunnel, so the shared checks report it as unknown, not healthy.
    expect(result.diagnostics.map((check) => check.id)).toEqual([...DIAGNOSTIC_CHECK_IDS]);
    expect(result.diagnostics.find((check) => check.id === "tunnel")).toEqual({
      id: "tunnel",
      state: "unknown",
      code: "tunnel_unknown",
    });
    expect(result.diagnostics.find((check) => check.id === "workspaces")).toMatchObject({
      state: "ok",
      count: 1,
    });
    expect(result.summary.split("\n")[0]).toBe(`Kairomes ${VERSION} 診斷摘要`);
    for (const secret of [f.root, f.state, f.directory])
      expect(JSON.stringify(result.diagnostics) + result.summary).not.toContain(secret);
  } finally {
    await f.dispose();
  }
}, 15000);
