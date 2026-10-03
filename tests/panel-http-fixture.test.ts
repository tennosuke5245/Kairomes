import { expect, test } from "bun:test";
import { type PanelSnapshot, readSnapshots } from "../packages/protocol/src/index.ts";
import type {
  PanelAccessResponse,
  TrackedPanelAccessMutation,
} from "../packages/protocol/src/panel-access.ts";
import { panelAccessFingerprint } from "../packages/protocol/src/panel-access.ts";
import { createPanelHttpFixture } from "./panel-http-fixture.ts";

function startFixture() {
  const fixture = createPanelHttpFixture();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 4096,
    async fetch(request) {
      if (request.headers.get("host") !== `127.0.0.1:${server.port}`)
        return new Response(null, { status: 404 });
      return (await fixture.handle(request)) ?? new Response(null, { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}${route}`, {
      method: "POST",
      headers: {
        origin,
        authorization: `Bearer ${"0".repeat(64)}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return {
    fixture,
    origin,
    post,
    close() {
      fixture.close();
      server.stop(true);
    },
  };
}

test("synthetic access HTTP queries the original receipt and fences an unresolved enable on recovery", async () => {
  const transport = startFixture();
  const input: TrackedPanelAccessMutation = {
    action: "enable",
    workspace_id: "00000000-0000-4000-8000-000000000010",
    level: "full",
    minutes: 15,
    request_id: crypto.randomUUID(),
    valid_until: Date.now() + 20_000,
  };
  const fingerprint = await panelAccessFingerprint(input);
  const status = async () =>
    (await (
      await transport.post("/api/panel/access", { action: "status", request_id: input.request_id })
    ).json()) as PanelAccessResponse;
  try {
    await transport.post("/synthetic-panel/control", { action: "uncertain-access" });
    expect((await transport.post("/api/panel/access", input)).status).toBe(502);
    expect((await status()).access_receipt).toMatchObject({ state: "pending", fingerprint });
    expect(transport.fixture.probe()).toMatchObject({ accessMutations: 1, heldAccess: 1 });
    await transport.post("/synthetic-panel/control", { action: "pending" });
    expect((await status()).access_receipt?.state).toBe("pending");
    const recovery = await transport.post("/api/panel/access", {
      action: "disable",
      workspace_id: input.workspace_id,
      request_id: crypto.randomUUID(),
      valid_until: Date.now() + 20_000,
      supersedes: { request_id: input.request_id, valid_until: input.valid_until, fingerprint },
    });
    expect(recovery.status).toBe(200);
    const recovered = (await recovery.json()) as PanelAccessResponse;
    expect(recovered.access_receipt?.state).toBe("completed");
    expect(recovered.accessGrants).toEqual([]);
    await transport.post("/synthetic-panel/control", { action: "settle-access" });
    expect((await status()).access_receipt?.state).toBe("superseded");
    const repeated = (await (
      await transport.post("/api/panel/access", input)
    ).json()) as PanelAccessResponse;
    expect(repeated.access_receipt?.state).toBe("superseded");
    expect(repeated.accessGrants).toEqual([]);
    expect(transport.fixture.probe()).toMatchObject({ accessMutations: 2, heldAccess: 0 });
  } finally {
    transport.close();
  }
});

test("real HTTP/SSE reconciles a committed 502 by reading state, without repeating its mutation", async () => {
  const transport = startFixture();
  const abort = new AbortController();
  const first = Promise.withResolvers<PanelSnapshot>();
  const observed: PanelSnapshot[] = [];
  try {
    const stream = await transport.post("/api/panel/stream", {});
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const reading = readSnapshots<PanelSnapshot>(
      stream,
      (snapshot) => {
        observed.push(snapshot);
        first.resolve(snapshot);
      },
      abort.signal,
    ).catch((error: unknown) => error);
    const initial = await first.promise;
    expect(initial.workspaces?.[0]?.name).toBe("HTTP 合成測試專案");
    const command = initial.commands?.[0];
    expect(command?.state).toBe("pending");
    expect((await transport.post("/synthetic-panel/control", { action: "lost" })).status).toBe(200);
    const approve = {
      action: "approve",
      command_id: command?.id,
      fingerprint: command?.fingerprint,
    };
    expect((await transport.post("/api/panel/approvals", approve)).status).toBe(502);
    const list = await transport.post("/api/panel/approvals", { action: "list" });
    const reconciled = (await list.json()) as PanelSnapshot;
    expect(reconciled.commands?.[0]?.state).toBe("running");
    expect(transport.fixture.probe().mutations).toBe(1);
    expect(transport.fixture.probe().lists).toBe(1);
    expect(observed).toHaveLength(1);
    // The fixture also refuses an accidental resend after that authoritative state change.
    expect((await transport.post("/api/panel/approvals", approve)).status).toBe(409);
    expect(transport.fixture.probe().mutations).toBe(1);
    await transport.post("/synthetic-panel/control", { action: "offline" });
    expect(await reading).toEqual(new Error("即時連線已中斷。"));
    expect(transport.fixture.probe().activeStreams).toBe(0);
    expect(stream.body?.locked).toBe(false);
  } finally {
    abort.abort();
    transport.close();
  }
});

test("the memory-only HTTP fixture rejects cross-origin, unauthorized, extra-field and privileged requests", async () => {
  const transport = startFixture();
  try {
    expect(
      (
        await transport.post(
          "/api/panel/approvals",
          { action: "list" },
          { origin: "https://invalid.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await transport.post("/api/panel/stream", {}, { authorization: "Bearer invalid" })).status,
    ).toBe(401);
    expect(
      (
        await transport.post("/synthetic-panel/control", {
          action: "pending",
          workspace: "private",
        })
      ).status,
    ).toBe(400);
    expect((await transport.post("/api/panel/mount", { action: "mount" })).status).toBe(404);
    expect(
      (await transport.post("/api/panel/approvals", { action: "list", execute: true })).status,
    ).toBe(400);
    expect((await fetch(`${transport.origin}/api/panel/stream`)).status).toBe(403);
    expect(
      (await transport.post("/api/panel/approvals", { action: "list" }, { host: "localhost" }))
        .status,
    ).toBe(404);
    expect((await transport.post("/synthetic-panel/control", { action: "invalid" })).status).toBe(
      200,
    );
    expect((await transport.post("/api/panel/approvals", { action: "list" })).status).toBe(401);
    expect(transport.fixture.probe()).toMatchObject({
      mutations: 0,
      lists: 0,
      streams: 0,
      activeStreams: 0,
    });
  } finally {
    transport.close();
  }
});

test("a pending HTTP decision stays unresolved through list and unrelated snapshots until it settles", async () => {
  const transport = startFixture();
  try {
    const initial = (await (
      await transport.post("/api/panel/approvals", { action: "list" })
    ).json()) as PanelSnapshot;
    const command = initial.commands?.[0];
    expect(command).toBeDefined();
    await transport.post("/synthetic-panel/control", { action: "uncertain" });
    const decision = {
      action: "approve",
      command_id: command?.id,
      fingerprint: command?.fingerprint,
    };
    expect((await transport.post("/api/panel/approvals", decision)).status).toBe(502);
    await transport.post("/synthetic-panel/control", { action: "pending" });
    const unresolved = (await (
      await transport.post("/api/panel/approvals", { action: "list" })
    ).json()) as PanelSnapshot;
    expect(unresolved.commands?.find((item) => item.id === command?.id)?.state).toBe("pending");
    expect(unresolved.commands).toHaveLength(2);
    expect((await transport.post("/api/panel/approvals", decision)).status).toBe(409);
    expect(transport.fixture.probe().mutations).toBe(1);
    await transport.post("/synthetic-panel/control", { action: "settle" });
    const settled = (await (
      await transport.post("/api/panel/approvals", { action: "list" })
    ).json()) as PanelSnapshot;
    expect(settled.commands?.find((item) => item.id === command?.id)?.state).toBe("running");
    expect(transport.fixture.probe().mutations).toBe(1);
  } finally {
    transport.close();
  }
});

test("a successful held HTTP list can arrive after SSE EOF without restoring a data channel", async () => {
  const transport = startFixture();
  const abort = new AbortController();
  const first = Promise.withResolvers<PanelSnapshot>();
  try {
    const stream = await transport.post("/api/panel/stream", {});
    const reading = readSnapshots<PanelSnapshot>(stream, first.resolve, abort.signal).catch(
      (error: unknown) => error,
    );
    const initial = await first.promise;
    await transport.post("/synthetic-panel/control", { action: "hold-list" });
    const late = transport.post("/api/panel/approvals", { action: "list" });
    for (let retry = 0; retry < 20 && transport.fixture.probe().heldLists !== 1; retry++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(transport.fixture.probe().heldLists).toBe(1);
    await transport.post("/synthetic-panel/control", { action: "offline" });
    expect(await reading).toEqual(new Error("即時連線已中斷。"));
    expect(transport.fixture.probe().activeStreams).toBe(0);
    await transport.post("/synthetic-panel/control", { action: "release-list" });
    const response = await late;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(initial);
    expect(transport.fixture.probe()).toMatchObject({ heldLists: 0, online: false, mutations: 0 });
  } finally {
    abort.abort();
    transport.close();
  }
});

test("a held catalog failure arrives after EOF and reset clears it without reusing request IDs", async () => {
  const transport = startFixture();
  const abort = new AbortController();
  const first = Promise.withResolvers<PanelSnapshot>();
  try {
    const stream = await transport.post("/api/panel/stream", {});
    const reading = readSnapshots<PanelSnapshot>(stream, first.resolve, abort.signal).catch(
      (error: unknown) => error,
    );
    const initial = await first.promise;
    const oldCommand = initial.commands?.[0];
    await transport.post("/synthetic-panel/control", { action: "hold-catalog" });
    const catalog = transport.post("/api/panel/mcp", { action: "list" });
    for (let retry = 0; retry < 20 && transport.fixture.probe().heldCatalogs !== 1; retry++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(transport.fixture.probe().heldCatalogs).toBe(1);
    await transport.post("/synthetic-panel/control", { action: "offline" });
    expect(await reading).toEqual(new Error("即時連線已中斷。"));
    await transport.post("/synthetic-panel/control", { action: "release-catalog-failure" });
    expect((await catalog).status).toBe(503);
    expect(transport.fixture.probe()).toMatchObject({ heldCatalogs: 0, online: false });
    await transport.post("/synthetic-panel/control", { action: "reset" });
    expect(transport.fixture.probe()).toMatchObject({
      mutations: 0,
      lists: 0,
      streams: 0,
      online: true,
      authorized: true,
    });
    const current = (await (
      await transport.post("/api/panel/approvals", { action: "list" })
    ).json()) as PanelSnapshot;
    expect(current.commands?.[0]?.id).not.toBe(oldCommand?.id);
    expect(
      (
        await transport.post("/api/panel/approvals", {
          action: "approve",
          command_id: oldCommand?.id,
          fingerprint: oldCommand?.fingerprint,
        })
      ).status,
    ).toBe(409);
    expect(transport.fixture.probe().mutations).toBe(0);
  } finally {
    abort.abort();
    transport.close();
  }
});
