import { afterEach, expect, test } from "bun:test";
import { LIMITS } from "@kairomes/protocol";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createRelayForwarder, RELAY_ERROR_CODES, RELAY_LIMITS, relayError } from "./relay.ts";

const servers: Array<{ stop(force?: boolean): unknown }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function workbench(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: LIMITS.requestBodyBytes,
    fetch: handler,
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, server };
}

function relay(origin: string, timeoutMs?: number) {
  const sent: JSONRPCMessage[] = [];
  const abort = new AbortController();
  const forward = createRelayForwarder({
    origin,
    token: "synthetic-token",
    send: async (message) => {
      sent.push(message);
    },
    closed: () => false,
    signal: abort.signal,
    timeoutMs,
  });
  return { sent, forward, abort };
}

const call = (id: number, text = ""): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "file_change_request", arguments: { text } },
});

test("relay cap matches the workbench body cap and fits the largest file-change batch", () => {
  expect(RELAY_LIMITS.requestBytes).toBe(LIMITS.requestBodyBytes);
  expect(RELAY_LIMITS.requestBytes).toBe(320 * 1024);
  // file_change_request accepts up to 256 KiB of serialized changes plus the JSON-RPC envelope.
  expect(RELAY_LIMITS.requestBytes).toBeGreaterThan(256 * 1024 + 4096);
  // Long polls must finish before the relay gives up on a request.
  expect(LIMITS.pollWaitMs).toBeLessThan(RELAY_LIMITS.timeoutMs);
});

test("forwards requests over the old 32 KiB cap and rejects oversized ones without sending", async () => {
  let received = 0;
  const { origin } = workbench(async (request) => {
    received++;
    const body = (await request.json()) as { id: number };
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { ok: true } });
  });
  const { sent, forward } = relay(origin);
  await forward(call(1, "x".repeat(100 * 1024)));
  expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  await forward(call(2, "x".repeat(RELAY_LIMITS.requestBytes)));
  expect(received).toBe(1);
  expect(sent[1]).toEqual({ jsonrpc: "2.0", id: 2, error: relayError("tooLarge") });
  expect(sent[1]).toMatchObject({
    error: {
      code: RELAY_ERROR_CODES.tooLarge,
      message:
        "Request too large for the local relay (limit 320 KiB). Split the change into smaller batches.",
    },
  });
  // Oversized notifications get no reply, because JSON-RPC notifications have no id.
  await forward({
    jsonrpc: "2.0",
    method: "notifications/message",
    params: { text: "x".repeat(RELAY_LIMITS.requestBytes) },
  });
  expect(sent).toHaveLength(2);
  expect(received).toBe(1);
});

test("timeout, busy and offline failures get distinct JSON-RPC errors", async () => {
  const slow = workbench(async () => {
    await Bun.sleep(1000);
    return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
  });
  const timed = relay(slow.origin, 50);
  await timed.forward(call(1));
  expect(timed.sent).toEqual([{ jsonrpc: "2.0", id: 1, error: relayError("timeout") }]);
  expect(relayError("timeout")).toMatchObject({
    code: RELAY_ERROR_CODES.timeout,
    message: "The local workbench did not answer in time; retry with the same request_id.",
  });

  const busy = workbench(() => new Response("Busy", { status: 429 }));
  const crowded = relay(busy.origin);
  await crowded.forward(call(2));
  expect(crowded.sent).toEqual([{ jsonrpc: "2.0", id: 2, error: relayError("busy") }]);

  const tooLarge = workbench(() => new Response("Too large", { status: 413 }));
  const rejected = relay(tooLarge.origin);
  await rejected.forward(call(3));
  expect(rejected.sent).toEqual([{ jsonrpc: "2.0", id: 3, error: relayError("tooLarge") }]);

  const gone = workbench(() => new Response("unused"));
  gone.server.stop(true);
  const offline = relay(gone.origin);
  await offline.forward(call(4));
  expect(offline.sent).toEqual([{ jsonrpc: "2.0", id: 4, error: relayError("offline") }]);

  const unauthorized = workbench(() => new Response("no", { status: 401 }));
  const stale = relay(unauthorized.origin);
  await stale.forward(call(5));
  expect(stale.sent).toEqual([{ jsonrpc: "2.0", id: 5, error: relayError("offline") }]);

  const codes = new Set(
    (["offline", "timeout", "tooLarge", "busy"] as const).map((kind) => relayError(kind).code),
  );
  expect(codes.size).toBe(4);
  // Errors carry no token, origin or private detail.
  const all = JSON.stringify([timed.sent, crowded.sent, rejected.sent, offline.sent, stale.sent]);
  expect(all).not.toContain("synthetic-token");
  expect(all).not.toContain("127.0.0.1");
});

test("relay shutdown is not reported as a timeout and more than eight requests are refused", async () => {
  const release: Array<() => void> = [];
  // Holds every request open; the relay gives up on them before any answer is released.
  const { origin } = workbench(
    () =>
      new Promise<Response>((resolve) => {
        release.push(() => resolve(Response.json({ jsonrpc: "2.0", id: 0, result: {} })));
      }),
  );
  const { sent, forward, abort } = relay(origin, 10_000);
  const pending = Array.from({ length: RELAY_LIMITS.inFlight }, (_, index) => forward(call(index)));
  await forward(call(99));
  expect(sent).toEqual([{ jsonrpc: "2.0", id: 99, error: relayError("busy") }]);
  for (let index = 0; index < 200 && release.length < RELAY_LIMITS.inFlight; index++)
    await Bun.sleep(5);
  abort.abort();
  await Promise.all(pending);
  for (const finish of release) finish();
  expect(sent.slice(1).map((message) => ("error" in message ? message.error.code : 0))).toEqual(
    Array(RELAY_LIMITS.inFlight).fill(RELAY_ERROR_CODES.offline),
  );
});
