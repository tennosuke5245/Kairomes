import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { fixture } from "../../../tests/fixtures.ts";
import { WorkspaceChanges } from "./changes.ts";
import { WorkspaceFiles } from "./files.ts";

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
