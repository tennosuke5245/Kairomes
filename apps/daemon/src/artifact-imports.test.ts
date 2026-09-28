import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactImport } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { ArtifactImportManager } from "./artifact-imports.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let f: Awaited<ReturnType<typeof fixture>>;
let manager: ArtifactImportManager;
let events: ArtifactImport[];
let downloads: number;

beforeEach(async () => {
  f = await fixture();
  events = [];
  downloads = 0;
  manager = new ArtifactImportManager(
    f.registry,
    (value) => events.push(value),
    async () => {
      downloads++;
      return Buffer.from(onePixelPng);
    },
  );
});

afterEach(async () => {
  await manager.close();
  await f.dispose();
});

function request(requestId = crypto.randomUUID(), pathName = "generated.png") {
  return manager.request(
    {
      workspace_id: f.workspace.id,
      request_id: requestId,
      path: pathName,
      summary: "保存 ChatGPT 產生的圖片",
      file: {
        download_url: "https://files.oaiusercontent.com/private/signed-image",
        file_id: "file_fixture",
        mime_type: "image/png",
        file_name: "cat.png",
      },
    },
    "mcp",
  );
}

test("artifact import waits for a trusted local decision then publishes an artifact", async () => {
  const pending = await request();
  expect(pending.artifact_import).toMatchObject({
    state: "pending",
    path: "generated.png",
    mime_type: "image/png",
    width: 1,
    height: 1,
    artifact: null,
  });
  expect(await Bun.file(path.join(f.root, "generated.png")).exists()).toBe(false);
  const approval = manager.approvals().find((item) => item.id === pending.artifact_import.id);
  expect(approval?.fingerprint).toMatch(/^[a-f0-9]{64}$/);

  await manager.decide(pending.artifact_import.id, approval?.fingerprint ?? "", true);
  const applied = manager.poll(pending.artifact_import.id);
  expect(applied.artifact_import).toMatchObject({ state: "applied", path: "generated.png" });
  expect(applied.artifact_import.artifact).toMatchObject({
    kind: "artifact",
    path: "generated.png",
  });
  expect(await readFile(path.join(f.root, "generated.png"))).toEqual(onePixelPng);
  expect(events.map((event) => event.state)).toEqual(["pending", "applying", "applied"]);
});

test("artifact import request IDs are idempotent without retaining a short-lived URL", async () => {
  const requestId = crypto.randomUUID();
  const first = await request(requestId);
  const replay = await manager.request({
    workspace_id: f.workspace.id,
    request_id: requestId,
    path: "generated.png",
    summary: "保存 ChatGPT 產生的圖片",
    file: {
      download_url: "https://files.oaiusercontent.com/private/refreshed-url",
      file_id: "file_fixture",
      mime_type: "image/png",
      file_name: "cat.png",
    },
  });
  expect(replay.artifact_import.id).toBe(first.artifact_import.id);
  expect(downloads).toBe(1);

  await expect(request(requestId, "different.png")).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_REQUEST_CONFLICT",
  });
});

test("denied imports never create a file", async () => {
  const pending = await request();
  const approval = manager.approvals().find((item) => item.id === pending.artifact_import.id);
  await manager.decide(pending.artifact_import.id, approval?.fingerprint ?? "", false);
  expect(manager.poll(pending.artifact_import.id).artifact_import.state).toBe("denied");
  expect(await Bun.file(path.join(f.root, "generated.png")).exists()).toBe(false);
});
