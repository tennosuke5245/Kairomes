import { expect, test } from "bun:test";
import { readSnapshots } from "./event-stream.ts";

const headers = { "content-type": "text/event-stream" };
const bytes = (text: string) => new TextEncoder().encode(text);

test("an aborted reader never delivers a queued chunk or parses its stale identity", async () => {
  let enqueue = (_value: Uint8Array) => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueue = (value) => controller.enqueue(value);
    },
  });
  const abort = new AbortController();
  const snapshots: unknown[] = [];
  const read = readSnapshots(
    new Response(body, { headers }),
    (next) => snapshots.push(next),
    abort.signal,
  );
  enqueue(bytes('data: {"instanceId":"superseded-instance"}\n\n'));
  abort.abort();
  await read;
  expect(snapshots).toEqual([]);
  expect(body.locked).toBe(false);
});

test("aborting during a valid frame skips a later malformed frame in the same chunk", async () => {
  const abort = new AbortController();
  const snapshots: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes('data: {"seq":1}\n\ndata: malformed-json\n\n'));
    },
  });
  await readSnapshots(
    new Response(body, { headers }),
    (next) => {
      snapshots.push(next);
      abort.abort();
    },
    abort.signal,
  );
  expect(snapshots).toEqual([{ seq: 1 }]);
  expect(body.locked).toBe(false);
});

test("a pre-aborted stream is cancelled immediately without consuming or retaining a reader", async () => {
  const abort = new AbortController();
  abort.abort();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await readSnapshots(
    new Response(body, { headers }),
    () => {
      throw new Error("Must not consume");
    },
    abort.signal,
  );
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test("normal EOF is a disconnection even after a valid snapshot", async () => {
  const snapshots: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes('data: {"seq":1}\n\n'));
      controller.close();
    },
  });
  await expect(
    readSnapshots(
      new Response(body, { headers }),
      (next) => snapshots.push(next),
      new AbortController().signal,
    ),
  ).rejects.toThrow("即時連線已中斷。");
  expect(snapshots).toEqual([{ seq: 1 }]);
  expect(body.locked).toBe(false);
});
