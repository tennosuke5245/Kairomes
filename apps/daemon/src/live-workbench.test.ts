import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import {
  type ActivitySnapshot,
  FileChangeResultSchema,
  type PanelSnapshot,
  readSnapshots,
  TerminalResultSchema,
} from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture } from "../../../tests/fixtures.ts";
import { ActivityStore } from "./activity.ts";
import { PanelPairing } from "./pairing.ts";
import { startWorkbench } from "./preview.ts";
import { snapshotStream } from "./snapshot-stream.ts";
import { ToolService } from "./tools.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for live state");
    await Bun.sleep(10);
  }
}

test("activity retains the exact read result, excludes polling, and bounds history/results", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const result = await service.call(
      "file_read",
      { workspace_id: f.workspace.id, path: "README.md", start_line: 2, max_lines: 1 },
      "mcp",
    );
    if (!result.structuredContent) throw new Error("Expected file result");
    const entry = service.activity.list()[0];
    expect(entry?.source).toBe("mcp");
    expect(entry?.state).toBe("completed");
    expect(entry?.focusSeq).toBeGreaterThan(0);
    await writeFile(`${f.root}/README.md`, "a new version");
    expect(service.activity.result(entry?.resultId ?? "")).toEqual(result.structuredContent);
    const seq = service.activity.seq;
    await service.call("terminal_list", {}, "mcp");
    await service.call("kairomes_status", {}, "mcp");
    expect(service.activity.seq).toBe(seq);
    await service.call("file_read", { workspace_id: f.workspace.id, path: "missing.txt" }, "mcp");
    expect(service.activity.list()[0]?.state).toBe("failed");
    f.registry.remove(f.workspace.id);
    expect(() => service.activityResult(entry?.resultId ?? "")).toThrow();
  } finally {
    await service.close();
    await f.dispose();
  }
  let now = 1;
  const store = new ActivityStore(() => now);
  const first = store.start("workspace_list", {}, "mcp");
  store.finish(first, { kind: "workspaces", workspaces: [] });
  for (let i = 0; i < 250; i++)
    store.finish(store.start("workspace_list", {}, "local-ui"), {
      kind: "workspaces",
      workspaces: [],
    });
  expect(store.list()).toHaveLength(200);
  expect(() => store.result(first ?? "")).toThrow();
  expect(store.list().filter((entry) => entry.focusSeq > 0)).toHaveLength(0);
  const recent = store.list()[0]?.id ?? "";
  expect(store.result(recent).kind).toBe("workspaces");
  now += 300001;
  expect(() => store.result(recent)).toThrow();
  store.close();
});

test("pairing is one-time, extension-bound, safely renewable, revocable and rate-limited", () => {
  let now = 1;
  const pairing = new PanelPairing("a".repeat(32), () => now);
  expect(() => pairing.create("b".repeat(32))).toThrow();
  const code = pairing.create("a".repeat(32));
  const token = pairing.redeem(code);
  expect(token).not.toBe(code);
  expect(pairing.valid(token)).toBe(true);
  expect(pairing.valid(code)).toBe(false);
  expect(() => pairing.redeem(code)).toThrow();
  pairing.revoke(token);
  expect(pairing.valid(token)).toBe(false);
  const expired = pairing.create("a".repeat(32));
  now += 120001;
  let expiredFailure: unknown;
  try {
    pairing.redeem(expired);
  } catch (error) {
    expiredFailure = error;
  }
  expect(expiredFailure).toMatchObject({ code: "PAIRING_EXPIRED" });
  const renewed = pairing.renew(expired);
  const renewedGrant = pairing.redeem(renewed);
  expect(pairing.valid(renewedGrant)).toBe(true);
  expect(() => pairing.renew(expired)).toThrow();
  const fresh = pairing.create("a".repeat(32));
  for (let i = 0; i < 30; i++) expect(() => pairing.redeem("b".repeat(64))).toThrow();
  expect(() => pairing.redeem(fresh)).toThrow();
  now += 60001;
  const grant = pairing.redeem(fresh);
  now += 12 * 60 * 60_000;
  expect(pairing.valid(grant)).toBe(false);
  pairing.close();
});

test("terminal output and state updates never advance the user's follow target", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const result = await service.call(
      "terminal_start",
      { workspace_id: f.workspace.id, shell: process.platform === "win32" ? "cmd" : "bash" },
      "mcp",
    );
    const session = TerminalResultSchema.parse(result.structuredContent).session;
    const seq = service.activity.list()[0]?.focusSeq;
    service.activity.terminal({ ...session, state: "running" }, "mcp", "state");
    service.activity.terminal({ ...session, state: "running" }, "mcp", "output");
    expect(service.activity.list()[0]?.focusSeq).toBe(seq);
    service.activity.terminal({ ...session, state: "running" }, "local-ui", "input");
    expect(service.activity.list()[0]?.source).toBe("mcp");
    expect(service.activity.list()[0]?.focusSeq).toBe(seq);
    service.activity.terminal({ ...session, state: "running" }, "mcp", "input");
    expect(service.activity.list()[0]?.focusSeq).toBeGreaterThan(seq ?? 0);
    const inputSeq = service.activity.seq;
    await service.call("terminal_poll", { session_id: session.id, cursor: 0 }, "mcp");
    expect(service.activity.seq).toBe(inputSeq);
  } finally {
    await service.close();
    await f.dispose();
  }
});

test("snapshot subscriptions send initial state, coalesce updates, and clean up cancellation", async () => {
  let state = 0;
  const listeners = new Set<() => void>();
  const connections = new Set<() => void>();
  const abort = new AbortController();
  const response = snapshotStream(
    new Request("http://127.0.0.1/", { signal: abort.signal }),
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => ({ state }),
    {},
    connections,
  );
  const snapshots: { state: number }[] = [];
  const reading = readSnapshots<{ state: number }>(
    response,
    (data) => snapshots.push(data),
    abort.signal,
  ).catch(() => {});
  await until(() => snapshots.length === 1);
  expect(snapshots[0]).toEqual({ state: 0 });
  for (let i = 0; i < 20; i++) {
    state++;
    for (const fn of listeners) fn();
  }
  await until(() => snapshots.length === 2);
  expect(snapshots[1]).toEqual({ state: 20 });
  abort.abort();
  await reading;
  expect(connections.size).toBe(0);
  expect(listeners.size).toBe(0);
  const canceled = snapshotStream(
    new Request("http://127.0.0.1/"),
    () => () => {},
    () => ({}),
    {},
    connections,
  );
  await canceled.body?.cancel();
  expect(connections.size).toBe(0);
  for (let i = 0; i < 12; i++) connections.add(() => {});
  expect(
    snapshotStream(
      new Request("http://127.0.0.1/"),
      () => () => {},
      () => ({}),
      {},
      connections,
    ).status,
  ).toBe(429);
});

test("MCP activity follows exact targets while native approval has independent, origin-bound authority", async () => {
  const f = await fixture();
  const extensionId = "a".repeat(32);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const app = await startWorkbench(
    f.registry,
    "<html><head><!--KAIROMES_MODE--></head></html>",
    0,
    extensionId,
  );
  const client = new Client({ name: "live-workbench-test", version: "1" });
  const abort = new AbortController();
  const readers: Promise<unknown>[] = [];
  try {
    const c = await readWorkbenchConnection(f.state);
    const post = (route: string, token: string, body: unknown = {}, origin = c.origin) =>
      fetch(`${c.origin}${route}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    const create = { extensionId };
    for (const token of [c.uiToken, c.mcpToken])
      expect((await post("/api/pairing/create", token, create)).status).toBe(401);
    const pairLink = await (await post("/api/pairing/create", c.adminToken, create)).json();
    const fragment = new URLSearchParams(new URL(pairLink.pairingUrl).hash.slice(1));
    const pairBody = { code: fragment.get("code"), instanceId: c.instanceId };
    expect((await post("/api/panel/pair", "", pairBody)).status).toBe(403);
    expect((await post("/api/panel/pair/renew", "", pairBody)).status).toBe(403);
    expect(
      (await post("/api/panel/pair", "", pairBody, `chrome-extension://${"b".repeat(32)}`)).status,
    ).toBe(403);
    expect(
      (await post("/api/panel/pair/renew", "", pairBody, `chrome-extension://${"b".repeat(32)}`))
        .status,
    ).toBe(403);
    const earlyRenew = await post("/api/panel/pair/renew", "", pairBody, extensionOrigin);
    expect(earlyRenew.status).toBe(400);
    expect(await earlyRenew.json()).toMatchObject({ code: "PAIRING_NOT_EXPIRED" });
    expect(
      (
        await post(
          "/api/panel/pair",
          "",
          { ...pairBody, instanceId: crypto.randomUUID() },
          extensionOrigin,
        )
      ).status,
    ).toBe(400);
    const paired = await post("/api/panel/pair", "", pairBody, extensionOrigin);
    expect(paired.status).toBe(200);
    expect(paired.headers.get("Access-Control-Allow-Origin")).toBe(extensionOrigin);
    const panel = await paired.json();
    expect(panel.panelToken).not.toBe(c.adminToken);
    expect(JSON.stringify(panel)).not.toContain(c.adminToken);
    expect(JSON.stringify(panel)).not.toContain(c.mcpToken);
    const enableAccess = { action: "enable", workspace_id: f.workspace.id, minutes: 60 };
    for (const token of [c.uiToken, c.mcpToken, c.adminToken])
      expect((await post("/api/panel/access", token, enableAccess, extensionOrigin)).status).toBe(
        401,
      );
    expect((await post("/api/panel/access", panel.panelToken, enableAccess)).status).toBe(403);
    expect((await post("/api/panel/pair", "", pairBody, extensionOrigin)).status).toBe(400);
    for (const token of [c.uiToken, c.mcpToken, c.adminToken])
      expect(
        (await post("/api/panel/approvals", token, { action: "list" }, extensionOrigin)).status,
      ).toBe(401);
    expect((await post("/api/approvals", panel.panelToken, { action: "list" })).status).toBe(401);
    expect((await post("/api/panel/approvals", panel.panelToken, { action: "list" })).status).toBe(
      403,
    );
    expect((await post("/api/activity/stream", c.mcpToken)).status).toBe(401);
    const activities: ActivitySnapshot[] = [];
    const approvals: PanelSnapshot[] = [];
    readers.push(
      readSnapshots<ActivitySnapshot>(
        await post("/api/activity/stream", c.uiToken),
        (data) => activities.push(data),
        abort.signal,
      ).catch(() => {}),
    );
    readers.push(
      readSnapshots<PanelSnapshot>(
        await post("/api/panel/stream", panel.panelToken, {}, extensionOrigin),
        (data) => approvals.push(data),
        abort.signal,
      ).catch(() => {}),
    );
    await until(() => activities.length > 0 && approvals.length > 0);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${c.origin}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${c.mcpToken}` } },
      }),
    );
    const read = await client.callTool({
      name: "file_read",
      arguments: { workspace_id: f.workspace.id, path: "README.md", start_line: 2, max_lines: 1 },
    });
    await until(
      () =>
        activities
          .at(-1)
          ?.entries.some((entry) => entry.tool === "file_read" && entry.state === "completed") ??
        false,
    );
    const entry = activities.at(-1)?.entries.find((entry) => entry.tool === "file_read");
    expect(entry?.source).toBe("mcp");
    expect(
      await (await post("/api/activity/result", c.uiToken, { id: entry?.resultId })).json(),
    ).toEqual(read.structuredContent);
    const started = await client.callTool({
      name: "terminal_start",
      arguments: {
        workspace_id: f.workspace.id,
        shell: process.platform === "win32" ? "cmd" : "bash",
      },
    });
    const session = TerminalResultSchema.parse(started.structuredContent).session;
    await until(
      () =>
        approvals.at(-1)?.sessions[0]?.id === session.id &&
        activities.at(-1)?.sessions[0]?.id === session.id,
    );
    expect(activities.at(-1)?.sessions[0]?.state).toBe("pending");
    expect(activities.at(-1)?.sessions[0]).not.toHaveProperty("fingerprint");
    expect(activities.at(-1)?.sessions[0]).not.toHaveProperty("absolute_cwd");
    const fingerprint = approvals.at(-1)?.sessions[0]?.fingerprint;
    const decision = { action: "approve", session_id: session.id, fingerprint };
    expect(
      (
        await post(
          "/api/panel/approvals",
          panel.panelToken,
          { ...decision, fingerprint: "b".repeat(64) },
          extensionOrigin,
        )
      ).status,
    ).toBe(400);
    const decided = await post("/api/panel/approvals", panel.panelToken, decision, extensionOrigin);
    expect(decided.status).toBe(200);
    expect((await decided.json()).sessions[0].state).toBe("running");
    expect(
      (await post("/api/panel/approvals", panel.panelToken, decision, extensionOrigin)).status,
    ).toBe(400);
    await client.callTool({
      name: "terminal_input",
      arguments: {
        session_id: session.id,
        input_id: crypto.randomUUID(),
        data: "echo KAIROMES_LIVE_TEST\r",
      },
    });
    await until(() => activities.at(-1)?.entries[0]?.state === "running");
    let output = "";
    for (let attempt = 0; attempt < 30 && !output.includes("KAIROMES_LIVE_TEST"); attempt++) {
      const polled = await client.callTool({
        name: "terminal_poll",
        arguments: { session_id: session.id, cursor: 0 },
      });
      output = TerminalResultSchema.parse(polled.structuredContent).output;
      if (!output.includes("KAIROMES_LIVE_TEST")) await Bun.sleep(50);
    }
    expect(output).toContain("KAIROMES_LIVE_TEST");
    const stopped = await post(
      "/api/panel/approvals",
      panel.panelToken,
      { action: "stop", session_id: session.id },
      extensionOrigin,
    );
    expect((await stopped.json()).sessions[0].state).toBe("stopped");
    const fullAccess = await post(
      "/api/panel/access",
      panel.panelToken,
      enableAccess,
      extensionOrigin,
    );
    expect(fullAccess.status).toBe(200);
    expect((await fullAccess.json()).accessGrants).toHaveLength(1);
    const auto = await client.callTool({
      name: "terminal_start",
      arguments: {
        workspace_id: f.workspace.id,
        shell: process.platform === "win32" ? "cmd" : "bash",
      },
    });
    const autoId = TerminalResultSchema.parse(auto.structuredContent).session.id;
    expect(TerminalResultSchema.parse(auto.structuredContent).session.state).toBe("running");
    const disabled = await post(
      "/api/panel/access",
      panel.panelToken,
      { action: "disable", workspace_id: f.workspace.id },
      extensionOrigin,
    );
    expect(
      (await disabled.json()).sessions.find((s: { id: string }) => s.id === autoId).state,
    ).toBe("stopped");
    const recovered = await post("/api/activity/stream", c.uiToken);
    const recoveryAbort = new AbortController();
    let recoveredState: ActivitySnapshot | undefined;
    await readSnapshots<ActivitySnapshot>(
      recovered,
      (data) => {
        recoveredState = data;
        recoveryAbort.abort();
      },
      recoveryAbort.signal,
    );
    expect(recoveredState?.sessions[0]?.state).toBe("stopped");
    expect(
      (await post("/api/panel/disconnect", panel.panelToken, {}, extensionOrigin)).status,
    ).toBe(200);
    expect(
      (await post("/api/panel/approvals", panel.panelToken, { action: "list" }, extensionOrigin))
        .status,
    ).toBe(401);
  } finally {
    abort.abort();
    await Promise.allSettled(readers);
    await client.close();
    await app.close();
    await f.dispose();
  }
}, 20000);

test("panel frames stay under the 2 MiB stream limit with twelve retained ~180 KiB diffs", async () => {
  const f = await fixture();
  const extensionId = "a".repeat(32);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const app = await startWorkbench(
    f.registry,
    "<html><head><!--KAIROMES_MODE--></head></html>",
    0,
    extensionId,
  );
  const client = new Client({ name: "panel-frame-test", version: "1" });
  const abort = new AbortController();
  let reading: Promise<void> | undefined;
  try {
    const c = await readWorkbenchConnection(f.state);
    const post = (route: string, token: string, body: unknown = {}, origin = c.origin) =>
      fetch(`${c.origin}${route}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${c.origin}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${c.mcpToken}` } },
      }),
    );
    const pairLink = await (
      await post("/api/pairing/create", c.adminToken, { extensionId })
    ).json();
    const fragment = new URLSearchParams(new URL(pairLink.pairingUrl).hash.slice(1));
    const panel = await (
      await post(
        "/api/panel/pair",
        "",
        { code: fragment.get("code"), instanceId: c.instanceId },
        extensionOrigin,
      )
    ).json();
    const frames: PanelSnapshot[] = [];
    let largest = 0;
    let streamError: unknown;
    // readSnapshots enforces the 2 MiB frame limit; an oversized frame ends the stream.
    reading = readSnapshots<PanelSnapshot>(
      await post("/api/panel/stream", panel.panelToken, {}, extensionOrigin),
      (data) => {
        largest = Math.max(largest, Buffer.byteLength(JSON.stringify(data)));
        frames.push(data);
      },
      abort.signal,
    ).catch((error) => {
      streamError = error;
    });
    await until(() => frames.length > 0);

    // Each batch creates three ~60 KB files, so its review diff is about 180 KiB.
    const content = Array.from({ length: 600 }, (_, line) =>
      `line ${line} of the panel frame size fixture `.padEnd(99, "x"),
    ).join("\n");
    const ids: string[] = [];
    for (let batch = 0; batch < 12; batch++) {
      const result = FileChangeResultSchema.parse(
        (
          await client.callTool({
            name: "file_change_request",
            arguments: {
              workspace_id: f.workspace.id,
              request_id: crypto.randomUUID(),
              summary: `大型變更 ${batch}`,
              changes: [0, 1, 2].map((file) => ({
                operation: "write",
                path: `large-${batch}-${file}.txt`,
                content,
              })),
            },
          })
        ).structuredContent,
      );
      ids.push(result.change.id);
      // Only four may wait at once; finish the first eight so twelve stay retained.
      if (batch < 4) {
        const review = (
          (await (
            await post(
              "/api/panel/approvals",
              panel.panelToken,
              { action: "list" },
              extensionOrigin,
            )
          ).json()) as PanelSnapshot
        ).changes?.find((item) => item.id === result.change.id);
        expect(review?.diff.length).toBeGreaterThan(180_000);
        expect(
          (
            await post(
              "/api/panel/approvals",
              panel.panelToken,
              {
                action: "deny",
                change_id: result.change.id,
                fingerprint: review?.fingerprint,
                reason: "拆成較小批次",
              },
              extensionOrigin,
            )
          ).status,
        ).toBe(200);
      } else if (batch < 8) {
        await client.callTool({
          name: "file_change_cancel",
          arguments: { change_id: result.change.id },
        });
      }
    }
    // A pending command and terminal join the frame so every kind is checked for expiry.
    await client.callTool({
      name: "command_request",
      arguments: {
        workspace_id: f.workspace.id,
        request_id: crypto.randomUUID(),
        argv: ["bun", "-e", "console.log('never runs')"],
        timeout_ms: 5000,
      },
    });
    await client.callTool({
      name: "terminal_start",
      arguments: {
        workspace_id: f.workspace.id,
        shell: process.platform === "win32" ? "cmd" : "bash",
      },
    });
    await until(
      () =>
        !!streamError ||
        ((frames.at(-1)?.changes?.length === 12 &&
          frames.at(-1)?.commands?.[0]?.state === "pending" &&
          frames.at(-1)?.sessions[0]?.state === "pending") ??
          false),
    );
    expect(streamError).toBeUndefined();
    expect(largest).toBeLessThan(2 * 1024 * 1024);
    const latest = frames.at(-1) as PanelSnapshot;
    const changes = latest.changes ?? [];
    expect(changes.map((item) => item.id).sort()).toEqual([...ids].sort());
    for (const change of changes) {
      if (change.state === "pending") {
        expect(change.diff_available).toBe(true);
        expect(change.diff.length).toBeGreaterThan(180_000);
        expect(change.diff).toContain(`+${content.split("\n").at(-1)}`);
      } else {
        expect(["denied", "cancelled"]).toContain(change.state);
        expect(change).toMatchObject({ diff: "", diff_available: false });
        expect(change.files).toHaveLength(3);
        expect(change.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    expect(changes.filter((item) => item.state === "pending")).toHaveLength(4);
    expect(
      changes.filter((item) => item.denial_reason === "拆成較小批次").map((item) => item.id),
    ).toEqual(ids.slice(0, 4));
    // The approvals response uses the same slim snapshot.
    const listed = await (
      await post("/api/panel/approvals", panel.panelToken, { action: "list" }, extensionOrigin)
    ).text();
    expect(Buffer.byteLength(listed)).toBeLessThan(2 * 1024 * 1024);

    // Every pending item carries its approval deadline for countdowns.
    const now = Date.now();
    const pending = [
      ...changes,
      ...(latest.commands ?? []),
      ...latest.sessions,
      ...(latest.imports ?? []),
    ].filter((item) => item.state === "pending");
    expect(pending).toHaveLength(6);
    for (const item of pending) {
      expect(typeof item.expires_at).toBe("number");
      expect(item.expires_at).toBeGreaterThan(now);
      expect(item.expires_at).toBeLessThanOrEqual(now + 5 * 60_000);
    }

    // So does every autonomy grant. File autonomy applies the four waiting batches.
    const granted = await post(
      "/api/panel/access",
      panel.panelToken,
      { action: "enable", workspace_id: f.workspace.id, level: "files", minutes: 15 },
      extensionOrigin,
    );
    expect(granted.status).toBe(200);
    await until(
      () =>
        !!streamError ||
        ((frames.at(-1)?.accessGrants?.length === 1 &&
          frames.at(-1)?.changes?.every((item) => item.state !== "pending")) ??
          false),
    );
    expect(streamError).toBeUndefined();
    const grant = frames.at(-1)?.accessGrants?.[0];
    expect(grant?.level).toBe("files");
    expect(grant?.expires_at).toBeGreaterThan(now + 14 * 60_000);
    expect(grant?.expires_at).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    await until(
      () => frames.at(-1)?.changes?.filter((item) => item.state === "applied").length === 4,
    );
    expect(frames.at(-1)?.changes?.every((item) => !item.diff_available && !item.diff)).toBe(true);
    expect(largest).toBeLessThan(2 * 1024 * 1024);
  } finally {
    abort.abort();
    await reading;
    await client.close();
    await app.close();
    await f.dispose();
  }
}, 30_000);
