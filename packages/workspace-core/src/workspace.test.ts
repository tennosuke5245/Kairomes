import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { WorkspaceFiles } from "./files.ts";
import { isWithin, validateRelativePath } from "./paths.ts";
import { WorkspaceRegistry } from "./registry.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let files: WorkspaceFiles;
beforeEach(async () => {
  f = await fixture();
  files = new WorkspaceFiles(f.registry);
});
afterEach(async () => {
  await f.dispose();
});

describe("workspace authorization", () => {
  test("refuses to downgrade a newer state schema", async () => {
    const db = new Database(path.join(f.state, "state.sqlite"));
    try {
      db.exec("PRAGMA user_version = 99");
      await expect(WorkspaceRegistry.open(f.state)).rejects.toMatchObject({
        code: "STATE_VERSION",
      });
      expect(
        db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(99);
    } finally {
      db.close();
    }
  });

  test("canonicalizes the state directory before comparing overlap", async () => {
    const alias = path.join(f.directory, "state-alias");
    await symlink(f.state, alias, process.platform === "win32" ? "junction" : "dir");
    const second = await WorkspaceRegistry.open(alias);
    try {
      await expect(second.add(f.state)).rejects.toMatchObject({ code: "STATE_OVERLAP" });
    } finally {
      second.close();
    }
  });
  test("persistent IDs, remount idempotence and revocation", async () => {
    const second = await WorkspaceRegistry.open(f.state);
    try {
      expect(second.list()[0]?.id).toBe(f.workspace.id);
      expect((await second.add(f.root)).id).toBe(f.workspace.id);
      second.remove(f.workspace.id);
      await expect(files.read(f.workspace.id, "README.md")).rejects.toMatchObject({
        code: "WORKSPACE_NOT_FOUND",
      });
    } finally {
      second.close();
    }
  });

  test("never publishes the absolute root and rejects state overlap", async () => {
    expect(JSON.stringify(f.registry.list())).not.toContain(f.root);
    await expect(f.registry.add(f.directory)).rejects.toMatchObject({ code: "STATE_OVERLAP" });
    await expect(f.registry.add(path.parse(f.root).root)).rejects.toMatchObject({
      code: "BROAD_ROOT",
    });
  });

  test("detects replacement of the mounted root", async () => {
    await rename(f.root, `${f.root}-old`);
    await mkdir(f.root);
    await writeFile(path.join(f.root, "README.md"), "replacement");
    await expect(files.read(f.workspace.id, "README.md")).rejects.toMatchObject({
      code: "WORKSPACE_CHANGED",
    });
  });
});

describe("file boundaries", () => {
  test("rejects traversal, Windows aliases and private files", async () => {
    for (const input of [
      "../outside",
      "/etc/passwd",
      "C:/secret",
      "a\\b",
      "a//b",
      "a/./b",
      "a/../b",
      "a:stream",
      "a.",
      "a ",
      "NUL.txt",
      "COM1",
      "a\0b",
    ]) {
      expect(() => validateRelativePath(input)).toThrow();
    }
    for (const input of [
      ".env",
      ".env.example",
      "src/.env.local",
      ".git/config",
      "id_rsa",
      ".npmrc",
      "key.pem",
    ]) {
      await expect(files.read(f.workspace.id, input)).rejects.toMatchObject({
        code: "PRIVATE_PATH",
      });
    }
    expect(isWithin(f.root, `${f.root}-sibling/file`)).toBe(false);
  });

  test("blocks external and internal symlink/junction directories", async () => {
    const outside = path.join(f.directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "should never escape");
    await symlink(
      outside,
      path.join(f.root, "external"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      path.join(f.root, "src"),
      path.join(f.root, "internal"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(files.read(f.workspace.id, "external/secret.txt")).rejects.toMatchObject({
      code: "LINK_BLOCKED",
    });
    await expect(files.snapshot(f.workspace.id, "internal")).rejects.toMatchObject({
      code: "LINK_BLOCKED",
    });
    expect(
      (await files.snapshot(f.workspace.id)).entries.some((item) => item.name === "external"),
    ).toBe(false);
  });

  test("blocks hardlinks to outside files", async () => {
    const outside = path.join(f.directory, "outside.txt");
    await writeFile(outside, "outside");
    await link(outside, path.join(f.root, "linked.txt"));
    await expect(files.read(f.workspace.id, "linked.txt")).rejects.toMatchObject({
      code: "LINK_BLOCKED",
    });
  });

  test("pages UTF-8 files without losing line positions", async () => {
    const first = await files.read(f.workspace.id, "README.md", 1, 2);
    expect(first.content).toBe("# Fixture\nHello Kairomes");
    expect(first.next_line).toBe(3);
    const next = await files.read(f.workspace.id, "README.md", first.next_line ?? 1);
    expect(next.content).toBe("第三行測試\n");
    expect(next.version).toBe(first.version);
    expect(next.truncated).toBe(false);
  });

  test("limits binary files, large files and single-line output", async () => {
    await writeFile(path.join(f.root, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(f.root, "huge.txt"), "x".repeat(LIMITS.fileBytes + 1));
    await writeFile(path.join(f.root, "long.txt"), "x".repeat(LIMITS.responseBytes + 1));
    await expect(files.read(f.workspace.id, "binary.bin")).rejects.toMatchObject({
      code: "BINARY_FILE",
    });
    await expect(files.read(f.workspace.id, "huge.txt")).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    await expect(files.read(f.workspace.id, "long.txt")).rejects.toMatchObject({
      code: "LINE_TOO_LONG",
    });
  });

  test("redacts canary credentials before read and search results", async () => {
    const canary = `sk-proj-${"A".repeat(30)}`;
    await writeFile(
      path.join(f.root, "notes.txt"),
      `OpenAI secret: ${canary}\n-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----`,
    );
    const read = await files.read(f.workspace.id, "notes.txt");
    expect(read.redacted).toBe(true);
    expect(read.content).not.toContain(canary);
    expect(read.content).not.toContain("\nSECRET\n");
    expect(JSON.stringify(await files.search(f.workspace.id, "OpenAI"))).not.toContain(canary);
  });

  test("literal search, omissions and truncation are explicit", async () => {
    await writeFile(path.join(f.root, ".env"), "hidden-match");
    const results = await files.search(f.workspace.id, "kairomes");
    expect(results.matches.length).toBe(2);
    expect(results.matches.map((match) => match.path)).toContain("src/main.ts");
    expect((await files.search(f.workspace.id, "hidden-match")).matches).toEqual([]);
    expect((await files.search(f.workspace.id, ".*")).matches).toEqual([]);
    expect((await files.search(f.workspace.id, "Kairomes", 1)).truncated).toBe(true);
    expect((await files.snapshot(f.workspace.id, "", 1)).truncated).toBe(true);
  });
});
