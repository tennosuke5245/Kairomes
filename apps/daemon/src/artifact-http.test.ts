import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactSchema } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { startPreview } from "./preview.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let f: Awaited<ReturnType<typeof fixture>>;

beforeEach(async () => {
  f = await fixture();
  await writeFile(path.join(f.root, "preview.png"), onePixelPng);
});

afterEach(async () => {
  await f.dispose();
});

test("local artifact bytes require the UI token, same origin and inspected version", async () => {
  const preview = startPreview(
    f.registry,
    '<html><head><!--KAIROMES_MODE--></head><body><div id="root"></div></body></html>',
    0,
  );
  const url = new URL(preview.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("session");
  const headers = {
    "Content-Type": "application/json",
    Origin: url.origin,
    Authorization: `Bearer ${token}`,
  };
  try {
    const toolResponse = await fetch(`${url.origin}/api/tools`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "artifact_preview",
        arguments: { workspace_id: f.workspace.id, path: "preview.png" },
      }),
    });
    const artifact = ArtifactSchema.parse((await toolResponse.json()).structuredContent);
    const body = JSON.stringify({
      workspace_id: artifact.workspace_id,
      path: artifact.path,
      version: artifact.version,
    });
    const endpoint = `${url.origin}/api/artifacts/content`;

    expect(
      (await fetch(endpoint, { method: "POST", headers: { ...headers, Authorization: "" }, body }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { ...headers, Origin: "https://attacker.example" },
          body,
        })
      ).status,
    ).toBe(403);

    const content = await fetch(endpoint, { method: "POST", headers, body });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await content.arrayBuffer())).toEqual(onePixelPng);

    const stale = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace_id: artifact.workspace_id,
        path: artifact.path,
        version: "0".repeat(64),
      }),
    });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ code: "ARTIFACT_CHANGED" });
  } finally {
    await preview.close();
  }
});
