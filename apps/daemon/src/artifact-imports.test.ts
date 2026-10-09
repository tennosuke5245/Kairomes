import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ArtifactImport,
  ImageImportResultSchema,
  KairomesError,
  LIMITS,
  type OpenAIFileReference,
} from "@kairomes/protocol";
import { ArtifactImportWriteError, type WorkspaceArtifactImports } from "@kairomes/workspace-core";
import { fixture } from "../../../tests/fixtures.ts";
import {
  animatedPng,
  bodyOf,
  deferred,
  jpegHeader,
  onePixelPng,
  pngHeader,
  streamOf,
  until,
  webpHeader,
} from "./__fixtures__/images.ts";
import { ArtifactImportManager, IMAGE_IMPORT_LIMITS } from "./artifact-imports.ts";
import { ToolService } from "./tools.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let manager: ArtifactImportManager;
let events: ArtifactImport[];
let downloads: Array<{ url: string; signal: AbortSignal }>;
let respond: (reference: OpenAIFileReference, signal: AbortSignal) => Promise<Uint8Array>;
let clock: number;

const url = (name = "signed-image") => `https://files.oaiusercontent.com/file-fixture/${name}`;

beforeEach(async () => {
  f = await fixture();
  events = [];
  downloads = [];
  clock = Date.now();
  respond = async () => Buffer.from(onePixelPng);
  manager = new ArtifactImportManager(
    f.registry,
    (value) => events.push(value),
    async (reference, { signal }) => {
      downloads.push({ url: reference.download_url, signal });
      return respond(reference, signal);
    },
    () => clock,
  );
});

afterEach(async () => {
  await manager.close();
  await f.dispose();
});

function request(
  overrides: Partial<{
    request_id: string;
    path: string;
    workspace_id: string;
    summary: string;
    file: OpenAIFileReference | undefined;
  }> = {},
) {
  return manager.request(
    {
      workspace_id: f.workspace.id,
      request_id: crypto.randomUUID(),
      path: "generated.png",
      summary: "保存 ChatGPT 產生的圖片",
      file: {
        download_url: url(),
        file_id: "file_fixture",
        mime_type: "image/png",
        file_name: "cat.png",
      },
      ...overrides,
    },
    "mcp",
  );
}

const view = (id: string) => manager.poll(id).image_import;
const settled = (id: string) =>
  until(
    () => view(id),
    (value) => value.state !== "preparing",
  );
const review = (id: string) => manager.approvals().find((item) => item.id === id);
const expired = () => new KairomesError("FILE_DOWNLOAD_FAILED", "HTTP 403");
/** Stands in for the paired panel token; the route passes the real one. */
const panel = "a".repeat(64);

/** The paired panel reads the verified bytes (its preview), then approves that content. */
function approve(id: string, fingerprint = review(id)?.fingerprint ?? "") {
  manager.content(id, panel).data.fill(0);
  return manager.decide(id, fingerprint, true, undefined, panel);
}

/** The next approved write ends with an unconfirmed result, as if the read-back failed. */
function unknownWrite(target: ArtifactImportManager) {
  const engine = (target as unknown as { engine: WorkspaceArtifactImports }).engine;
  return spyOn(engine, "apply").mockImplementationOnce(async () => {
    throw new ArtifactImportWriteError("WRITE_UNVERIFIED", "無法確認寫入結果。", "unknown");
  });
}

/** A body the test feeds by hand, to hold an upload open. */
function manualBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return { stream, controller };
}

function createLocal(target: string) {
  return manager.createLocal({
    workspace_id: f.workspace.id,
    request_id: crypto.randomUUID(),
    path: target,
  });
}

function upload(id: string, data: Uint8Array, uploadId: string = crypto.randomUUID()) {
  return manager.upload(id, {
    uploadId,
    contentType: "image/png",
    body: bodyOf(data),
    declaredBytes: data.byteLength,
    authorized: () => true,
  });
}

test("a host file reserves the request first, verifies the bytes and waits for approval", async () => {
  const gate = deferred<Uint8Array>();
  respond = () => gate.promise;
  const first = await request();
  // The identity exists before any byte arrives, so a lost reply can be polled.
  expect(first.image_import).toMatchObject({
    state: "preparing",
    write_outcome: "not_written",
    mime_type: null,
    version: null,
  });
  expect(first.guidance).toContain("image_import_poll");
  expect(ImageImportResultSchema.parse(first)).toEqual(first);
  const serialized = JSON.stringify(first);
  for (const secret of ["file_fixture", "signed-image", "fingerprint", "cat.png"])
    expect(serialized).not.toContain(secret);

  gate.resolve(Buffer.from(onePixelPng));
  const pending = await settled(first.image_import.id);
  expect(pending).toMatchObject({
    state: "pending",
    mime_type: "image/png",
    byte_size: onePixelPng.byteLength,
    width: 1,
    height: 1,
    version: new Bun.CryptoHasher("sha256").update(onePixelPng).digest("hex"),
    expires_at: clock + IMAGE_IMPORT_LIMITS.pendingMs,
  });
  expect(await Bun.file(path.join(f.root, "generated.png")).exists()).toBe(false);
  const trusted = review(first.image_import.id);
  expect(trusted).toMatchObject({
    delivery: "host_file",
    origin: "tool",
    workspace_name: "測試專案",
    source_file_id: "file_fixture",
    source_file_name: "cat.png",
    claimed_mime_type: "image/png",
    sha256_short: pending.version?.slice(0, 12),
    upload_id: null,
  });
  expect(JSON.stringify(manager.approvals())).not.toContain("signed-image");
  // The workbench activity view does not carry the host file ID.
  expect(manager.list()[0]?.source_file_id).toBeNull();

  await approve(first.image_import.id, trusted?.fingerprint);
  const applied = view(first.image_import.id);
  expect(applied).toMatchObject({ state: "applied", write_outcome: "written_verified" });
  expect(applied.artifact).toMatchObject({ path: "generated.png", version: pending.version });
  expect(await readFile(path.join(f.root, "generated.png"))).toEqual(onePixelPng);
  expect(events.map((event) => event.state)).toEqual([
    "preparing",
    "pending",
    "applying",
    "applied",
  ]);
  expect(manager.hydration()).toEqual({ hydrated: 1, omitted: 0, rejected: 0 });
});

test("duplicate host calls with a new download_url share one import and never download in parallel", async () => {
  const gates = [deferred<Uint8Array>(), deferred<Uint8Array>()];
  let running = 0;
  let peak = 0;
  respond = async () => {
    const gate = gates[downloads.length - 1] as (typeof gates)[number];
    running++;
    peak = Math.max(peak, running);
    try {
      return await gate.promise;
    } finally {
      running--;
    }
  };
  const requestId = crypto.randomUUID();
  const file = (name: string) => ({ download_url: url(name), file_id: "file_fixture" });
  const [first, duplicate] = await Promise.all([
    request({ request_id: requestId, file: file("first") }),
    request({ request_id: requestId, file: file("second") }),
  ]);
  expect(duplicate.image_import.id).toBe(first.image_import.id);
  expect(downloads.map((item) => item.url)).toEqual([url("first")]);

  // The first URL failed (for example expired): the second is tried afterwards, not alongside.
  gates[0]?.reject(expired());
  await until(
    () => downloads.length,
    (count) => count === 2,
  );
  expect(downloads[1]?.url).toBe(url("second"));
  gates[1]?.resolve(Buffer.from(onePixelPng));
  expect((await settled(first.image_import.id)).state).toBe("pending");
  expect(peak).toBe(1);

  // Later duplicates, even with another URL, return the same import without downloading.
  const again = await request({ request_id: requestId, file: file("third") });
  expect(again.image_import).toMatchObject({ id: first.image_import.id, state: "pending" });
  expect(downloads).toHaveLength(2);
});

test("a security or format failure does not fall back to another URL", async () => {
  const gate = deferred<Uint8Array>();
  respond = async () => {
    await gate.promise;
    throw new KairomesError("UNSAFE_FILE_HOST", "private address");
  };
  const requestId = crypto.randomUUID();
  const first = await request({ request_id: requestId });
  await request({
    request_id: requestId,
    file: { download_url: url("refreshed"), file_id: "file_fixture" },
  });
  gate.resolve(new Uint8Array());
  expect(await settled(first.image_import.id)).toMatchObject({
    state: "failed",
    error_code: "UNSAFE_FILE_HOST",
  });
  expect(downloads).toHaveLength(1);
  expect(manager.poll(first.image_import.id).guidance).toContain("without file");
});

test("request_id reuse with a different workspace, path, summary or file is refused", async () => {
  const otherRoot = path.join(f.directory, "other");
  await mkdir(otherRoot);
  const other = await f.registry.add(otherRoot, "另一個專案");
  const requestId = crypto.randomUUID();
  const first = await request({ request_id: requestId });
  for (const changed of [
    { workspace_id: other.id },
    { path: "different.png" },
    { summary: "另一張圖" },
    { file: { download_url: url(), file_id: "file_other" } },
    { file: undefined },
  ])
    await expect(request({ request_id: requestId, ...changed })).rejects.toMatchObject({
      code: "REQUEST_ID_REUSED",
    });
  expect(manager.approvals().map((item) => item.id)).toEqual([first.image_import.id]);
  expect(downloads).toHaveLength(1);
});

test("non-file references and arbitrary URLs are rejected before anything is reserved", async () => {
  const rejected = [
    "/mnt/data/generated.png",
    "sandbox:/mnt/data/generated.png",
    "file:///mnt/data/generated.png",
    `data:image/png;base64,${onePixelPng.toString("base64")}`,
    onePixelPng.toString("base64"),
    "https://example.com/generated.png",
    "https://files.oaiusercontent.com.evil.example/generated.png",
    "http://files.oaiusercontent.com/generated.png",
    "https://127.0.0.1/generated.png",
    "https://files.oaiusercontent.com:8443/generated.png",
    `https://files.oaiusercontent.com/${"x".repeat(5000)}`,
  ];
  for (const download_url of rejected)
    await expect(
      request({ file: { download_url, file_id: "file_fixture" } }),
    ).rejects.toMatchObject({ code: "IMPORT_SOURCE_REJECTED" });
  await expect(request({ file: { download_url: url(), file_id: "" } })).rejects.toMatchObject({
    code: "IMPORT_SOURCE_REJECTED",
  });
  // A bare string is not the file object; the published schema refuses it.
  await expect(
    manager.request({
      workspace_id: f.workspace.id,
      request_id: crypto.randomUUID(),
      path: "generated.png",
      summary: "字串不是檔案物件",
      file: "/mnt/data/generated.png",
    }),
  ).rejects.toMatchObject({ name: "ZodError" });
  expect(downloads).toHaveLength(0);
  expect(manager.approvals()).toEqual([]);
  await request({ file: undefined });
  expect(manager.hydration()).toEqual({
    hydrated: 0,
    omitted: 1,
    rejected: rejected.length + 1,
  });
});

test("without a file the import waits for the user's image and still needs approval", async () => {
  await expect(request({ file: undefined, path: "design/figure.png" })).rejects.toMatchObject({
    code: "PARENT_NOT_FOUND",
  });
  expect(manager.approvals()).toEqual([]);
  await mkdir(path.join(f.root, "design"));

  const result = await request({ file: undefined, path: "design/figure.png" });
  expect(result.image_import).toMatchObject({
    state: "awaiting_file",
    expires_at: clock + IMAGE_IMPORT_LIMITS.awaitingMs,
  });
  expect(result.guidance).toContain("Kairomes side panel");
  expect(result.guidance).toContain("image_import_poll");
  const slot = review(result.image_import.id);
  expect(slot).toMatchObject({
    delivery: "user_supplied",
    origin: "tool",
    source_file_id: null,
    upload_id: null,
  });
  // The panel's own default summary, sent by a model, does not make the request the user's own.
  const lookalike = await request({
    file: undefined,
    path: "design/lookalike.png",
    summary: "從側欄匯入的圖片",
  });
  expect(review(lookalike.image_import.id)).toMatchObject({
    origin: "tool",
    summary: "從側欄匯入的圖片",
  });
  // Waiting has nothing to approve or preview.
  await expect(
    manager.decide(result.image_import.id, slot?.fingerprint ?? "", true, undefined, panel),
  ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  expect(() => manager.content(result.image_import.id, panel)).toThrow();

  const uploadId = crypto.randomUUID();
  const uploaded = await upload(result.image_import.id, onePixelPng, uploadId);
  expect(uploaded).toMatchObject({ state: "pending", upload_id: uploadId, width: 1, height: 1 });
  expect(uploaded.fingerprint).not.toBe(slot?.fingerprint);
  expect(manager.content(result.image_import.id, panel).data).toEqual(onePixelPng);
  // The waiting slot's fingerprint can never approve the image that arrived later.
  await expect(
    manager.decide(result.image_import.id, slot?.fingerprint ?? "", true, undefined, panel),
  ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  await manager.decide(result.image_import.id, uploaded.fingerprint, true, undefined, panel);
  expect(view(result.image_import.id)).toMatchObject({
    state: "applied",
    write_outcome: "written_verified",
  });
  expect(await readFile(path.join(f.root, "design/figure.png"))).toEqual(onePixelPng);
  expect(downloads).toHaveLength(0);
});

test("uploads are idempotent by upload_id and a rejected image returns to awaiting_file", async () => {
  const result = await request({ file: undefined });
  const id = result.image_import.id;
  const html = Buffer.from("<!doctype html><title>Sign in</title>");
  const failedUpload = crypto.randomUUID();
  await expect(upload(id, html, failedUpload)).rejects.toMatchObject({ code: "IMPORT_NOT_IMAGE" });
  expect(view(id)).toMatchObject({ state: "awaiting_file", error_code: "IMPORT_NOT_IMAGE" });
  // The same upload_id replays its outcome instead of reading new bytes.
  await expect(upload(id, onePixelPng, failedUpload)).rejects.toMatchObject({
    code: "IMPORT_NOT_IMAGE",
  });
  expect(view(id).state).toBe("awaiting_file");

  const uploadId = crypto.randomUUID();
  const first = await upload(id, onePixelPng, uploadId);
  const replay = await upload(id, pngHeader(2, 2), uploadId);
  expect(replay).toMatchObject({ state: "pending", version: first.version, upload_id: uploadId });
  await expect(upload(id, pngHeader(2, 2))).rejects.toMatchObject({
    code: "IMPORT_NOT_AWAITING_FILE",
  });
  expect(view(id).version).toBe(first.version);
});

test("uploads stop at 25 MiB while streaming and refuse an oversized declared length", async () => {
  const result = await request({ file: undefined });
  const id = result.image_import.id;
  const total = LIMITS.artifactBytes + 3 * 1024 * 1024;
  const huge = streamOf(total);
  await expect(
    manager.upload(id, {
      uploadId: crypto.randomUUID(),
      contentType: "image/png",
      body: huge.stream,
      authorized: () => true,
    }),
  ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  expect(huge.sent()).toBeLessThan(total);
  await expect(
    manager.upload(id, {
      uploadId: crypto.randomUUID(),
      contentType: "image/png",
      body: bodyOf(onePixelPng),
      declaredBytes: LIMITS.artifactBytes + 1,
      authorized: () => true,
    }),
  ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  await expect(
    manager.upload(id, {
      uploadId: crypto.randomUUID(),
      contentType: "image/gif",
      body: bodyOf(onePixelPng),
      authorized: () => true,
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  // A pairing revoked while the body streamed cannot finish the upload.
  await expect(
    manager.upload(id, {
      uploadId: crypto.randomUUID(),
      contentType: "image/png",
      body: bodyOf(onePixelPng),
      authorized: () => false,
    }),
  ).rejects.toMatchObject({ code: "PANEL_UNAUTHORIZED" });
  expect(view(id).state).toBe("awaiting_file");
});

test("truncated, bombed, animated and mismatched images never become pending", async () => {
  const truncated = Buffer.from(onePixelPng.subarray(0, onePixelPng.length - 6));
  const cases: Array<[string, Uint8Array, string]> = [
    ["truncated.png", truncated, "INVALID_IMAGE"],
    ["wide.png", pngHeader(16_385, 1), "UNSAFE_IMAGE_DIMENSIONS"],
    ["bomb.png", pngHeader(5000, 4000), "UNSAFE_IMAGE_DIMENSIONS"],
    ["animated.png", animatedPng(), "ANIMATED_IMAGE_UNSUPPORTED"],
    ["animated.webp", webpHeader(4, 4, 0x02), "ANIMATED_IMAGE_UNSUPPORTED"],
    ["photo.png", jpegHeader(8, 8), "ARTIFACT_EXTENSION_MISMATCH"],
    ["page.png", Buffer.from('{"error":"expired"}'), "IMPORT_NOT_IMAGE"],
  ];
  for (const [target, data, code] of cases) {
    respond = async () => Buffer.from(data);
    const started = await request({ path: target });
    const failed = await settled(started.image_import.id);
    expect(failed).toMatchObject({
      state: "failed",
      error_code: code,
      write_outcome: "not_written",
    });
    expect(manager.poll(started.image_import.id).guidance).toContain("Nothing was written");
    expect(await Bun.file(path.join(f.root, target)).exists()).toBe(false);
  }
  respond = async () => jpegHeader(8, 8);
  const mismatch = await request({ path: "mismatch.png" });
  await settled(mismatch.image_import.id);
  expect(manager.poll(mismatch.image_import.id)).toMatchObject({
    image_import: { message: expect.stringContaining(".jpg 或 .jpeg") },
    guidance: expect.stringContaining("extension matches"),
  });
  // Exactly 16 MP, a still WebP and a JPEG with a matching extension are accepted.
  for (const [target, data] of [
    ["limit.png", pngHeader(4096, 4096)],
    ["still.webp", webpHeader(3, 2)],
    ["photo.jpeg", jpegHeader(8, 8)],
  ] as const) {
    respond = async () => Buffer.from(data);
    const started = await request({ path: target });
    expect((await settled(started.image_import.id)).state).toBe("pending");
    manager.cancel(started.image_import.id);
  }
});

test("destinations stay create-only inside the workspace", async () => {
  await writeFile(path.join(f.root, "existing.png"), "human-owned");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(path.join(f.root, "src"), path.join(f.root, "linked"), linkType);
  for (const [target, code] of [
    ["missing/figure.png", "PARENT_NOT_FOUND"],
    ["existing.png", "FILE_EXISTS"],
    ["linked/figure.png", "LINK_BLOCKED"],
    ["../outside.png", "INVALID_PATH"],
    ["/absolute.png", "INVALID_PATH"],
    ["src\\figure.png", "INVALID_PATH"],
    [".env.png", "PRIVATE_PATH"],
    [".git/figure.png", "PRIVATE_PATH"],
    ["figure.gif", "UNSUPPORTED_ARTIFACT_EXTENSION"],
  ] as const)
    await expect(request({ path: target })).rejects.toMatchObject({ code });
  expect(downloads).toHaveLength(0);
  expect(manager.approvals()).toEqual([]);
  expect(await readFile(path.join(f.root, "existing.png"), "utf8")).toBe("human-owned");

  // A file that appears during review is never overwritten.
  const started = await request({ path: "race.png" });
  await settled(started.image_import.id);
  await writeFile(path.join(f.root, "race.png"), "created during review");
  await approve(started.image_import.id);
  expect(view(started.image_import.id)).toMatchObject({
    state: "conflict",
    error_code: "FILE_EXISTS",
    write_outcome: "not_written",
  });
  expect(await readFile(path.join(f.root, "race.png"), "utf8")).toBe("created during review");
  expect((await readdir(f.root)).some((name) => name.startsWith(".kairomes-import-"))).toBe(false);
});

test("a folder removed while downloading fails the import within the result bounds", async () => {
  // Long enough that the message needs truncating, short enough for macOS's 1024-byte paths.
  const folders = ["a", "b"].map((letter) => letter.repeat(240));
  await mkdir(path.join(f.root, ...folders), { recursive: true });
  const gate = deferred<Uint8Array>();
  respond = () => gate.promise;
  const started = await request({ path: `${folders.join("/")}/figure.png` });
  await rm(path.join(f.root, folders[0] as string), { recursive: true });
  gate.resolve(Buffer.from(onePixelPng));
  const failed = await settled(started.image_import.id);
  expect(failed).toMatchObject({ state: "failed", error_code: "PARENT_NOT_FOUND" });
  expect(failed.message?.length).toBeLessThanOrEqual(500);
  expect(failed.message).toEndWith("…");
  expect(() => ImageImportResultSchema.parse(manager.poll(started.image_import.id))).not.toThrow();
});

test("cancel during download aborts it and late bytes never become pending", async () => {
  const gate = deferred<Uint8Array>();
  respond = () => gate.promise;
  const started = await request();
  const id = started.image_import.id;
  expect(manager.cancel(id).image_import.state).toBe("cancelled");
  expect(downloads[0]?.signal.aborted).toBe(true);
  gate.resolve(Buffer.from(onePixelPng));
  await Bun.sleep(20);
  expect(view(id)).toMatchObject({ state: "cancelled", version: null });
  expect(() => manager.content(id, panel)).toThrow();
  // Cancel is idempotent and a finished import stays as it was.
  expect(manager.cancel(id).image_import.state).toBe("cancelled");
});

test("awaiting and pending imports expire and release their bytes", async () => {
  const waiting = await request({ file: undefined });
  const ready = await request({ path: "ready.png" });
  await settled(ready.image_import.id);
  const fingerprint = review(ready.image_import.id)?.fingerprint ?? "";
  clock += IMAGE_IMPORT_LIMITS.awaitingMs;
  manager.maintain();
  expect(view(waiting.image_import.id).state).toBe("expired");
  expect(view(ready.image_import.id)).toMatchObject({
    state: "expired",
    write_outcome: "not_written",
  });
  expect(() => manager.content(ready.image_import.id, panel)).toThrow();
  await expect(manager.decide(ready.image_import.id, fingerprint, true)).rejects.toMatchObject({
    code: "APPROVAL_MISMATCH",
  });
  await expect(upload(waiting.image_import.id, onePixelPng)).rejects.toMatchObject({
    code: "IMPORT_NOT_AWAITING_FILE",
  });

  // An approval that arrives after the deadline but before the sweep is refused too.
  const late = await request({ path: "late.png" });
  await settled(late.image_import.id);
  clock += IMAGE_IMPORT_LIMITS.pendingMs;
  await expect(
    manager.decide(late.image_import.id, review(late.image_import.id)?.fingerprint ?? "", true),
  ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
  expect(view(late.image_import.id).state).toBe("expired");
  expect(await Bun.file(path.join(f.root, "late.png")).exists()).toBe(false);
});

test("finished imports drop their image bytes so only holding imports stay in memory", async () => {
  const held = () =>
    [...(manager as unknown as { jobs: Map<string, { prepared?: unknown }> }).jobs.values()].filter(
      (job) => job.prepared !== undefined,
    ).length;
  const ready = async (target: string) => {
    const started = await request({ path: target });
    await settled(started.image_import.id);
    expect(view(started.image_import.id).state).toBe("pending");
    return started.image_import.id;
  };

  const applied = await ready("applied.png");
  expect(held()).toBe(1);
  await approve(applied);
  expect(view(applied).state).toBe("applied");
  const denied = await ready("denied.png");
  await manager.decide(denied, review(denied)?.fingerprint ?? "", false);
  const conflict = await ready("conflict.png");
  await writeFile(path.join(f.root, "conflict.png"), "already here");
  await approve(conflict);
  expect(view(conflict).state).toBe("conflict");
  const expiring = await ready("expired.png");
  clock += IMAGE_IMPORT_LIMITS.pendingMs;
  manager.maintain();
  expect(view(expiring).state).toBe("expired");
  // More finished imports than `holding` allows, all retained for poll, none holding bytes.
  for (let index = 0; index < IMAGE_IMPORT_LIMITS.holding + 2; index++)
    manager.cancel(await ready(`cancelled-${index}.png`));
  expect(manager.approvals().length).toBeGreaterThan(IMAGE_IMPORT_LIMITS.holding);
  expect(held()).toBe(0);
  expect(() => manager.content(applied, panel)).toThrow();
});

test("a lost approval response is reconciled from the snapshot and never writes twice", async () => {
  const started = await request();
  const id = started.image_import.id;
  await settled(id);
  const fingerprint = review(id)?.fingerprint ?? "";
  manager.content(id, panel);
  const decide = (value: string) => manager.decide(id, value, true, undefined, panel);
  await expect(decide("0".repeat(64))).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  const first = decide(fingerprint);
  // A retry while the write runs, and one after it finished, are both refused.
  await expect(decide(fingerprint)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  await first;
  await expect(decide(fingerprint)).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
  await expect(manager.decide(id, fingerprint, false)).rejects.toMatchObject({
    code: "APPROVAL_MISMATCH",
  });
  const trusted = review(id);
  expect(trusted).toMatchObject({ state: "applied", write_outcome: "written_verified" });
  expect(trusted?.artifact?.version).toBe(trusted?.version as string);
  expect(events.filter((event) => event.state === "applying")).toHaveLength(1);
  expect(await readFile(path.join(f.root, "generated.png"))).toEqual(onePixelPng);
});

test("denying a waiting or pending import keeps the reason and writes nothing", async () => {
  const waiting = await request({ file: undefined, path: "a.png" });
  await manager.decide(
    waiting.image_import.id,
    review(waiting.image_import.id)?.fingerprint ?? "",
    false,
    "  我自己上傳  ",
  );
  expect(view(waiting.image_import.id)).toMatchObject({
    state: "denied",
    denial_reason: "我自己上傳",
  });
  const ready = await request({ path: "b.png" });
  await settled(ready.image_import.id);
  await manager.decide(
    ready.image_import.id,
    review(ready.image_import.id)?.fingerprint ?? "",
    false,
  );
  expect(view(ready.image_import.id).state).toBe("denied");
  expect(await Bun.file(path.join(f.root, "b.png")).exists()).toBe(false);
});

test("capacity is bounded and close cancels waiting imports and aborts downloads", async () => {
  const gate = deferred<Uint8Array>();
  respond = () => gate.promise;
  await request({ path: "one.png" });
  await request({ path: "two.png" });
  // Two imports already hold (or are receiving) image bytes.
  await expect(request({ path: "three.png" })).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_LIMIT",
  });
  await request({ file: undefined, path: "four.png" });
  await request({ file: undefined, path: "five.png" });
  await expect(request({ file: undefined, path: "six.png" })).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_LIMIT",
  });
  await manager.close();
  expect(downloads.every((item) => item.signal.aborted)).toBe(true);
  expect(manager.approvals().every((item) => item.state === "cancelled")).toBe(true);
  gate.resolve(Buffer.from(onePixelPng));
  await expect(request({ path: "seven.png" })).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_CLOSED",
  });
});

test("unmounting the workspace cancels its waiting imports", async () => {
  const waiting = await request({ file: undefined });
  f.registry.remove(f.workspace.id);
  manager.maintain();
  expect(view(waiting.image_import.id).state).toBe("cancelled");
});

test("the activity log names the action 匯入圖片 with its path and never the download URL", async () => {
  const service = new ToolService(f.registry, false, {
    artifactDownload: async () => Buffer.from(onePixelPng),
  });
  try {
    const result = await service.call(
      "image_import_request",
      {
        workspace_id: f.workspace.id,
        request_id: crypto.randomUUID(),
        path: "activity.png",
        summary: "活動紀錄",
        file: { download_url: url("activity-secret"), file_id: "file_activity" },
      },
      "mcp",
    );
    expect(result.isError).not.toBe(true);
    const id = (result.structuredContent as { image_import: { id: string } }).image_import.id;
    await until(
      () => service.imports.poll(id).image_import.state,
      (state) => state === "pending",
    );
    const entry = service.activity.list().find((item) => item.importId === id);
    expect(entry).toMatchObject({
      kind: "artifact_import",
      tool: "artifact_import_request",
      source: "mcp",
      path: "activity.png",
      title: "匯入圖片 · 等待核准",
    });
    expect(JSON.stringify(service.activity.list())).not.toContain("activity-secret");
    // Cancelling ends the import and its activity entry follows.
    expect(
      (await service.call("image_import_cancel", { import_id: id }, "mcp")).structuredContent,
    ).toMatchObject({ image_import: { state: "cancelled" } });
    expect(service.activity.list().find((item) => item.importId === id)?.title).toBe(
      "匯入圖片 · 已取消",
    );
  } finally {
    await service.close();
  }
});

test("a conflict's activity entry names its own cause, never 目的檔案已存在 for a missing folder", async () => {
  const service = new ToolService(f.registry, false, {
    artifactDownload: async () => Buffer.from(onePixelPng),
  });
  try {
    await mkdir(path.join(f.root, "design/new"), { recursive: true });
    const result = await service.call(
      "image_import_request",
      {
        workspace_id: f.workspace.id,
        request_id: crypto.randomUUID(),
        path: "design/new/x.png",
        summary: "保存設計圖",
        file: { download_url: url("conflict"), file_id: "file_conflict" },
      },
      "mcp",
    );
    const id = (result.structuredContent as { image_import: { id: string } }).image_import.id;
    await until(
      () => service.imports.poll(id).image_import.state,
      (state) => state === "pending",
    );
    // The folder disappears after the request was verified; the approved write finds no parent.
    await rm(path.join(f.root, "design/new"), { recursive: true });
    const fingerprint = service.imports.approvals().find((item) => item.id === id)?.fingerprint;
    service.imports.content(id, panel).data.fill(0);
    await service.imports.decide(id, fingerprint ?? "", true, undefined, panel);
    expect(service.imports.poll(id).image_import).toMatchObject({
      state: "conflict",
      error_code: "PARENT_NOT_FOUND",
      write_outcome: "not_written",
    });
    expect(service.activity.list().find((item) => item.importId === id)).toMatchObject({
      state: "conflict",
      errorCode: "PARENT_NOT_FOUND",
      title: "匯入圖片 · 找不到資料夾",
    });
  } finally {
    await service.close();
  }
});

test("approve needs the approving panel to have read the exact pending bytes", async () => {
  const started = await request();
  const id = started.image_import.id;
  await settled(id);
  const fingerprint = review(id)?.fingerprint ?? "";
  const decide = (reviewer?: string) => manager.decide(id, fingerprint, true, undefined, reviewer);
  // A snapshot alone (fingerprint and metadata) is not a review of the image.
  for (const reviewer of [undefined, "", panel])
    await expect(decide(reviewer)).rejects.toMatchObject({ code: "IMPORT_PREVIEW_REQUIRED" });
  // Another pairing's preview, or a read without a pairing, does not count for this panel.
  manager.content(id, "b".repeat(64));
  manager.content(id, "");
  await expect(decide(panel)).rejects.toMatchObject({ code: "IMPORT_PREVIEW_REQUIRED" });
  await expect(decide("")).rejects.toMatchObject({ code: "IMPORT_PREVIEW_REQUIRED" });
  expect(view(id)).toMatchObject({ state: "pending", write_outcome: "not_written" });
  expect(await Bun.file(path.join(f.root, "generated.png")).exists()).toBe(false);

  expect(manager.content(id, panel).data).toEqual(onePixelPng);
  await decide(panel);
  expect(view(id)).toMatchObject({ state: "applied", write_outcome: "written_verified" });

  // Denying never needs the preview.
  const other = await request({ path: "other.png" });
  await settled(other.image_import.id);
  await manager.decide(
    other.image_import.id,
    review(other.image_import.id)?.fingerprint ?? "",
    false,
  );
  expect(view(other.image_import.id).state).toBe("denied");
});

test("tool imports cannot fill the slots the user's own panel imports need", async () => {
  const gate = deferred<Uint8Array>();
  respond = () => gate.promise;
  await request({ path: "one.png" });
  await request({ path: "two.png" });
  await request({ file: undefined, path: "three.png" });
  const waiting = await request({ file: undefined, path: "four.png" });
  await expect(request({ file: undefined, path: "five.png" })).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_LIMIT",
  });
  // The side panel keeps its own unfinished slots.
  const local = await createLocal("panel.png");
  await createLocal("panel-2.png");
  await expect(createLocal("panel-3.png")).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_LIMIT",
  });
  // Two host files are still downloading, yet the user's own image is received.
  expect(await upload(local.id, onePixelPng)).toMatchObject({ state: "pending" });
  // Now every slot that holds bytes is used, so a further image waits and nothing changes.
  await expect(upload(waiting.image_import.id, onePixelPng)).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_LIMIT",
  });
  expect(review(waiting.image_import.id)).toMatchObject({
    state: "awaiting_file",
    upload_id: null,
  });
  // The user can deny a model's waiting slot from the panel to free it.
  await manager.decide(
    waiting.image_import.id,
    review(waiting.image_import.id)?.fingerprint ?? "",
    false,
  );
  expect(view(waiting.image_import.id).state).toBe("denied");
  expect(await request({ file: undefined, path: "five.png" })).toMatchObject({
    image_import: { state: "awaiting_file" },
  });
  gate.resolve(Buffer.from(onePixelPng));
});

test("tool calls cannot use up the panel's request identities and old empty tombstones expire", async () => {
  const kept = await request({ path: "kept.png" });
  await settled(kept.image_import.id);
  await approve(kept.image_import.id);
  const keptRequest = { request_id: kept.image_import.request_id, path: "kept.png" };
  const reusable = crypto.randomUUID();
  manager.cancel((await request({ request_id: reusable, file: undefined })).image_import.id);
  for (let index = 2; index < IMAGE_IMPORT_LIMITS.toolRequests; index++)
    manager.cancel((await request({ file: undefined })).image_import.id);
  await expect(request({ file: undefined })).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_LIMIT",
  });
  // The side panel's own imports are not affected.
  expect((await createLocal("panel.png")).state).toBe("awaiting_file");
  // A finished import's identity still blocks reuse of its request_id until tombstoneMs.
  await expect(request({ request_id: reusable, file: undefined })).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_NOT_FOUND",
  });

  clock += IMAGE_IMPORT_LIMITS.tombstoneMs;
  expect(await request({ file: undefined })).toMatchObject({
    image_import: { state: "awaiting_file" },
  });
  // Pruned: the request_id of an import that wrote nothing starts a new import...
  expect(await request({ request_id: reusable, file: undefined })).toMatchObject({
    image_import: { state: "awaiting_file" },
  });
  // ...but an applied import's identity is kept, so it never runs twice.
  await expect(request(keptRequest)).rejects.toMatchObject({ code: "ARTIFACT_IMPORT_NOT_FOUND" });
  expect(downloads).toHaveLength(1);
}, 60000);

test("finished imports are retired oldest first but an unknown write result is never dropped", async () => {
  const unknown = await request({ path: "unknown.png" });
  const id = unknown.image_import.id;
  await settled(id);
  const apply = unknownWrite(manager);
  await approve(id);
  apply.mockRestore();
  expect(view(id)).toMatchObject({ state: "failed", write_outcome: "unknown" });

  for (let index = 0; index < IMAGE_IMPORT_LIMITS.retained + 8; index++)
    manager.cancel((await request({ file: undefined })).image_import.id);
  expect(manager.approvals()).toHaveLength(IMAGE_IMPORT_LIMITS.retained);
  expect(view(id)).toMatchObject({ state: "failed", write_outcome: "unknown" });
  expect(manager.poll(id).guidance).toContain("unknown");
  expect(review(id)).toMatchObject({ state: "failed", write_outcome: "unknown" });

  // When only unknown results remain, new work is refused instead of dropping one of them.
  for (let index = 1; index < IMAGE_IMPORT_LIMITS.retained; index++) {
    const started = await request({ path: `unknown-${index}.png` });
    await settled(started.image_import.id);
    const failing = unknownWrite(manager);
    await approve(started.image_import.id);
    failing.mockRestore();
  }
  await expect(request({ file: undefined })).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_LIMIT",
  });
  expect(manager.approvals().every((item) => item.write_outcome === "unknown")).toBe(true);
  expect(view(id).state).toBe("failed");
}, 30000);

test("an upload that starts before the awaiting deadline keeps receiving past it", async () => {
  const waiting = await request({ file: undefined });
  const id = waiting.image_import.id;
  clock += IMAGE_IMPORT_LIMITS.awaitingMs - 1000;
  const body = manualBody();
  const uploading = manager.upload(id, {
    uploadId: crypto.randomUUID(),
    contentType: "image/png",
    body: body.stream,
    authorized: () => true,
  });
  body.controller.enqueue(new Uint8Array(onePixelPng.subarray(0, 10)));
  clock += 2000;
  manager.maintain();
  expect(view(id)).toMatchObject({ state: "preparing" });
  expect(view(id).expires_at).toBeGreaterThan(clock);
  body.controller.enqueue(new Uint8Array(onePixelPng.subarray(10)));
  body.controller.close();
  expect(await uploading).toMatchObject({ state: "pending", version: expect.any(String) });
});

test("a stalled upload times out back to awaiting_file and a stop reports its own reason", async () => {
  const waiting = await request({ file: undefined });
  const id = waiting.image_import.id;
  const start = (stream: ReadableStream<Uint8Array>) =>
    manager.upload(id, {
      uploadId: crypto.randomUUID(),
      contentType: "image/png",
      body: stream,
      authorized: () => true,
    });
  const stalled = manualBody();
  const timedOut = start(stalled.stream);
  clock += IMAGE_IMPORT_LIMITS.preparingMs;
  manager.maintain();
  await expect(timedOut).rejects.toMatchObject({ code: "UPLOAD_TIMEOUT" });
  expect(view(id)).toMatchObject({ state: "awaiting_file", error_code: "UPLOAD_TIMEOUT" });

  // Denied or cancelled while receiving: the upload says so, not that it was cancelled.
  const denied = start(manualBody().stream);
  expect(view(id).state).toBe("preparing");
  await manager.decide(id, review(id)?.fingerprint ?? "", false);
  await expect(denied).rejects.toMatchObject({ code: "IMPORT_DENIED" });
  expect(view(id).state).toBe("denied");

  const other = await request({ file: undefined, path: "other.png" });
  const cancelled = manager.upload(other.image_import.id, {
    uploadId: crypto.randomUUID(),
    contentType: "image/png",
    body: manualBody().stream,
    authorized: () => true,
  });
  manager.cancel(other.image_import.id);
  await expect(cancelled).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
});

test("a write with an unknown result is labelled 結果待確認, never 匯入失敗", async () => {
  const service = new ToolService(f.registry, false, {
    artifactDownload: async () => Buffer.from(onePixelPng),
  });
  try {
    const result = await service.imports.request(
      {
        workspace_id: f.workspace.id,
        request_id: crypto.randomUUID(),
        path: "unknown.png",
        summary: "結果不明",
        file: { download_url: url(), file_id: "file_unknown" },
      },
      "mcp",
    );
    const id = result.image_import.id;
    await until(
      () => service.imports.poll(id).image_import.state,
      (state) => state === "pending",
    );
    const apply = unknownWrite(service.imports);
    service.imports.content(id, panel);
    await service.decideApproval(
      {
        action: "approve",
        import_id: id,
        fingerprint: service.imports.approvals().find((item) => item.id === id)?.fingerprint ?? "",
      },
      panel,
    );
    apply.mockRestore();
    expect(service.imports.poll(id).image_import).toMatchObject({
      state: "failed",
      write_outcome: "unknown",
    });
    expect(service.activity.list().find((item) => item.importId === id)).toMatchObject({
      title: "匯入圖片 · 結果待確認",
      state: "failed",
      writeOutcome: "unknown",
    });
  } finally {
    await service.close();
  }
});
