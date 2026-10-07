import { expect, test } from "bun:test";
import { startWorkbench } from "@kairomes/daemon";
import { VERSION } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { relayCheck } from "./relay-check.ts";

const minimalHtml = "<html><head><!--KAIROMES_MODE--></head><body>Workbench</body></html>";

test("relay check sees the full attached tool surface without invoking a tool", async () => {
  const f = await fixture();
  const app = await startWorkbench(f.registry, minimalHtml, 0);
  try {
    const result = await relayCheck(f.state);
    expect(result.ok).toBe(true);
    expect(result.tools).toHaveLength(33);
    expect(result.tools).toContain("command_request");
    expect(result.tools).toContain("file_change_request");
    expect(result.tools).toContain("artifact_preview");
    expect(result.tools).toContain("mcp_catalog_search");
    expect(result.tools).toContain("mcp_tool_describe");
    expect(result.tools).toContain("mcp_read_call");
    expect(result.tools).toContain("mcp_tool_call");
    for (const name of ["git_status", "git_diff", "git_log", "file_read_many", "file_find"])
      expect(result.tools).toContain(name);
    for (const name of ["image_import_request", "image_import_poll", "image_import_cancel"])
      expect(result.tools).toContain(name);
    expect(result.tools.some((name) => name.startsWith("artifact_import_"))).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(result.workbenchVersion).toBe(VERSION);
    expect(result.versionMismatch).toBe(false);

    // A workbench from another release is reported even when its tool list matches.
    const skewed = await relayCheck(f.state, "9.9.9");
    expect(skewed.workbenchVersion).toBe(VERSION);
    expect(skewed.versionMismatch).toBe(true);
    expect(skewed.missing).toEqual([]);
    expect(skewed.ok).toBe(false);
  } finally {
    await app.close();
    await f.dispose();
  }
}, 25000);
