import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseUnifiedDiff } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { MAX_NEW_FOLDER_LEVELS, MAX_NEW_FOLDERS, WorkspaceChanges } from "./changes.ts";
import { WorkspaceFiles } from "./files.ts";
import type { WorkspaceRegistry } from "./registry.ts";

test("structured edits preserve UTF-8 BOM and CRLF while using the file_read version", async () => {
  const f = await fixture();
  try {
    const target = `${f.root}/src/main.ts`;
    await writeFile(
      target,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('export const message = "Kairomes";\r\nconsole.log(message);\r\n'),
      ]),
    );
    const current = await new WorkspaceFiles(f.registry).read(f.workspace.id, "src/main.ts");
    const engine = new WorkspaceChanges(f.registry);
    const prepared = await engine.prepare(f.workspace.id, [
      {
        operation: "edit",
        path: "src/main.ts",
        expected_version: current.version,
        replacements: [
          {
            old_text: 'export const message = "Kairomes";\nconsole.log(message);',
            new_text: 'export const message = "Kairomes 喵";\nconsole.log(message);',
            replace_all: false,
          },
        ],
      },
    ]);
    expect(prepared.diff).toContain('+export const message = "Kairomes 喵";');
    await engine.apply(prepared);
    const data = await readFile(target);
    expect([...data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(data.toString("utf8")).toContain('"Kairomes 喵";\r\nconsole.log(message);\r\n');
    expect(data.toString("utf8").replace(/\r\n/g, "")).not.toContain("\n");
  } finally {
    await f.dispose();
  }
});

test("a stale version rejects the whole batch before any file is changed", async () => {
  const f = await fixture();
  try {
    const files = new WorkspaceFiles(f.registry);
    const readme = await files.read(f.workspace.id, "README.md");
    const main = await files.read(f.workspace.id, "src/main.ts");
    const engine = new WorkspaceChanges(f.registry);
    const prepared = await engine.prepare(f.workspace.id, [
      {
        operation: "edit",
        path: "README.md",
        expected_version: readme.version,
        replacements: [{ old_text: "Hello Kairomes", new_text: "Hello Meow", replace_all: false }],
      },
      {
        operation: "edit",
        path: "src/main.ts",
        expected_version: main.version,
        replacements: [{ old_text: "Kairomes", new_text: "Changed", replace_all: false }],
      },
    ]);
    await writeFile(`${f.root}/src/main.ts`, 'export const message = "someone else";\n');
    await expect(engine.apply(prepared)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await Bun.file(`${f.root}/README.md`).text()).toContain("Hello Kairomes");
  } finally {
    await f.dispose();
  }
});

test("one reviewed batch can create, rewrite and delete text files", async () => {
  const f = await fixture();
  try {
    const files = new WorkspaceFiles(f.registry);
    const readme = await files.read(f.workspace.id, "README.md");
    const main = await files.read(f.workspace.id, "src/main.ts");
    const engine = new WorkspaceChanges(f.registry);
    const prepared = await engine.prepare(f.workspace.id, [
      {
        operation: "write",
        path: "src/new.ts",
        expected_version: null,
        content: "export const created = true;\n",
      },
      {
        operation: "write",
        path: "README.md",
        expected_version: readme.version,
        content: "# Rewritten\n",
      },
      {
        operation: "delete",
        path: "src/main.ts",
        expected_version: main.version,
      },
    ]);
    await engine.apply(prepared);
    expect(await Bun.file(`${f.root}/src/new.ts`).text()).toBe("export const created = true;\n");
    expect(await Bun.file(`${f.root}/README.md`).text()).toBe("# Rewritten\n");
    expect(await Bun.file(`${f.root}/src/main.ts`).exists()).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("exact edits reject ambiguous matches and known credential content", async () => {
  const f = await fixture();
  try {
    await writeFile(`${f.root}/repeat.txt`, "same\nsame\n");
    const files = new WorkspaceFiles(f.registry);
    const current = await files.read(f.workspace.id, "repeat.txt");
    const engine = new WorkspaceChanges(f.registry);
    await expect(
      engine.prepare(f.workspace.id, [
        {
          operation: "edit",
          path: "repeat.txt",
          expected_version: current.version,
          replacements: [{ old_text: "same", new_text: "new", replace_all: false }],
        },
      ]),
    ).rejects.toMatchObject({ code: "EDIT_AMBIGUOUS" });
    await expect(
      engine.prepare(f.workspace.id, [
        {
          operation: "write",
          path: "secret.txt",
          expected_version: null,
          content: `token = sk-${"a".repeat(24)}`,
        },
      ]),
    ).rejects.toMatchObject({ code: "SENSITIVE_CONTENT" });
  } finally {
    await f.dispose();
  }
});

test("a batch is rejected when the trusted UI could not show its complete diff", async () => {
  const f = await fixture();
  try {
    await writeFile(
      `${f.root}/large-delete.txt`,
      Array.from({ length: 200 }, () => "x".repeat(1024)).join("\n"),
    );
    const current = await new WorkspaceFiles(f.registry).read(f.workspace.id, "large-delete.txt");
    await expect(
      new WorkspaceChanges(f.registry).prepare(f.workspace.id, [
        {
          operation: "delete",
          path: "large-delete.txt",
          expected_version: current.version,
        },
      ]),
    ).rejects.toMatchObject({ code: "CHANGE_REVIEW_TOO_LARGE" });
    expect(await Bun.file(`${f.root}/large-delete.txt`).exists()).toBe(true);
  } finally {
    await f.dispose();
  }
});

test("review diffs keep context next to a rewrite and parse into numbered lines", async () => {
  const f = await fixture();
  try {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    await writeFile(`${f.root}/long.txt`, `${lines.join("\n")}\n`);
    const files = new WorkspaceFiles(f.registry);
    const long = await files.read(f.workspace.id, "long.txt");
    const readme = await files.read(f.workspace.id, "README.md");
    const main = await files.read(f.workspace.id, "src/main.ts");
    const prepared = await new WorkspaceChanges(f.registry).prepare(f.workspace.id, [
      {
        operation: "write",
        path: "long.txt",
        expected_version: long.version,
        content: `${lines.map((line) => (line === "line 5" ? "line five" : line)).join("\n")}\n`,
      },
      {
        operation: "edit",
        path: "README.md",
        expected_version: readme.version,
        replacements: [{ old_text: "Hello Kairomes", new_text: "Hello Meow", replace_all: false }],
      },
      { operation: "write", path: "src/new.ts", expected_version: null, content: "export {};\n" },
      { operation: "delete", path: "src/main.ts", expected_version: main.version },
    ]);
    // The two unchanged lines after the edit are lines 6 and 7, not the end of the file.
    expect(prepared.files[0]?.diff.split("\n").slice(2)).toEqual([
      "@@ 5 @@",
      " line 3",
      " line 4",
      "-line 5",
      "+line five",
      " line 6",
      " line 7",
    ]);
    const parsed = parseUnifiedDiff(prepared.diff, { truncated: prepared.diffTruncated });
    expect(
      parsed.files.map(({ path, status, additions, deletions }) => [
        path,
        status,
        additions,
        deletions,
      ]),
    ).toEqual([
      ["long.txt", "modified", 1, 1],
      ["README.md", "modified", 1, 1],
      // A whole-file hunk's final newline is not a line: "export {};\n" is +1, as in git.
      ["src/new.ts", "added", 1, 0],
      ["src/main.ts", "deleted", 0, 1],
    ]);
    expect(
      parsed.files[0]?.lines
        .filter((line) => line.kind !== "hunk")
        .map((line) => [line.kind, line.text, line.oldLine ?? null, line.newLine ?? null]),
    ).toEqual([
      ["context", "line 3", 3, 3],
      ["context", "line 4", 4, 4],
      ["del", "line 5", 5, null],
      ["add", "line five", null, 5],
      ["context", "line 6", 6, 6],
      ["context", "line 7", 7, 7],
    ]);
    expect(parsed.files[1]?.lines[0]).toMatchObject({ kind: "hunk", label: "替換 1" });
    expect(parsed.truncated).toBe(false);
  } finally {
    await f.dispose();
  }
});

const newFile = (path: string, content = "export {};\n") =>
  ({ operation: "write", path, expected_version: null, content }) as const;

/** The registry seen by WorkspaceChanges, with a hook that runs on every lookup. */
function hookedRegistry(registry: WorkspaceRegistry, hook: () => void) {
  const hooked = Object.create(registry) as WorkspaceRegistry;
  hooked.get = (id: string) => {
    hook();
    return registry.get(id);
  };
  return hooked;
}

test("a new file creates its missing parent folders only when the batch is applied", async () => {
  const f = await fixture();
  try {
    const engine = new WorkspaceChanges(f.registry);
    const prepared = await engine.prepare(f.workspace.id, [newFile("a/b/c.ts")]);
    expect(prepared.folders.map((folder) => folder.path)).toEqual(["a", "a/b"]);
    expect(prepared.files[0]?.folders).toEqual(["a", "a/b"]);
    expect(existsSync(`${f.root}/a`)).toBe(false);
    expect(prepared.diff.split("\n\n").slice(0, 2)).toEqual([
      "--- /dev/null\n+++ b/a/\n@@ create folder @@",
      "--- /dev/null\n+++ b/a/b/\n@@ create folder @@",
    ]);
    const parsed = parseUnifiedDiff(prepared.diff);
    expect(
      parsed.files.map(({ path, status, additions, deletions }) => [
        path,
        status,
        additions,
        deletions,
      ]),
    ).toEqual([
      ["a/", "added", 0, 0],
      ["a/b/", "added", 0, 0],
      ["a/b/c.ts", "added", 1, 0],
    ]);
    expect(parsed.files[0]?.lines).toEqual([
      { kind: "hunk", text: "@@ create folder @@", label: "新資料夾" },
    ]);
    await engine.apply(prepared);
    expect((await lstat(`${f.root}/a/b`)).isDirectory()).toBe(true);
    const current = await new WorkspaceFiles(f.registry).read(f.workspace.id, "a/b/c.ts");
    expect(current.content).toBe("export {};\n");
  } finally {
    await f.dispose();
  }
});

test("mkdir creates nested folders and refuses an existing folder or file", async () => {
  const f = await fixture();
  try {
    const engine = new WorkspaceChanges(f.registry);
    const prepared = await engine.prepare(f.workspace.id, [
      { operation: "mkdir", path: "docs/images/2026" },
    ]);
    expect(prepared.files[0]).toMatchObject({
      operation: "mkdir",
      after: null,
      folders: ["docs", "docs/images", "docs/images/2026"],
    });
    expect(parseUnifiedDiff(prepared.diff).files.map((file) => file.path)).toEqual([
      "docs/",
      "docs/images/",
      "docs/images/2026/",
    ]);
    await engine.apply(prepared);
    expect((await lstat(`${f.root}/docs/images/2026`)).isDirectory()).toBe(true);
    await expect(
      engine.prepare(f.workspace.id, [{ operation: "mkdir", path: "src" }]),
    ).rejects.toMatchObject({ code: "NO_CHANGES", message: "資料夾已存在，不需要建立。" });
    await expect(
      engine.prepare(f.workspace.id, [{ operation: "mkdir", path: "README.md" }]),
    ).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
    await expect(
      engine.prepare(f.workspace.id, [newFile("README.md/inner/a.ts")]),
    ).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
  } finally {
    await f.dispose();
  }
});

test("new folders follow the private-name and reserved-name rules", async () => {
  const f = await fixture();
  try {
    const engine = new WorkspaceChanges(f.registry);
    for (const operation of [
      { operation: "mkdir", path: ".git" } as const,
      newFile("node_modules/pkg/index.js"),
      newFile("config/.env.local/a.txt"),
    ])
      await expect(engine.prepare(f.workspace.id, [operation])).rejects.toMatchObject({
        code: "PRIVATE_PATH",
      });
    await expect(engine.prepare(f.workspace.id, [newFile("src./a.ts")])).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  } finally {
    await f.dispose();
  }
});

test.skipIf(process.platform === "win32")(
  "an existing ancestor link blocks new folders",
  async () => {
    const f = await fixture();
    try {
      const engine = new WorkspaceChanges(f.registry);
      const outside = path.join(f.directory, "outside");
      await mkdir(outside);
      await symlink(outside, `${f.root}/linked`);
      await expect(
        engine.prepare(f.workspace.id, [newFile("linked/new/a.ts")]),
      ).rejects.toMatchObject({ code: "LINK_BLOCKED" });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await f.dispose();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a planned folder replaced by a link after review blocks the batch and leaves no folder",
  async () => {
    const f = await fixture();
    try {
      const engine = new WorkspaceChanges(f.registry);
      const outside = path.join(f.directory, "outside");
      await mkdir(outside);
      const prepared = await engine.prepare(f.workspace.id, [
        newFile("fresh/one.ts"),
        newFile("a/b/c.ts"),
      ]);
      await symlink(outside, `${f.root}/a`);
      await expect(engine.apply(prepared)).rejects.toMatchObject({ code: "LINK_BLOCKED" });
      expect(await readdir(outside)).toEqual([]);
      expect(existsSync(`${f.root}/fresh`)).toBe(false);
      expect((await lstat(`${f.root}/a`)).isSymbolicLink()).toBe(true);
    } finally {
      await f.dispose();
    }
  },
);

test("a planned folder taken by a file after review blocks the batch", async () => {
  const f = await fixture();
  try {
    const engine = new WorkspaceChanges(f.registry);
    const second = await engine.prepare(f.workspace.id, [newFile("plain/a.ts")]);
    await writeFile(`${f.root}/plain`, "not a folder\n");
    await expect(engine.apply(second)).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
    expect(await readFile(`${f.root}/plain`, "utf8")).toBe("not a folder\n");
  } finally {
    await f.dispose();
  }
});

test("a failed batch rolls back its files and removes only its own empty folders", async () => {
  const f = await fixture();
  try {
    const readme = await new WorkspaceFiles(f.registry).read(f.workspace.id, "README.md");
    let armed = true;
    const engine = new WorkspaceChanges(
      hookedRegistry(f.registry, () => {
        // Runs while the batch is being applied: someone creates the second target.
        if (!armed || !existsSync(`${f.root}/b`)) return;
        armed = false;
        writeFileSync(`${f.root}/b/two.ts`, "someone else\n");
      }),
    );
    const prepared = await engine.prepare(f.workspace.id, [
      {
        operation: "edit",
        path: "README.md",
        expected_version: readme.version,
        replacements: [{ old_text: "Hello Kairomes", new_text: "Hello Meow", replace_all: false }],
      },
      newFile("a/deep/one.ts"),
      newFile("b/two.ts"),
    ]);
    await expect(engine.apply(prepared)).rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(await readFile(`${f.root}/README.md`, "utf8")).toContain("Hello Kairomes");
    expect(existsSync(`${f.root}/a`)).toBe(false);
    // b now holds the other writer's file, so it stays.
    expect(await readdir(`${f.root}/b`)).toEqual(["two.ts"]);
  } finally {
    await f.dispose();
  }
});

test("a created folder that received a user file during rollback is left in place", async () => {
  const f = await fixture();
  try {
    let armed = true;
    const engine = new WorkspaceChanges(
      hookedRegistry(f.registry, () => {
        if (!armed || !existsSync(`${f.root}/b`)) return;
        armed = false;
        writeFileSync(`${f.root}/a/user.txt`, "keep me\n");
        writeFileSync(`${f.root}/b/two.ts`, "someone else\n");
      }),
    );
    const prepared = await engine.prepare(f.workspace.id, [
      newFile("a/one.ts"),
      newFile("b/two.ts"),
    ]);
    await expect(engine.apply(prepared)).rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(await readdir(`${f.root}/a`)).toEqual(["user.txt"]);
  } finally {
    await f.dispose();
  }
});

test("a planned folder someone else created before apply is not removed by rollback", async () => {
  const f = await fixture();
  try {
    let armed = true;
    const engine = new WorkspaceChanges(
      hookedRegistry(f.registry, () => {
        // Runs once the batch has created its folders: the last target appears.
        if (!armed || !existsSync(`${f.root}/own`)) return;
        armed = false;
        writeFileSync(`${f.root}/src/late.ts`, "someone else\n");
      }),
    );
    const prepared = await engine.prepare(f.workspace.id, [
      newFile("own/a.ts"),
      newFile("other/b.ts"),
      newFile("src/late.ts"),
    ]);
    expect(prepared.folders.map((folder) => folder.path)).toEqual(["own", "other"]);
    await mkdir(`${f.root}/other`);
    await expect(engine.apply(prepared)).rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(existsSync(`${f.root}/own`)).toBe(false);
    // other was empty but not created by this apply, so it stays.
    expect(await readdir(`${f.root}/other`)).toEqual([]);
    expect(await readFile(`${f.root}/src/late.ts`, "utf8")).toBe("someone else\n");
  } finally {
    await f.dispose();
  }
});

test("files sharing a new folder plan it once, and the batch rejects conflicting uses", async () => {
  const f = await fixture();
  try {
    const engine = new WorkspaceChanges(f.registry);
    const prepared = await engine.prepare(f.workspace.id, [
      newFile("shared/a.ts"),
      newFile("shared/b.ts"),
    ]);
    expect(prepared.folders.map((folder) => folder.path)).toEqual(["shared"]);
    expect(prepared.files.map((file) => file.folders)).toEqual([["shared"], []]);
    expect(prepared.diff.match(/\+\+\+ b\/shared\/$/gm)).toHaveLength(1);
    await engine.apply(prepared);
    expect((await readdir(`${f.root}/shared`)).sort()).toEqual(["a.ts", "b.ts"]);

    const owned = await engine.prepare(f.workspace.id, [
      { operation: "mkdir", path: "made" },
      newFile("made/a.ts"),
    ]);
    expect(owned.files.map((file) => file.folders)).toEqual([["made"], []]);
    for (const operations of [
      [newFile("made2/a.ts"), { operation: "mkdir", path: "made2" } as const],
      [newFile("item"), newFile("item/a.ts")],
      [newFile("item/a.ts"), newFile("item")],
    ])
      await expect(engine.prepare(f.workspace.id, operations)).rejects.toMatchObject({
        code: "CHANGE_DUPLICATE",
      });
  } finally {
    await f.dispose();
  }
});

test("new folders are limited per path and per batch", async () => {
  const f = await fixture();
  try {
    const engine = new WorkspaceChanges(f.registry);
    expect(MAX_NEW_FOLDER_LEVELS).toBe(4);
    expect(MAX_NEW_FOLDERS).toBe(16);
    await engine.prepare(f.workspace.id, [newFile("a/b/c/d/e.ts")]);
    await expect(engine.prepare(f.workspace.id, [newFile("a/b/c/d/e/f.ts")])).rejects.toMatchObject(
      { code: "FOLDER_LIMIT", message: expect.stringContaining("4 層") },
    );
    await expect(
      engine.prepare(f.workspace.id, [{ operation: "mkdir", path: "src/a/b/c/d/e" }]),
    ).rejects.toMatchObject({ code: "FOLDER_LIMIT" });
    await engine.prepare(
      f.workspace.id,
      Array.from({ length: 4 }, (_, index) => newFile(`n${index}/a/b/c/x.ts`)),
    );
    await expect(
      engine.prepare(f.workspace.id, [
        ...Array.from({ length: 4 }, (_, index) => newFile(`n${index}/a/b/c/x.ts`)),
        newFile("extra/x.ts"),
      ]),
    ).rejects.toMatchObject({ code: "FOLDER_LIMIT", message: expect.stringContaining("16 個") });
    expect(existsSync(`${f.root}/a`)).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("the review diff names new folders, so the same file without them differs", async () => {
  const f = await fixture();
  try {
    const engine = new WorkspaceChanges(f.registry);
    const before = await engine.prepare(f.workspace.id, [newFile("later/a.ts")]);
    await mkdir(`${f.root}/later`);
    const after = await engine.prepare(f.workspace.id, [newFile("later/a.ts")]);
    expect(before.diff).toContain("+++ b/later/\n@@ create folder @@");
    expect(after.diff).not.toContain("create folder");
    expect(after.folders).toEqual([]);
    // The folder now exists, so the earlier review still applies without creating it.
    await engine.apply(before);
    expect(await readFile(`${f.root}/later/a.ts`, "utf8")).toBe("export {};\n");
  } finally {
    await f.dispose();
  }
});
