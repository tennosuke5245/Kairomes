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

  test("MCP catalog keeps lifecycle refresh on the trusted local control plane", () => {
    expect(() => Inputs.mcp_catalog_search.parse({ refresh: true })).toThrow();
    expect(Inputs.mcp_catalog_search.parse({})).toEqual({ query: "", limit: 30 });
  });
});
