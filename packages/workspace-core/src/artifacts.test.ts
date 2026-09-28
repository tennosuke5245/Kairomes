import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { WorkspaceArtifacts } from "./artifacts.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let f: Awaited<ReturnType<typeof fixture>>;
let artifacts: WorkspaceArtifacts;

beforeEach(async () => {
  f = await fixture();
  artifacts = new WorkspaceArtifacts(f.registry);
});

afterEach(async () => {
  await f.dispose();
});

test("artifact preview verifies image bytes and binds content to an immutable version", async () => {
  await writeFile(path.join(f.root, "preview.png"), onePixelPng);
  const artifact = await artifacts.inspect(f.workspace.id, "preview.png");
  expect(artifact).toMatchObject({
    kind: "artifact",
    workspace_id: f.workspace.id,
    path: "preview.png",
    media_kind: "image",
    mime_type: "image/png",
    byte_size: onePixelPng.length,
    width: 1,
    height: 1,
    previewable: true,
  });
  expect(artifact.version).toMatch(/^[a-f0-9]{64}$/);
  expect(artifact.artifact_id).toMatch(/^[a-f0-9]{64}$/);
  expect((await artifacts.content(f.workspace.id, artifact.path, artifact.version)).data).toEqual(
    onePixelPng,
  );

  await expect(
    artifacts.content(f.workspace.id, artifact.path, "0".repeat(64)),
  ).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
});

test("artifact preview rejects extension spoofing, active content and oversized files", async () => {
  await writeFile(path.join(f.root, "fake.png"), "not a png");
  await writeFile(path.join(f.root, "active.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(f.root, "huge.webp"), Buffer.alloc(LIMITS.artifactBytes + 1));

  await expect(artifacts.inspect(f.workspace.id, "fake.png")).rejects.toMatchObject({
    code: "UNSUPPORTED_ARTIFACT",
  });
  await expect(artifacts.inspect(f.workspace.id, "active.svg")).rejects.toMatchObject({
    code: "UNSUPPORTED_ARTIFACT",
  });
  await expect(artifacts.inspect(f.workspace.id, "huge.webp")).rejects.toMatchObject({
    code: "ARTIFACT_TOO_LARGE",
  });
});
