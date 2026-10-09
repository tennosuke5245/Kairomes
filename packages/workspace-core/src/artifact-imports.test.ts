import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "../../../tests/fixtures.ts";
import { ArtifactImportWriteError, WorkspaceArtifactImports } from "./artifact-imports.ts";
import { imageSignature, isAnimatedImage } from "./artifacts.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

function png(width: number, height: number, extra: Buffer[] = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    onePixelPng.subarray(0, 8),
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", Buffer.alloc(4)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let f: Awaited<ReturnType<typeof fixture>>;
let imports: WorkspaceArtifactImports;

beforeEach(async () => {
  f = await fixture();
  imports = new WorkspaceArtifactImports(f.registry);
});

afterEach(async () => {
  await f.dispose();
});

const temporaryFiles = async (directory = f.root) =>
  (await readdir(directory)).filter((name) => name.startsWith(".kairomes-import-"));

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
  expect(await temporaryFiles()).toEqual([]);
});

test("artifact imports reject spoofed extensions and never overwrite", async () => {
  await expect(imports.prepare(f.workspace.id, "generated.jpg", onePixelPng)).rejects.toMatchObject(
    { code: "ARTIFACT_EXTENSION_MISMATCH", message: expect.stringContaining(".png") },
  );
  await writeFile(path.join(f.root, "generated.png"), "human-owned");
  await expect(imports.prepare(f.workspace.id, "generated.png", onePixelPng)).rejects.toMatchObject(
    {
      code: "FILE_EXISTS",
    },
  );
  expect(await readFile(path.join(f.root, "generated.png"), "utf8")).toBe("human-owned");
});

test("imports need an existing, unlinked parent folder and a public relative path", async () => {
  await expect(
    imports.prepare(f.workspace.id, "design/placeholders/figure.png", onePixelPng),
  ).rejects.toMatchObject({
    code: "PARENT_NOT_FOUND",
    message: expect.stringContaining("design/placeholders"),
  });
  await writeFile(path.join(f.root, "notes"), "a file");
  await expect(imports.prepare(f.workspace.id, "notes/figure.png", onePixelPng)).rejects.toThrow();
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(path.join(f.root, "src"), path.join(f.root, "linked"), linkType);
  await expect(
    imports.prepare(f.workspace.id, "linked/figure.png", onePixelPng),
  ).rejects.toMatchObject({ code: "LINK_BLOCKED" });
  for (const [target, code] of [
    ["../escape.png", "INVALID_PATH"],
    ["src/../../escape.png", "INVALID_PATH"],
    ["C:/escape.png", "INVALID_PATH"],
    ["node_modules/figure.png", "PRIVATE_PATH"],
    [".env.local.png", "PRIVATE_PATH"],
    [".kairomes-import-x.png", "PRIVATE_PATH"],
  ] as const)
    await expect(imports.prepare(f.workspace.id, target, onePixelPng)).rejects.toMatchObject({
      code,
    });
  await expect(imports.validateDestination(f.workspace.id, "figure.svg")).rejects.toMatchObject({
    code: "UNSUPPORTED_ARTIFACT_EXTENSION",
  });
  await mkdir(path.join(f.root, "design/placeholders"), { recursive: true });
  const prepared = await imports.prepare(
    f.workspace.id,
    "design/placeholders/figure.png",
    onePixelPng,
  );
  expect((await imports.apply(prepared)).path).toBe("design/placeholders/figure.png");
});

test("imports check real bytes: signature, structure, 16 MP budget and animation", async () => {
  expect(imageSignature(onePixelPng)).toBe("image/png");
  expect(imageSignature(Buffer.from("<!doctype html>"))).toBeUndefined();
  await expect(
    imports.prepare(f.workspace.id, "page.png", Buffer.from("<!doctype html><html>")),
  ).rejects.toMatchObject({ code: "IMPORT_NOT_IMAGE" });
  await expect(
    imports.prepare(f.workspace.id, "cut.png", onePixelPng.subarray(0, 40)),
  ).rejects.toMatchObject({ code: "INVALID_IMAGE" });
  await expect(imports.prepare(f.workspace.id, "huge.png", png(4097, 4096))).rejects.toMatchObject({
    code: "UNSAFE_IMAGE_DIMENSIONS",
  });
  await expect(imports.prepare(f.workspace.id, "tall.png", png(1, 16_385))).rejects.toMatchObject({
    code: "UNSAFE_IMAGE_DIMENSIONS",
  });
  const animated = png(2, 2, [chunk("acTL", Buffer.alloc(8))]);
  expect(isAnimatedImage(animated, "image/png")).toBe(true);
  await expect(imports.prepare(f.workspace.id, "anim.png", animated)).rejects.toMatchObject({
    code: "ANIMATED_IMAGE_UNSUPPORTED",
  });
  expect((await imports.prepare(f.workspace.id, "max.png", png(4096, 4096))).width).toBe(4096);
  await expect(
    imports.prepare(f.workspace.id, "empty.png", new Uint8Array()),
  ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
});

test("artifact imports recheck destination immediately before writing", async () => {
  const prepared = await imports.prepare(f.workspace.id, "race.png", onePixelPng);
  await writeFile(path.join(f.root, "race.png"), "created during approval");
  const error = await imports.apply(prepared).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ArtifactImportWriteError);
  expect(error).toMatchObject({ code: "FILE_EXISTS", outcome: "not_written" });
  expect(await readFile(path.join(f.root, "race.png"), "utf8")).toBe("created during approval");
  expect(await temporaryFiles()).toEqual([]);

  const changed = await imports.prepare(f.workspace.id, "changed.png", onePixelPng);
  changed.data[20] = (changed.data[20] ?? 0) ^ 0xff;
  await expect(imports.apply(changed)).rejects.toMatchObject({
    code: "IMPORT_CHANGED",
    outcome: "not_written",
  });
  expect(await Bun.file(path.join(f.root, "changed.png")).exists()).toBe(false);
});

test("a failure after the write never deletes a file someone else put at the target", async () => {
  const inspector = (imports as unknown as { artifacts: { inspect: () => Promise<unknown> } })
    .artifacts;
  inspector.inspect = async () => {
    throw new Error("read back failed");
  };
  // The bytes were linked and read back before this failure, so the file may well exist.
  const own = await imports.prepare(f.workspace.id, "own.png", onePixelPng);
  await expect(imports.apply(own)).rejects.toMatchObject({ outcome: "unknown" });
  expect(await readFile(path.join(f.root, "own.png"))).toEqual(onePixelPng);

  // Someone replaced the target (possibly reusing the inode): their file stays.
  inspector.inspect = async () => {
    await unlink(path.join(f.root, "theirs.png"));
    await writeFile(path.join(f.root, "theirs.png"), "user content");
    throw new Error("read back failed");
  };
  const theirs = await imports.prepare(f.workspace.id, "theirs.png", onePixelPng);
  await expect(imports.apply(theirs)).rejects.toMatchObject({ outcome: "unknown" });
  expect(await readFile(path.join(f.root, "theirs.png"), "utf8")).toBe("user content");
  expect(await temporaryFiles()).toEqual([]);
});
