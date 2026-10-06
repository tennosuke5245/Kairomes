import { describe, expect, test } from "bun:test";
import { Inputs } from "./index.ts";

describe("tool input validation", () => {
  test("file search rejects the Unicode replacement character", () => {
    expect(() =>
      Inputs.file_search.parse({
        workspace_id: "00000000-0000-4000-8000-000000000000",
        query: "\uFFFD",
      }),
    ).toThrow("搜尋內容包含無法辨識的字元");
  });

  test("Git tools accept only bounded, strict inputs with opaque diff cursors", () => {
    const workspace_id = "00000000-0000-4000-8000-000000000000";
    expect(Inputs.git_diff.parse({ workspace_id })).toEqual({
      workspace_id,
      staged: false,
      context_lines: 3,
    });
    expect(Inputs.git_log.parse({ workspace_id })).toEqual({ workspace_id, limit: 20 });
    for (const invalid of [
      () => Inputs.git_status.parse({ workspace_id, path: "README.md" }),
      () => Inputs.git_diff.parse({ workspace_id, context_lines: 11 }),
      () => Inputs.git_diff.parse({ workspace_id, cursor: "0.zz" }),
      () => Inputs.git_diff.parse({ workspace_id, path: "" }),
      () => Inputs.git_diff.parse({ workspace_id, path: "x".repeat(1025) }),
      () => Inputs.git_log.parse({ workspace_id, limit: 0 }),
      () => Inputs.git_log.parse({ workspace_id, limit: 51 }),
      () => Inputs.git_log.parse({ workspace_id: "not-a-uuid" }),
    ])
      expect(invalid).toThrow();
    expect(Inputs.git_diff.parse({ workspace_id, cursor: "40213.0123456789abcdef" }).cursor).toBe(
      "40213.0123456789abcdef",
    );
  });

  test("MCP catalog keeps lifecycle refresh on the trusted local control plane", () => {
    expect(() => Inputs.mcp_catalog_search.parse({ refresh: true })).toThrow();
    expect(Inputs.mcp_catalog_search.parse({})).toEqual({ query: "", limit: 30 });
  });
});
