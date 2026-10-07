import { expect, test } from "bun:test";
import { IMAGE_IMPORT_UPLOAD_ID_HEADER } from "@kairomes/protocol";
import { onePixelPng } from "../../daemon/src/__fixtures__/images.ts";
import { prepareImage } from "./image-file.ts";
import { ImageUploadTracker } from "./image-upload.ts";
import { ImportClient, ImportRequestError, responseError } from "./import-client.ts";

const source = "http://127.0.0.1:1:instance";
const importId = "00000000-0000-4000-8000-0000000000aa";
const response = { instanceId: "i", sessions: [], import: { id: importId, state: "pending" } };

function client(reply: (path: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: { path: string; init: RequestInit }[] = [];
  const uploads = new ImageUploadTracker();
  uploads.bind(source);
  const instance = new ImportClient({
    fetch: async (path, init) => {
      calls.push({ path, init });
      return reply(path, init);
    },
    uploads,
    source: () => source,
  });
  return { instance, calls, uploads };
}

async function image() {
  const prepared = await prepareImage(new File([onePixelPng], "image.png"));
  if (!prepared.ok) throw new Error("fixture image");
  return prepared.image;
}

const uploadIdOf = (init: RequestInit) =>
  new Headers(init.headers).get(IMAGE_IMPORT_UPLOAD_ID_HEADER) ?? "";

test("refusals carry the daemon code; server errors and lost answers are unknown", async () => {
  expect(
    await responseError(Response.json({ code: "PARENT_NOT_FOUND" }, { status: 400 })),
  ).toMatchObject({
    code: "PARENT_NOT_FOUND",
    unknown: false,
  });
  expect(await responseError(new Response("too large", { status: 413 }))).toMatchObject({
    code: "ARTIFACT_TOO_LARGE",
    unknown: false,
  });
  expect(await responseError(new Response("x", { status: 401 }))).toMatchObject({
    code: "PANEL_UNAUTHORIZED",
  });
  // A refused origin is not a lost pairing.
  expect(await responseError(new Response("x", { status: 403 }))).toMatchObject({
    code: "PANEL_FORBIDDEN",
    unknown: false,
  });
  expect(await responseError(Response.json({ code: "x<script>" }, { status: 400 }))).toMatchObject({
    code: "REJECTED",
  });
  expect(await responseError(new Response("", { status: 502 }))).toMatchObject({ unknown: true });
  const lost = client(() => {
    throw new TypeError("connection reset");
  });
  const error = await lost.instance
    .create({ workspace_id: importId, request_id: importId, path: "a.png" })
    .catch((cause) => cause);
  expect(error).toBeInstanceOf(ImportRequestError);
  expect(error).toMatchObject({ code: "UNKNOWN", unknown: true });
});

test("create sends JSON and returns the import with the snapshot", async () => {
  const { instance, calls } = client(() =>
    Response.json({ ...response, import: { id: importId, state: "awaiting_file" } }),
  );
  const result = await instance.create({
    workspace_id: importId,
    request_id: importId,
    path: "images/a.png",
  });
  expect(result.import.id).toBe(importId);
  expect(calls[0]?.path).toBe("/api/panel/imports");
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
    workspace_id: importId,
    request_id: importId,
    path: "images/a.png",
  });
});

test("an upload whose answer is lost is retried only with the same upload ID", async () => {
  let answer: () => Response = () => {
    throw new TypeError("lost");
  };
  const { instance, calls, uploads } = client(() => answer());
  const prepared = await image();
  const first = await instance.upload({ id: importId }, prepared).catch((cause) => cause);
  expect(first).toMatchObject({ unknown: true });
  expect(uploads.hasUnknown).toBe(true);
  answer = () => Response.json(response);
  await instance.upload({ id: importId }, prepared);
  expect(calls).toHaveLength(2);
  const [one, two] = calls.map((call) => uploadIdOf(call.init));
  expect(one).toMatch(/^[0-9a-f-]{36}$/);
  expect(two).toBe(one);
  expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("image/png");
  expect(calls[0]?.init.body).toBe(prepared.blob);
  expect(uploads.hasUnknown).toBe(false);
});

test("a refused upload gets a fresh ID next time; a concurrent second upload is refused locally", async () => {
  let status = 400;
  const { instance, calls } = client(() =>
    status === 200
      ? Response.json(response)
      : Response.json({ code: "UPLOAD_INTERRUPTED" }, { status }),
  );
  const prepared = await image();
  await expect(instance.upload({ id: importId }, prepared)).rejects.toMatchObject({
    code: "UPLOAD_INTERRUPTED",
    unknown: false,
  });
  status = 200;
  await instance.upload({ id: importId }, prepared);
  expect(uploadIdOf(calls[1]?.init ?? {})).not.toBe(uploadIdOf(calls[0]?.init ?? {}));

  let release = () => {};
  const slow = client(
    () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(Response.json(response));
      }),
  );
  const running = slow.instance.upload({ id: importId }, prepared);
  await expect(slow.instance.upload({ id: importId }, prepared)).rejects.toMatchObject({
    code: "UPLOAD_IN_PROGRESS",
  });
  release();
  await running;
  expect(slow.calls).toHaveLength(1);
});

test("the preview read returns the raw bytes and type; a closed preview aborts quietly", async () => {
  const { instance, calls } = client(
    () => new Response(onePixelPng, { headers: { "content-type": "image/png" } }),
  );
  const abort = new AbortController();
  const read = await instance.content({ id: importId }, abort.signal);
  expect(new Uint8Array(read.bytes)).toEqual(new Uint8Array(onePixelPng));
  expect(read.type).toBe("image/png");
  expect(calls[0]).toMatchObject({ path: `/api/panel/imports/${importId}/content` });
  expect(calls[0]?.init.method).toBe("GET");
  const aborted = client((_path, init) => {
    throw init.signal?.reason ?? new DOMException("Aborted", "AbortError");
  });
  abort.abort();
  const error = await aborted.instance
    .content({ id: importId }, abort.signal)
    .catch((cause) => cause);
  expect(error).not.toBeInstanceOf(ImportRequestError);
  // A route that answers 404 means the pending bytes are gone.
  const gone = client(() => Response.json({ code: "ARTIFACT_IMPORT_NOT_FOUND" }, { status: 404 }));
  await expect(
    gone.instance.content({ id: importId }, new AbortController().signal),
  ).rejects.toMatchObject({
    code: "ARTIFACT_IMPORT_NOT_FOUND",
  });
});

test("a retry refused before sending (offline) keeps the unconfirmed upload ID for later", async () => {
  let mode: "lost" | "offline" | "online" = "lost";
  const { instance, calls, uploads } = client(() => {
    if (mode === "lost") throw new TypeError("connection reset");
    return Response.json(response);
  });
  // The coordinator's fetch refuses before anything is sent while the panel is offline.
  const offline = new ImportClient({
    fetch: () => {
      if (mode === "offline") throw ImportRequestError.unsent("OFFLINE");
      throw new Error("not used");
    },
    uploads,
    source: () => source,
  });
  const prepared = await image();
  await expect(instance.upload({ id: importId }, prepared)).rejects.toMatchObject({
    unknown: true,
  });
  const first = uploads.status(source, importId);
  expect(first?.status).toBe("unknown");

  mode = "offline";
  await expect(offline.upload({ id: importId }, prepared)).rejects.toMatchObject({
    code: "OFFLINE",
    unknown: false,
    sent: false,
  });
  // Nothing reached the daemon: still unconfirmed, still the same upload ID.
  expect(uploads.status(source, importId)).toMatchObject({
    status: "unknown",
    uploadId: first?.uploadId,
  });
  expect(uploads.hasUnknown).toBe(true);

  mode = "online";
  await instance.upload({ id: importId }, prepared);
  expect(calls.map((call) => uploadIdOf(call.init))).toEqual([
    first?.uploadId ?? "",
    first?.uploadId ?? "",
  ]);
  expect(uploads.status(source, importId)?.status).toBe("accepted");
});

test("an unsent first attempt leaves no attempt behind; an aborted upload stays unconfirmed", async () => {
  const uploads = new ImageUploadTracker();
  uploads.bind(source);
  const offline = new ImportClient({
    fetch: () => {
      throw ImportRequestError.unsent("OFFLINE");
    },
    uploads,
    source: () => source,
  });
  const prepared = await image();
  await expect(offline.upload({ id: importId }, prepared)).rejects.toMatchObject({
    code: "OFFLINE",
  });
  expect(uploads.status(source, importId)).toBeUndefined();

  // Closing the dialog aborts the body; the daemon may still have taken it.
  const abort = new AbortController();
  const { instance } = client((_path, init) => {
    abort.abort();
    throw init.signal?.reason ?? new DOMException("Aborted", "AbortError");
  });
  const error = await instance.upload({ id: importId }, prepared, abort.signal).catch((e) => e);
  expect(error).toMatchObject({ code: "UNKNOWN", unknown: true });
});
