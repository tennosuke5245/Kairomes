import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "../../../tests/fixtures.ts";
import { WorkspaceArtifactImports } from "./artifact-imports.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let f: Awaited<ReturnType<typeof fixture>>;
let imports: WorkspaceArtifactImports;

beforeEach(async () => {
  f = await fixture();
  imports = new WorkspaceArtifactImports(f.registry);
});

afterEach(async () => {
  await f.dispose();
});

test("verified artifact imports create a new image atomically", async () => {
  const prepared = await imports.prepare(f.workspace.id, "generated.png", onePixelPng);
  expect(prepared).toMatchObject({
    workspaceId: f.workspace.id,
    path: "generated.png",
    mimeType: "image/png",
    width: 1,
    height: 1,
  });
  const artifact = await imports.apply(prepared);
  expect(artifact).toMatchObject({
    kind: "artifact",
    path: "generated.png",
    mime_type: "image/png",
    width: 1,
    height: 1,
    version: prepared.version,
  });
  expect(await readFile(path.join(f.root, "generated.png"))).toEqual(onePixelPng);
});

test("artifact imports reject spoofed extensions and never overwrite", async () => {
  await expect(imports.prepare(f.workspace.id, "generated.jpg", onePixelPng)).rejects.toMatchObject(
    {
      code: "ARTIFACT_EXTENSION_MISMATCH",
    },
  );
  await writeFile(path.join(f.root, "generated.png"), "human-owned");
  await expect(imports.prepare(f.workspace.id, "generated.png", onePixelPng)).rejects.toMatchObject(
    {
      code: "FILE_EXISTS",
    },
  );
  expect(await readFile(path.join(f.root, "generated.png"), "utf8")).toBe("human-owned");
});

test("artifact imports recheck destination immediately before writing", async () => {
  const prepared = await imports.prepare(f.workspace.id, "race.png", onePixelPng);
  await writeFile(path.join(f.root, "race.png"), "created during approval");
  await expect(imports.apply(prepared)).rejects.toMatchObject({ code: "FILE_EXISTS" });
  expect(await readFile(path.join(f.root, "race.png"), "utf8")).toBe("created during approval");
});
