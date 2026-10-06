import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renameSync, symlinkSync } from "node:fs";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileFindSchema, FileReadManySchema, LIMITS, SearchSchema } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { redactKnownSecrets, WorkspaceFiles } from "./files.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let files: WorkspaceFiles;
beforeEach(async () => {
  f = await fixture();
  files = new WorkspaceFiles(f.registry);
});
afterEach(async () => {
  await f.dispose();
});

const linkType = process.platform === "win32" ? "junction" : "dir";

async function put(relative: string, content: string | Buffer) {
  const target = path.join(f.root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** Private names, links and an outside directory that must never surface in any result. */
async function hostileTree() {
  const outside = path.join(f.directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "needle-outside.txt"), "needle OUTSIDE_SECRET\n");
  await put(".env", "needle PRIVATE_ENV\n");
  await put(".env.local", "needle PRIVATE_ENV\n");
  await put(".git/config", "needle PRIVATE_GIT\n");
  await put("node_modules/needle-pkg/index.js", "needle PRIVATE_DEPENDENCY\n");
  await put("dist/needle.js", "needle PRIVATE_BUILD\n");
  await put("src/needle.pem", "needle PRIVATE_KEY_FILE\n");
  await put("src/id_rsa", "needle PRIVATE_KEY_FILE\n");
  await put("data/needle.sqlite", "needle PRIVATE_DATABASE\n");
  await symlink(outside, path.join(f.root, "external"), linkType);
  await symlink(path.join(f.root, "src"), path.join(f.root, "internal"), linkType);
  if (process.platform !== "win32")
    await symlink(
      path.join(outside, "needle-outside.txt"),
      path.join(f.root, "needle-link.txt"),
      "file",
    );
  await writeFile(path.join(f.directory, "hardlink-source.txt"), "needle HARDLINKED_SECRET\n");
  await link(path.join(f.directory, "hardlink-source.txt"), path.join(f.root, "needle-hard.txt"));
  return outside;
}

const leaked =
  /OUTSIDE_SECRET|PRIVATE_|HARDLINKED_SECRET|\.env|\.git|node_modules|dist\/|\.pem|id_rsa|\.sqlite|external|internal|needle-link/;

describe("secret redaction", () => {
  test("private key blocks are redacted in linear time, including unterminated BEGIN markers", () => {
    const key = (label: string) =>
      `-----BEGIN ${label}PRIVATE KEY-----\nSECRET_${label.trim() || "PKCS8"}\n-----END ${label}PRIVATE KEY-----`;
    expect(redactKnownSecrets(`a\n${key("")}\nb\n${key("RSA ")}\nc`)).toBe(
      "a\n[PRIVATE KEY REDACTED]\nb\n[PRIVATE KEY REDACTED]\nc",
    );
    // The first END after each BEGIN closes it; a trailing BEGIN without END stays as text.
    expect(
      redactKnownSecrets(
        "-----BEGIN PRIVATE KEY-----\nx\n-----BEGIN PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----\nz\n-----BEGIN PRIVATE KEY-----\nw",
      ),
    ).toBe("[PRIVATE KEY REDACTED]\nz\n-----BEGIN PRIVATE KEY-----\nw");
    expect(redactKnownSecrets("-----END PRIVATE KEY-----")).toBe("-----END PRIVATE KEY-----");
    // A lazy regular expression rescans the tail for every BEGIN without END (quadratic).
    const markers = "-----BEGIN RSA PRIVATE KEY-----\n".repeat(32 * 1024);
    const started = performance.now();
    expect(redactKnownSecrets(markers)).toBe(markers);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("file_read_many", () => {
  test("pages several files with the same versions, redaction and inline public errors", async () => {
    const canary = `sk-proj-${"B".repeat(30)}`;
    await put("notes.txt", `token ${canary}\nsecond\n`);
    await put("binary.bin", Buffer.from([0, 1, 2]));
    await writeFile(path.join(f.directory, "outside.txt"), "outside");
    await link(path.join(f.directory, "outside.txt"), path.join(f.root, "linked.txt"));
    await symlink(f.directory, path.join(f.root, "escape"), linkType);
    const result = FileReadManySchema.parse(
      await files.readMany(f.workspace.id, [
        { path: "README.md", start_line: 2, max_lines: 1 },
        { path: "notes.txt" },
        { path: "missing.txt" },
        { path: "../outside.txt" },
        { path: ".env" },
        { path: "binary.bin" },
        { path: "linked.txt" },
        { path: "escape/outside.txt" },
      ]),
    );
    expect(result.files.map((entry) => entry.status)).toEqual([
      "ok",
      "ok",
      "error",
      "error",
      "error",
      "error",
      "error",
      "error",
    ]);
    const [readme, notes] = result.files;
    const single = await files.read(f.workspace.id, "README.md", 2, 1);
    expect(readme).toEqual({
      status: "ok",
      path: "README.md",
      content: single.content,
      version: single.version,
      start_line: 2,
      total_lines: single.total_lines,
      next_line: 3,
      truncated: true,
      redacted: false,
    });
    expect(notes).toMatchObject({
      status: "ok",
      content: (await files.read(f.workspace.id, "notes.txt")).content,
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(
      result.files.slice(2).map((entry) => (entry.status === "error" ? entry.error.code : "")),
    ).toEqual([
      "PATH_NOT_FOUND",
      "INVALID_PATH",
      "PRIVATE_PATH",
      "BINARY_FILE",
      "LINK_BLOCKED",
      "LINK_BLOCKED",
    ]);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain(f.root);
  });

  test("all files share one response budget and report where to continue", async () => {
    const line = "x".repeat(99);
    const body = `${Array.from({ length: 300 }, () => line).join("\n")}\n`;
    await put("a.txt", body);
    await put("b.txt", body);
    await put("c.txt", body);
    const result = await files.readMany(f.workspace.id, [
      { path: "a.txt", max_lines: 300 },
      { path: "b.txt", max_lines: 300 },
      { path: "c.txt", start_line: 7, max_lines: 300 },
    ]);
    const [a, b, c] = result.files;
    if (a?.status !== "ok" || b?.status !== "ok" || c?.status !== "ok")
      throw new Error("expected three pages");
    const used = result.files.reduce(
      (sum, entry) => sum + (entry.status === "ok" ? Buffer.byteLength(entry.content) : 0),
      0,
    );
    expect(used).toBeLessThanOrEqual(LIMITS.responseBytes);
    expect(a.truncated).toBe(true);
    expect(a.next_line).toBe(301);
    expect(b.truncated).toBe(true);
    expect(b.next_line).toBe(Math.floor((LIMITS.responseBytes - 300 * 100) / 100) + 1);
    expect(c).toMatchObject({ content: "", truncated: true, next_line: 7, start_line: 7 });
    expect(c.version).toBe(a.version);
    const resumed = await files.read(f.workspace.id, "b.txt", b.next_line ?? 1, 10);
    expect(resumed.start_line).toBe(b.next_line ?? 0);
  });

  test("a line over the whole budget is an inline error; batch size is bounded", async () => {
    await put("long.txt", "x".repeat(LIMITS.responseBytes + 1));
    const result = await files.readMany(f.workspace.id, [
      { path: "long.txt" },
      { path: "README.md" },
    ]);
    expect(result.files[0]).toMatchObject({ status: "error", error: { code: "LINE_TOO_LONG" } });
    expect(result.files[1]).toMatchObject({ status: "ok", path: "README.md" });
    await expect(files.readMany(f.workspace.id, [])).rejects.toMatchObject({
      code: "FILE_LIMIT",
    });
    await expect(
      files.readMany(
        f.workspace.id,
        Array.from({ length: LIMITS.readManyFiles + 1 }, () => ({ path: "README.md" })),
      ),
    ).rejects.toMatchObject({ code: "FILE_LIMIT" });
    await expect(
      files.readMany(crypto.randomUUID(), [{ path: "README.md" }]),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });
});

describe("file_search options", () => {
  beforeEach(async () => {
    await put("src/app.ts", "const Needle = 1;\n// needle lower\nexport {};\n");
    await put("src/nested/deep.ts", "first\nsecond\nneedle in deep\nfourth\nfifth\n");
    await put("src/nested/style.css", ".needle {}\n");
    await put("docs/guide.md", "Needle docs\n");
    await put("lib/util.js", "needle js\n");
  });

  test("path scopes the walk and validates like file_read", async () => {
    const scoped = SearchSchema.parse(
      await files.search(f.workspace.id, "needle", 30, { path: "src/nested" }),
    );
    expect(scoped.path).toBe("src/nested");
    expect(scoped.matches.map((match) => match.path)).toEqual([
      "src/nested/deep.ts",
      "src/nested/style.css",
    ]);
    for (const [scope, code] of [
      ["../outside", "INVALID_PATH"],
      ["/etc", "INVALID_PATH"],
      ["src\\nested", "INVALID_PATH"],
      [".git", "PRIVATE_PATH"],
      ["node_modules", "PRIVATE_PATH"],
      ["README.md", "NOT_DIRECTORY"],
      ["missing", "ENOENT"],
    ] as const) {
      await expect(
        files.search(f.workspace.id, "needle", 30, { path: scope }),
      ).rejects.toMatchObject({ code });
    }
  });

  test("include globs match paths or names case-insensitively and reject unsafe patterns", async () => {
    const paths = async (include: string[]) =>
      (await files.search(f.workspace.id, "needle", 30, { include })).matches.map(
        (match) => match.path,
      );
    expect(await paths(["*.md"])).toEqual(["docs/guide.md"]);
    expect(await paths(["*.MD", "*.js"])).toEqual(["docs/guide.md", "lib/util.js"]);
    expect(await paths(["src/**/*.ts"])).toEqual([
      "src/app.ts",
      "src/app.ts",
      "src/nested/deep.ts",
    ]);
    expect(await paths(["src/*.ts"])).toEqual(["src/app.ts", "src/app.ts"]);
    expect(await paths(["*.{css,md}"])).toEqual(["docs/guide.md", "src/nested/style.css"]);
    expect(await paths([])).toHaveLength(6);
    for (const include of [
      ["../*.ts"],
      ["src/../*.ts"],
      ["/etc/*"],
      ["!*.ts"],
      ["src\\*.ts"],
      [""],
      ["a\u0000b"],
      ["x".repeat(LIMITS.patternLength + 1)],
      Array.from({ length: LIMITS.searchIncludePatterns + 1 }, () => "*.ts"),
    ]) {
      await expect(files.search(f.workspace.id, "needle", 30, { include })).rejects.toMatchObject({
        code: "INVALID_PATTERN",
      });
    }
  });

  test("case sensitivity is opt-in and the query stays literal", async () => {
    const insensitive = await files.search(f.workspace.id, "needle", 30, { path: "src" });
    expect(insensitive.case_sensitive).toBe(false);
    expect(insensitive.matches.filter((match) => match.path === "src/app.ts")).toHaveLength(2);
    const sensitive = await files.search(f.workspace.id, "Needle", 30, {
      path: "src",
      caseSensitive: true,
    });
    expect(sensitive.case_sensitive).toBe(true);
    expect(sensitive.matches).toEqual([{ path: "src/app.ts", line: 1, text: "const Needle = 1;" }]);
    expect((await files.search(f.workspace.id, "ne.dle")).matches).toEqual([]);
    expect((await files.search(f.workspace.id, "(a+)+$")).matches).toEqual([]);
  });

  test("context lines are bounded, clipped and absent unless requested", async () => {
    const plain = await files.search(f.workspace.id, "needle in deep");
    expect(plain.matches[0]).toEqual({
      path: "src/nested/deep.ts",
      line: 3,
      text: "needle in deep",
    });
    expect(plain.context_lines).toBe(0);
    const context = await files.search(f.workspace.id, "needle in deep", 30, { contextLines: 3 });
    expect(context.matches[0]).toEqual({
      path: "src/nested/deep.ts",
      line: 3,
      text: "needle in deep",
      before: ["first", "second"],
      after: ["fourth", "fifth"],
    });
    const edge = await files.search(f.workspace.id, "export {}", 30, { contextLines: 1 });
    expect(edge.matches[0]).toMatchObject({ line: 3, before: ["// needle lower"], after: [] });
    await put("wide.txt", `${"a".repeat(500)}\nwide-needle\n${"b".repeat(500)}\n`);
    const wide = await files.search(f.workspace.id, "wide-needle", 30, { contextLines: 1 });
    expect(wide.matches[0]?.before).toEqual([`${"a".repeat(400)}…`]);
    expect(wide.matches[0]?.after).toEqual([`${"b".repeat(400)}…`]);
    for (const contextLines of [-1, 4, 1.5])
      await expect(
        files.search(f.workspace.id, "needle", 30, { contextLines }),
      ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
  });

  test("matches with context stay within the response budget", async () => {
    const line = `needle ${"z".repeat(600)}`;
    await put("many.txt", `${Array.from({ length: 200 }, () => line).join("\n")}\n`);
    const result = await files.search(f.workspace.id, "needle", 50, {
      path: "",
      include: ["many.txt"],
      contextLines: 3,
    });
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThan(50);
    expect(Buffer.byteLength(JSON.stringify(result.matches))).toBeLessThanOrEqual(
      LIMITS.responseBytes + 1024,
    );
  });
});

describe("file_find", () => {
  beforeEach(async () => {
    await put("src/components/Button.tsx", "export {};\n");
    await put("src/components/button.test.ts", "export {};\n");
    await put("src/pages/[id].tsx", "export {};\n");
    await put("docs/BUTTON.md", "# Button\n");
  });

  test("substring and glob queries match names or relative paths, breadth-first", async () => {
    const find = async (query: string, scope = "", limit = 50) =>
      FileFindSchema.parse(await files.find(f.workspace.id, query, scope, limit));
    const substring = await find("button");
    expect(substring.mode).toBe("substring");
    expect(substring.entries).toEqual([
      { path: "docs/BUTTON.md", type: "file" },
      { path: "src/components/Button.tsx", type: "file" },
      { path: "src/components/button.test.ts", type: "file" },
    ]);
    expect(substring.truncated).toBe(false);
    expect(substring.scanned_entries).toBeGreaterThan(0);
    expect((await find("[id]")).entries).toEqual([{ path: "src/pages/[id].tsx", type: "file" }]);
    expect((await find("components/b")).entries.map((entry) => entry.path)).toEqual([
      "src/components/Button.tsx",
      "src/components/button.test.ts",
    ]);
    const glob = await find("*.tsx");
    expect(glob.mode).toBe("glob");
    expect(glob.entries.map((entry) => entry.path)).toEqual([
      "src/components/Button.tsx",
      "src/pages/[id].tsx",
    ]);
    expect((await find("src/*")).entries).toEqual([
      { path: "src/components", type: "directory" },
      { path: "src/main.ts", type: "file" },
      { path: "src/pages", type: "directory" },
    ]);
    expect((await find("*", "src/components")).entries.map((entry) => entry.path)).toEqual([
      "src/components/Button.tsx",
      "src/components/button.test.ts",
    ]);
    const limited = await find("*", "", 2);
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  test("unsafe globs, scopes and limits are rejected", async () => {
    for (const query of [
      "../*",
      "/etc/*",
      "!*.ts",
      "src\\*",
      `${"x".repeat(LIMITS.patternLength)}*`,
    ])
      await expect(files.find(f.workspace.id, query)).rejects.toMatchObject({
        code: "INVALID_PATTERN",
      });
    expect((await files.find(f.workspace.id, "a..b")).mode).toBe("substring");
    for (const limit of [0, LIMITS.findResults + 1])
      await expect(files.find(f.workspace.id, "a", "", limit)).rejects.toMatchObject({
        code: "INVALID_LIMIT",
      });
    await expect(files.find(f.workspace.id, "a", "../x")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    await expect(files.find(f.workspace.id, "a", ".kairomes")).rejects.toMatchObject({
      code: "PRIVATE_PATH",
    });
    await expect(files.find(f.workspace.id, "a", "README.md")).rejects.toMatchObject({
      code: "NOT_DIRECTORY",
    });
  });

  test("long names stop at the response budget", async () => {
    const stem = "n".repeat(240);
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        put(`long/${stem}${String(index).padStart(3, "0")}.txt`, ""),
      ),
    );
    const result = await files.find(f.workspace.id, "nnnn", "long", 200);
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(result.entries))).toBeLessThanOrEqual(
      LIMITS.responseBytes,
    );
  });
});

describe("walker boundaries", () => {
  test("private names, links, junctions and hardlinks never surface", async () => {
    const outside = await hostileTree();
    const search = await files.search(f.workspace.id, "needle", 50);
    expect(JSON.stringify(search.matches)).not.toMatch(leaked);
    expect(search.matches).toEqual([]);
    expect(search.skipped_files).toBeGreaterThanOrEqual(8);
    const all = await files.find(f.workspace.id, "*", "", 200);
    expect(all.truncated).toBe(false);
    expect(JSON.stringify(all.entries)).not.toMatch(leaked);
    expect(all.entries.map((entry) => entry.path)).toContain("needle-hard.txt");
    for (const query of ["needle", "env", "git", "config", "pem", "id_rsa", "outside"])
      expect(
        JSON.stringify((await files.find(f.workspace.id, query, "", 200)).entries),
      ).not.toMatch(leaked);
    for (const scope of ["external", "internal"]) {
      await expect(files.find(f.workspace.id, "needle", scope)).rejects.toMatchObject({
        code: "LINK_BLOCKED",
      });
      await expect(
        files.search(f.workspace.id, "needle", 30, { path: scope }),
      ).rejects.toMatchObject({ code: "LINK_BLOCKED" });
    }
    expect(JSON.stringify(await files.search(f.workspace.id, "OUTSIDE"))).not.toContain(outside);
  });

  test("a directory swapped for a link before its files are read is never followed", async () => {
    const outside = path.join(f.directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "main.ts"), "needle OUTSIDE_SECRET\n");
    let calls = 0;
    let swapped = false;
    // Calls: deadline, root listing (2), root entries (2), src listing (1), src entry → swap.
    const racing = new WorkspaceFiles(f.registry, {
      now: () => {
        if (++calls === 7) {
          renameSync(path.join(f.root, "src"), path.join(f.root, "src-old"));
          symlinkSync(outside, path.join(f.root, "src"), linkType);
          swapped = true;
        }
        return 0;
      },
    });
    const result = await racing.search(f.workspace.id, "needle");
    expect(swapped).toBe(true);
    expect(JSON.stringify(result)).not.toContain("OUTSIDE_SECRET");
    expect(result.matches).toEqual([]);
    expect(result.skipped_files).toBe(1);
  });

  test("a listing whose directory changed while it was read is discarded", async () => {
    const outside = path.join(f.directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "outside-only.txt"), "");
    let calls = 0;
    let swapped = false;
    // Calls: deadline, root listing (2), root entries (2), first src listing entry → swap.
    const racing = new WorkspaceFiles(f.registry, {
      now: () => {
        if (++calls === 6) {
          renameSync(path.join(f.root, "src"), path.join(f.root, "src-old"));
          symlinkSync(outside, path.join(f.root, "src"), linkType);
          swapped = true;
        }
        return 0;
      },
    });
    const result = await racing.find(f.workspace.id, "*", "", 200);
    expect(swapped).toBe(true);
    expect(result.entries.map((entry) => entry.path)).toEqual(["README.md", "src"]);
    expect(JSON.stringify(result)).not.toContain("outside-only");
  });

  test("entry, time and byte budgets truncate explicitly", async () => {
    await Promise.all(
      Array.from({ length: 1200 }, (_, index) => put(`bulk/file-${index}.txt`, "filler\n")),
    );
    await put("zz/target.txt", "needle beyond the former 1000-entry budget\n");
    const full = await files.search(f.workspace.id, "needle", 30);
    expect(LIMITS.walkEntries).toBeGreaterThan(1200);
    expect(full.matches.map((match) => match.path)).toEqual(["zz/target.txt"]);
    expect(full.truncated).toBe(false);
    expect(full.scanned_files).toBe(1203);
    const found = await files.find(f.workspace.id, "target", "", 50);
    expect(found.entries).toEqual([{ path: "zz/target.txt", type: "file" }]);
    // Root (4) + bulk (1200) + src (1) + zz (1).
    expect(found.scanned_entries).toBe(1206);

    const fewEntries = new WorkspaceFiles(f.registry, { walkEntries: 1000 });
    const capped = await fewEntries.search(f.workspace.id, "needle", 30);
    expect(capped.truncated).toBe(true);
    expect(capped.matches).toEqual([]);
    const cappedFind = await fewEntries.find(f.workspace.id, "target", "", 50);
    expect(cappedFind).toMatchObject({ truncated: true, entries: [], scanned_entries: 1000 });

    let clock = 0;
    const slow = new WorkspaceFiles(f.registry, {
      now: () => (clock += 100),
      scanMilliseconds: LIMITS.scanMilliseconds,
    });
    const timed = await slow.search(f.workspace.id, "needle", 30);
    expect(timed.truncated).toBe(true);
    expect(timed.matches).toEqual([]);
    expect(timed.scanned_files).toBeLessThan(40);

    const fewBytes = new WorkspaceFiles(f.registry, { scanBytes: 64 });
    const starved = await fewBytes.search(f.workspace.id, "needle", 30);
    expect(starved.truncated).toBe(true);
    expect(starved.scanned_files).toBeLessThan(10);
  });
});
