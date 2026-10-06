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

  test("file tools accept only bounded, strict inputs and literal or safe glob patterns", () => {
    const workspace_id = "00000000-0000-4000-8000-000000000000";
    expect(Inputs.file_read_many.parse({ workspace_id, files: [{ path: "a.ts" }] })).toEqual({
      workspace_id,
      files: [{ path: "a.ts", start_line: 1, max_lines: 150 }],
    });
    expect(Inputs.file_search.parse({ workspace_id, query: "x" })).toEqual({
      workspace_id,
      query: "x",
      limit: 30,
      path: "",
      case_sensitive: false,
      context_lines: 0,
    });
    expect(
      Inputs.file_search.parse({ workspace_id, query: "x", include: ["src/**/*.ts", "*.{md,txt}"] })
        .include,
    ).toEqual(["src/**/*.ts", "*.{md,txt}"]);
    expect(Inputs.file_find.parse({ workspace_id, query: "[id]" })).toEqual({
      workspace_id,
      query: "[id]",
      path: "",
      limit: 50,
    });
    expect(Inputs.file_find.parse({ workspace_id, query: "a..b" }).query).toBe("a..b");
    const file = { path: "a.ts" };
    for (const invalid of [
      () => Inputs.file_read_many.parse({ workspace_id, files: [] }),
      () => Inputs.file_read_many.parse({ workspace_id, files: Array(9).fill(file) }),
      () => Inputs.file_read_many.parse({ workspace_id, files: [{ path: "" }] }),
      () => Inputs.file_read_many.parse({ workspace_id, files: [{ ...file, max_lines: 301 }] }),
      () => Inputs.file_read_many.parse({ workspace_id, files: [{ ...file, extra: true }] }),
      () => Inputs.file_read_many.parse({ workspace_id, path: "a.ts", files: [file] }),
      () => Inputs.file_search.parse({ workspace_id, query: "x", context_lines: 4 }),
      () => Inputs.file_search.parse({ workspace_id, query: "x", context_lines: -1 }),
      () => Inputs.file_search.parse({ workspace_id, query: "x", case_sensitive: "yes" }),
      () => Inputs.file_search.parse({ workspace_id, query: "x", regex: true }),
      () => Inputs.file_search.parse({ workspace_id, query: "x", path: "x".repeat(1025) }),
      () => Inputs.file_search.parse({ workspace_id, query: "x", include: Array(9).fill("*") }),
      () => Inputs.file_find.parse({ workspace_id, query: "" }),
      () => Inputs.file_find.parse({ workspace_id, query: "x".repeat(201) }),
      () => Inputs.file_find.parse({ workspace_id, query: "a\u0000b" }),
      () => Inputs.file_find.parse({ workspace_id, query: "a", limit: 0 }),
      () => Inputs.file_find.parse({ workspace_id, query: "a", limit: 201 }),
    ])
      expect(invalid).toThrow();
    for (const pattern of ["../*.ts", "src/../*", "/etc/*", "!*.ts", "src\\*.ts", "", "a\tb"]) {
      expect(() =>
        Inputs.file_search.parse({ workspace_id, query: "x", include: [pattern] }),
      ).toThrow();
      if (pattern.includes("*"))
        expect(() => Inputs.file_find.parse({ workspace_id, query: pattern })).toThrow();
    }
  });

  test("MCP catalog keeps lifecycle refresh on the trusted local control plane", () => {
    expect(() => Inputs.mcp_catalog_search.parse({ refresh: true })).toThrow();
    expect(Inputs.mcp_catalog_search.parse({})).toEqual({ query: "", limit: 30 });
  });
});
