import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FileFindSchema,
  FileReadManySchema,
  FileSchema,
  SearchSchema,
  type ToolName,
} from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { ToolService } from "./tools.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let service: ToolService;
beforeEach(async () => {
  f = await fixture();
  service = new ToolService(f.registry, true);
});
afterEach(async () => {
  await service.close();
  await f.dispose();
});

async function call(name: ToolName, args: object) {
  const result = await service.call(name, { workspace_id: f.workspace.id, ...args }, "mcp");
  expect(JSON.stringify(result)).not.toContain(f.root);
  expect(JSON.stringify(result)).not.toContain(f.directory);
  return result;
}

async function errorCode(name: ToolName, args: object) {
  const result = await call(name, args);
  expect(result.isError).toBe(true);
  const first = result.content[0];
  return first?.type === "text" ? (JSON.parse(first.text) as { code: string }).code : "";
}

describe("file tool contracts", () => {
  test("file_read_many returns versions, public inline errors and one counted activity", async () => {
    await writeFile(path.join(f.root, ".env"), "SECRET=1\n");
    const result = await call("file_read_many", {
      files: [
        { path: "README.md", max_lines: 2 },
        { path: "src/main.ts" },
        { path: "missing.txt" },
        { path: ".env" },
        { path: "../outside.txt" },
      ],
    });
    expect(result.isError).not.toBe(true);
    const data = FileReadManySchema.parse(result.structuredContent);
    const single = FileSchema.parse(
      (await call("file_read", { path: "README.md", max_lines: 2 })).structuredContent,
    );
    expect(data.files[0]).toMatchObject({
      status: "ok",
      content: single.content,
      version: single.version,
      next_line: 3,
      truncated: true,
    });
    expect(data.files[1]).toMatchObject({ status: "ok", path: "src/main.ts", next_line: null });
    expect(data.truncated).toBe(true);
    expect(data.files.map((entry) => (entry.status === "error" ? entry.error.code : "ok"))).toEqual(
      ["ok", "ok", "PATH_NOT_FOUND", "PRIVATE_PATH", "INVALID_PATH"],
    );
    expect(JSON.stringify(data)).not.toContain("SECRET=1");
    const entry = service.activity.list().find((item) => item.tool === "file_read_many");
    expect(entry).toMatchObject({ title: "讀取 5 個檔案", state: "completed", source: "mcp" });
    expect(entry?.path).toBeUndefined();
    expect(service.activityResult(entry?.resultId ?? "").kind).toBe("file_read_many");
  });

  test("file_read_many rejects an invalid batch as a whole", async () => {
    expect(await errorCode("file_read_many", { files: [] })).toBe("VALIDATION");
    expect(service.activity.list()[0]).toMatchObject({ title: "讀取多個檔案", state: "failed" });
    expect(await errorCode("file_read_many", { files: Array(9).fill({ path: "README.md" }) })).toBe(
      "VALIDATION",
    );
    expect(
      await errorCode("file_read_many", { files: [{ path: "README.md", max_lines: 301 }] }),
    ).toBe("VALIDATION");
    const unknown = await service.call(
      "file_read_many",
      { workspace_id: crypto.randomUUID(), files: [{ path: "README.md" }] },
      "mcp",
    );
    expect(JSON.stringify(unknown)).toContain("WORKSPACE_NOT_FOUND");
    expect(service.activity.list()[0]).toMatchObject({ title: "讀取 1 個檔案", state: "failed" });
  });

  test("file_search scopes, filters, adds context and keeps the original fields", async () => {
    await mkdir(path.join(f.root, "docs"));
    await writeFile(path.join(f.root, "docs", "notes.md"), "before\nKairomes docs\nafter\n");
    const legacy = SearchSchema.parse(
      (await call("file_search", { query: "kairomes" })).structuredContent,
    );
    expect(legacy.matches.map((match) => match.path)).toEqual([
      "README.md",
      "docs/notes.md",
      "src/main.ts",
    ]);
    expect(legacy.matches.every((match) => !("before" in match) && !("after" in match))).toBe(true);
    const scoped = SearchSchema.parse(
      (
        await call("file_search", {
          query: "Kairomes",
          path: "docs",
          include: ["*.md"],
          case_sensitive: true,
          context_lines: 1,
        })
      ).structuredContent,
    );
    expect(scoped).toMatchObject({
      path: "docs",
      case_sensitive: true,
      include: ["*.md"],
      context_lines: 1,
      matches: [
        {
          path: "docs/notes.md",
          line: 2,
          text: "Kairomes docs",
          before: ["before"],
          after: ["after"],
        },
      ],
    });
    expect(service.activity.list()[0]).toMatchObject({
      tool: "file_search",
      title: "搜尋內容",
      path: "docs",
    });
    expect(await errorCode("file_search", { query: "x", include: ["../*"] })).toBe("VALIDATION");
    expect(await errorCode("file_search", { query: "x", context_lines: 4 })).toBe("VALIDATION");
    expect(await errorCode("file_search", { query: "x", path: "../outside" })).toBe("INVALID_PATH");
    expect(await errorCode("file_search", { query: "x", path: ".git" })).toBe("PRIVATE_PATH");
    expect(await errorCode("file_search", { query: "x", path: "missing" })).toBe("PATH_NOT_FOUND");
  });

  test("file_find lists names only, never private paths or links, with a concise activity", async () => {
    const outside = path.join(f.directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "main-outside.ts"), "");
    await symlink(
      outside,
      path.join(f.root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(path.join(f.root, ".env.main"), "");
    await mkdir(path.join(f.root, "node_modules", "main"), { recursive: true });
    const data = FileFindSchema.parse(
      (await call("file_find", { query: "main" })).structuredContent,
    );
    expect(data).toMatchObject({
      kind: "file_find",
      mode: "substring",
      path: "",
      entries: [{ path: "src/main.ts", type: "file" }],
      truncated: false,
    });
    const glob = FileFindSchema.parse(
      (await call("file_find", { query: "*", path: "src", limit: 1 })).structuredContent,
    );
    expect(glob).toMatchObject({ mode: "glob", path: "src", truncated: true });
    expect(glob.entries).toEqual([{ path: "src/main.ts", type: "file" }]);
    expect(service.activity.list()[0]).toMatchObject({
      tool: "file_find",
      title: "尋找檔案",
      path: "src",
      state: "completed",
    });
    expect(await errorCode("file_find", { query: "x", path: "linked" })).toBe("LINK_BLOCKED");
    expect(await errorCode("file_find", { query: "x", path: "README.md" })).toBe("NOT_DIRECTORY");
    expect(await errorCode("file_find", { query: "../*" })).toBe("VALIDATION");
    expect(await errorCode("file_find", { query: "x", limit: 201 })).toBe("VALIDATION");
  });
});
