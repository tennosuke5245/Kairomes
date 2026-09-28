import { expect, test } from "bun:test";
import { startWorkbench } from "@kairomes/daemon";
import { fixture } from "../../../tests/fixtures.ts";
import { relayCheck } from "./relay-check.ts";

const minimalHtml = "<html><head><!--KAIROMES_MODE--></head><body>Workbench</body></html>";

test("relay check sees the full attached tool surface without invoking a tool", async () => {
  const f = await fixture();
  const app = await startWorkbench(f.registry, minimalHtml, 0);
  try {
    const result = await relayCheck(f.state);
    expect(result.ok).toBe(true);
    expect(result.tools).toHaveLength(25);
    expect(result.tools).toContain("command_request");
    expect(result.tools).toContain("file_change_request");
    expect(result.tools).toContain("artifact_preview");
    expect(result.tools).toContain("mcp_catalog_search");
    expect(result.tools).toContain("mcp_tool_describe");
    expect(result.tools).toContain("mcp_read_call");
    expect(result.tools).toContain("mcp_tool_call");
    expect(result.tools.some((name) => name.startsWith("artifact_import_"))).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
  } finally {
    await app.close();
    await f.dispose();
  }
}, 15000);
