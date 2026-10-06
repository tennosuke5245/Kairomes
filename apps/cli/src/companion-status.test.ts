import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadWidget, readWorkbenchConnection, startWorkbench } from "@kairomes/daemon";
import { type CompanionStatus, DIAGNOSTIC_CHECK_IDS, VERSION } from "@kairomes/protocol";
import { WorkspaceRegistry } from "@kairomes/workspace-core";
import { fixture } from "../../../tests/fixtures.ts";
import { readCompanionConnection, startCompanionApplication } from "./companion.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
// Response bodies are checked field by field below, as in companion.test.ts.
type Json = Awaited<ReturnType<Response["json"]>>;

const extensionId = "a".repeat(32);
const extensionOrigin = `chrome-extension://${extensionId}`;

async function companion(
  f: Fixture,
  options: Partial<Parameters<typeof startCompanionApplication>[0]> = {},
) {
  const app = await startCompanionApplication({
    dataDirectory: f.state,
    openBrowser: false,
    autoStartTunnel: false,
    ...options,
  });
  const connection = await readCompanionConnection(f.state);
  const post = async (route: string, body: object) => {
    const response = await fetch(`${connection.origin}${route}`, {
      method: "POST",
      headers: {
        Origin: connection.origin,
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  return {
    app,
    connection,
    action: (body: object) => post("/api/action", body),
    status: async () => (await post("/api/status", {})).body as unknown as CompanionStatus,
  };
}

async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(20);
  }
}

async function workbenchPost(
  f: Fixture,
  route: string,
  token: string,
  body: object,
  origin?: string,
) {
  const workbench = await readWorkbenchConnection(f.state);
  const response = await fetch(`${workbench.origin}${route}`, {
    method: "POST",
    headers: {
      Origin: origin ?? workbench.origin,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

test("status attention carries counts and grant metadata only, never approval details", async () => {
  const f = await fixture();
  await writeFile(path.join(f.state, "companion-settings.json"), JSON.stringify({ extensionId }));
  const c = await companion(f);
  try {
    const health = await (await fetch(`${c.connection.origin}/healthz`)).json();
    expect(health.version).toBe(VERSION);
    const initial = await c.status();
    expect(initial.workbenchVersion).toBe(VERSION);
    expect(initial.versionMismatch).toBe(false);
    expect(initial.attention).toEqual({
      pending: { total: 0, byWorkspace: [] },
      grants: [],
      grantsKnown: true,
      lastMcpRequestAt: null,
      pairedPanels: 0,
    });

    const workbench = await readWorkbenchConnection(f.state);
    const marker = "attention-argv-marker";
    const requested = await workbenchPost(f, "/api/tools", workbench.uiToken, {
      name: "command_request",
      arguments: {
        workspace_id: f.workspace.id,
        request_id: crypto.randomUUID(),
        argv: [process.execPath, "-e", `console.log(${JSON.stringify(marker)})`],
      },
    });
    expect(requested.status).toBe(200);
    const admin = await workbenchPost(f, "/api/approvals", workbench.adminToken, {
      action: "list",
    });
    const fingerprint = admin.body.commands[0].fingerprint as string;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const pairing = await c.action({ action: "create_pairing" });
    expect(pairing.status).toBe(200);
    expect(pairing.body.expiresInSeconds).toBe(120);
    const code = new URLSearchParams(new URL(pairing.body.pairingUrl).hash.slice(1)).get("code");
    const paired = await workbenchPost(
      f,
      "/api/panel/pair",
      "",
      { code, instanceId: workbench.instanceId },
      extensionOrigin,
    );
    expect(paired.status).toBe(200);
    const panelToken = paired.body.panelToken as string;
    const before = Date.now();
    const enabled = await workbenchPost(
      f,
      "/api/panel/access",
      panelToken,
      { action: "enable", workspace_id: f.workspace.id, level: "files", minutes: 15 },
      extensionOrigin,
    );
    expect(enabled.status).toBe(200);
    const grantId = enabled.body.accessGrants[0].id as string;

    const granted = await c.status();
    expect(granted.attention.pending).toEqual({
      total: 1,
      byWorkspace: [{ workspace_id: f.workspace.id, count: 1 }],
    });
    expect(granted.attention.pairedPanels).toBe(1);
    expect(granted.attention.grantsKnown).toBe(true);
    expect(granted.attention.grants).toHaveLength(1);
    const grant = granted.attention.grants?.[0];
    expect(Object.keys(grant ?? {}).sort()).toEqual(["expires_at", "level", "workspace_id"]);
    expect(grant).toMatchObject({ workspace_id: f.workspace.id, level: "files" });
    const expiresAt = Date.parse(grant?.expires_at ?? "");
    expect(expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    const text = JSON.stringify(granted);
    for (const secret of [
      marker,
      fingerprint,
      grantId,
      panelToken,
      f.root,
      workbench.adminToken,
      workbench.uiToken,
      workbench.origin,
      pairing.body.pairingUrl,
    ])
      expect(text).not.toContain(secret);

    const disconnected = await workbenchPost(
      f,
      "/api/panel/disconnect",
      panelToken,
      {},
      extensionOrigin,
    );
    expect(disconnected.status).toBe(200);
    const revoked = await c.status();
    expect(revoked.attention.pairedPanels).toBe(0);
    expect(revoked.attention.grants).toEqual([]);
    expect(revoked.attention.pending?.total).toBe(1);
  } finally {
    await c.app.close();
    await f.dispose();
  }
}, 30_000);

test("projects can be renamed, and only workspace_details carries absolute roots", async () => {
  const f = await fixture();
  const c = await companion(f);
  try {
    for (const [body, code] of [
      [{ workspace_id: f.workspace.id, name: "bad\nname" }, "INVALID_NAME"],
      [{ workspace_id: f.workspace.id, name: "   " }, "VALIDATION"],
      [{ workspace_id: f.workspace.id, name: "x".repeat(81) }, "VALIDATION"],
      [{ workspace_id: "not-a-uuid", name: "名稱" }, "VALIDATION"],
      [{ workspace_id: crypto.randomUUID(), name: "名稱" }, "WORKSPACE_NOT_FOUND"],
      [{ workspaceId: f.workspace.id, name: "名稱" }, "VALIDATION"],
    ] as const) {
      const response = await c.action({ action: "workspace_rename", ...body });
      expect([response.status, response.body.code]).toEqual([400, code]);
    }
    const renamed = await c.action({
      action: "workspace_rename",
      workspace_id: f.workspace.id,
      name: "  新名稱  ",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.workspace).toEqual({ ...f.workspace, name: "新名稱" });

    const status = await c.status();
    expect(status.workspaces).toEqual([{ ...f.workspace, name: "新名稱" }]);
    expect(JSON.stringify(status)).not.toContain(f.root);

    const details = await c.action({ action: "workspace_details" });
    expect(details.status).toBe(200);
    expect(details.body.workspaces).toEqual([{ id: f.workspace.id, name: "新名稱", root: f.root }]);
    expect((await c.action({ action: "workspace_details", extra: 1 })).status).toBe(400);

    // The model-facing listing still reports the new name and never the root.
    const workbench = await readWorkbenchConnection(f.state);
    const listing = await workbenchPost(f, "/api/tools", workbench.uiToken, {
      name: "workspace_list",
      arguments: {},
    });
    expect(listing.body.structuredContent.workspaces).toEqual([
      {
        ...f.workspace,
        name: "新名稱",
        approval: { mode: "per_request", expires_at: null },
      },
    ]);
    expect(JSON.stringify(listing.body)).not.toContain(f.root);
  } finally {
    await c.app.close();
    await f.dispose();
  }
}, 20_000);

test("diagnostics action returns fixed checks and a summary without local secrets", async () => {
  const f = await fixture();
  const c = await companion(f, {
    tunnelCommand: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  });
  try {
    const stopped = await c.action({ action: "diagnostics" });
    expect(stopped.status).toBe(200);
    expect(stopped.body.checks.map((check: Json) => check.id)).toEqual([...DIAGNOSTIC_CHECK_IDS]);
    const checks = Object.fromEntries(stopped.body.checks.map((check: Json) => [check.id, check]));
    expect(checks).toMatchObject({
      data_dir: { state: "ok", code: "data_dir_ok" },
      companion: { state: "ok", code: "companion_running", version: VERSION },
      workbench: { state: "ok", code: "workbench_running", version: VERSION },
      tunnel_client: { state: "ok", code: "tunnel_client_found" },
      tunnel: { state: "warn", code: "tunnel_stopped", fix: "start_tunnel" },
      mcp_config: { state: "ok", code: "mcp_config_absent" },
      workspaces: { state: "ok", code: "workspaces_ok", count: 1 },
    });
    expect(stopped.body.summary.split("\n")[0]).toBe(`Kairomes ${VERSION} 診斷摘要`);

    expect((await c.action({ action: "start_tunnel" })).status).toBe(200);
    const running = await until(c.status, (status) => status.tunnel.state === "running");
    expect(Date.parse(running.tunnel.startedAt ?? "")).toBeGreaterThan(0);
    expect(running.tunnel.reason).toBeNull();
    const live = await c.action({ action: "diagnostics" });
    expect(live.body.summary).toContain("tunnel: ok tunnel_running");

    // Desktop passes its own version: a Companion and workbench left from another version are
    // reported with their fix, and the summary is headed with Desktop's version.
    const newer = await c.action({ action: "diagnostics", expectedVersion: "99.0.0" });
    expect(newer.status).toBe(200);
    const newerChecks = Object.fromEntries(
      newer.body.checks.map((check: Json) => [check.id, check]),
    );
    expect(newerChecks.companion).toEqual({
      id: "companion",
      state: "warn",
      code: "companion_version_mismatch",
      fix: "restart_runtime",
      version: VERSION,
    });
    expect(newerChecks.workbench).toEqual({
      id: "workbench",
      state: "warn",
      code: "workbench_version_mismatch",
      fix: "restart_runtime",
      version: VERSION,
    });
    expect(newer.body.summary.split("\n")[0]).toBe("Kairomes 99.0.0 診斷摘要");
    expect(newer.body.summary).toContain(
      `companion: warn companion_version_mismatch version=${VERSION} fix=restart_runtime`,
    );
    const same = await c.action({ action: "diagnostics", expectedVersion: VERSION });
    expect(same.body.checks.find((check: Json) => check.id === "companion").code).toBe(
      "companion_running",
    );
    for (const expectedVersion of ["latest", "1.0.0\nfixed", "1.0", 1, "9".repeat(80)])
      expect((await c.action({ action: "diagnostics", expectedVersion })).status).toBe(400);

    const workbench = await readWorkbenchConnection(f.state);
    const text = JSON.stringify(live.body);
    for (const secret of [
      f.root,
      f.state,
      f.directory,
      process.execPath,
      c.connection.token,
      c.connection.origin,
      workbench.origin,
      workbench.adminToken,
    ])
      expect(text).not.toContain(secret);
  } finally {
    await c.app.close();
    await f.dispose();
  }
}, 20_000);

test("an external workbench of another version is flagged and its grants stay unknown", async () => {
  const f = await fixture();
  const instanceId = crypto.randomUUID();
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/healthz"
        ? Response.json({ status: "ok", instanceId, version: "0.1.4" })
        : new Response("Not found", { status: 404 }),
  });
  await writeFile(
    path.join(f.state, "workbench-connection.json"),
    JSON.stringify({
      instanceId,
      pid: process.pid,
      origin: `http://127.0.0.1:${fake.port}`,
      uiToken: "a".repeat(64),
      mcpToken: "b".repeat(64),
      adminToken: "c".repeat(64),
    }),
  );
  const c = await companion(f);
  try {
    const status = await c.status();
    expect(status.workbench.state).toBe("external");
    expect(status.workbenchVersion).toBe("0.1.4");
    expect(status.versionMismatch).toBe(true);
    expect(status.workbench.message).toContain("0.1.4");
    expect(status.attention).toEqual({
      pending: null,
      grants: null,
      grantsKnown: false,
      lastMcpRequestAt: null,
      pairedPanels: null,
    });
    const diagnostics = await c.action({ action: "diagnostics" });
    expect(diagnostics.body.checks.find((check: Json) => check.id === "workbench")).toEqual({
      id: "workbench",
      state: "warn",
      code: "workbench_version_mismatch",
      fix: "retry_workbench",
      version: "0.1.4",
    });
  } finally {
    await c.app.close();
    fake.stop(true);
    await f.dispose();
  }
}, 20_000);

const counterScript = (counter: string, body: string) =>
  `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "run\\n");${body}`;
const runs = async (counter: string) =>
  (await readFile(counter, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

for (const [name, body, reason] of [
  ["auth", 'console.error("ERROR: 401 Unauthorized"); process.exit(1);', "auth"],
  [
    "profile",
    "console.error('Error: profile \"kairomes\" not found'); process.exit(2);",
    "profile_missing",
  ],
] as const) {
  test(`Tunnel ${name} failure is classified and never restarted automatically`, async () => {
    const f = await fixture();
    const counter = path.join(f.directory, "tunnel-runs.txt");
    const c = await companion(f, {
      tunnelCommand: [process.execPath, "-e", counterScript(counter, body)],
      tunnelRestartDelaysMs: [50, 50, 50],
    });
    try {
      expect((await c.action({ action: "start_tunnel" })).status).toBe(200);
      const failed = await until(c.status, (status) => status.tunnel.state === "error");
      await Bun.sleep(400);
      const later = await c.status();
      expect(await runs(counter)).toBe(1);
      for (const status of [failed, later])
        expect(status.tunnel).toMatchObject({
          state: "error",
          reason,
          restartCount: 0,
          nextRetryAt: null,
          startedAt: null,
        });
    } finally {
      await c.app.close();
      await f.dispose();
    }
  }, 20_000);
}

test("an early profile-tagged warning does not make a later network exit permanent", async () => {
  const f = await fixture();
  const counter = path.join(f.directory, "tunnel-runs.txt");
  const warning = JSON.stringify({
    level: "WARN",
    profile: "kairomes",
    msg: "MCP session not found; client will reinitialize",
  });
  const c = await companion(f, {
    tunnelCommand: [
      process.execPath,
      "-e",
      counterScript(
        counter,
        `console.error(${JSON.stringify(warning)});
         setTimeout(() => {
           console.error("dial tcp 10.0.0.1:443: connect: connection refused");
           process.exit(1);
         }, 300);`,
      ),
    ],
    tunnelRestartDelaysMs: [300, 300, 300],
  });
  try {
    expect((await c.action({ action: "start_tunnel" })).status).toBe(200);
    const retrying = await until(c.status, (status) => status.tunnel.nextRetryAt !== null);
    expect(retrying.tunnel).toMatchObject({ state: "error", reason: "network" });
    await until(
      () => runs(counter),
      (count) => count >= 2,
    );
  } finally {
    await c.app.close();
    await f.dispose();
  }
}, 20_000);

for (const stoppedByUser of [false, true]) {
  test(`workbench takeover ${stoppedByUser ? "keeps a stopped Tunnel stopped" : "restarts a running Tunnel"}`, async () => {
    const f = await fixture();
    const counter = path.join(f.directory, "tunnel-runs.txt");
    const registry = await WorkspaceRegistry.open(f.state);
    const widget = await loadWidget();
    if (!widget) throw new Error("Test workbench widget is unavailable.");
    const external = await startWorkbench(registry, widget, 0);
    let externalClosed = false;
    const c = await companion(f, {
      autoStartTunnel: true,
      tunnelCommand: [
        process.execPath,
        "-e",
        counterScript(counter, "setInterval(() => {}, 1000);"),
      ],
    });
    try {
      const attached = await until(c.status, (status) => status.tunnel.state === "running");
      expect(attached.workbench.state).toBe("external");
      await until(
        () => runs(counter),
        (count) => count === 1,
      );
      if (stoppedByUser) {
        expect((await c.action({ action: "stop_tunnel" })).status).toBe(200);
        expect((await c.status()).tunnel.state).toBe("stopped");
      }
      await external.close();
      externalClosed = true;
      registry.close();

      // Desktop's background loop polls status; a takeover must not undo the user's stop.
      const recovered = await c.status();
      expect(recovered.workbench.state).toBe("running");
      if (stoppedByUser) {
        expect(recovered.tunnel).toMatchObject({ state: "stopped", reason: null });
        await Bun.sleep(300);
        expect((await c.status()).tunnel.state).toBe("stopped");
        expect(await runs(counter)).toBe(1);
        // Retrying the workbench is not a Tunnel start either; only an explicit start is.
        expect((await c.action({ action: "retry_workbench" })).status).toBe(200);
        expect((await c.status()).tunnel.state).toBe("stopped");
        expect((await c.action({ action: "start_tunnel" })).status).toBe(200);
      }
      expect((await c.status()).tunnel.state).toBe("running");
      await until(
        () => runs(counter),
        (count) => count === 2,
      );
    } finally {
      if (!externalClosed) {
        await external.close();
        registry.close();
      }
      await c.app.close();
      await f.dispose();
    }
  }, 20_000);
}

test("a missing tunnel-client executable is not_installed and not retried", async () => {
  const f = await fixture();
  const c = await companion(f, {
    tunnelCommand: [path.join(f.directory, "missing-tunnel-client")],
    tunnelRestartDelaysMs: [50],
  });
  try {
    expect((await c.action({ action: "start_tunnel" })).status).toBe(200);
    await Bun.sleep(200);
    const status = await c.status();
    expect(status.tunnel).toMatchObject({
      state: "error",
      reason: "not_installed",
      nextRetryAt: null,
      restartCount: 0,
    });
    const diagnostics = await c.action({ action: "diagnostics" });
    expect(diagnostics.body.checks.find((check: Json) => check.id === "tunnel")).toEqual({
      id: "tunnel",
      state: "error",
      code: "tunnel_failed",
      reason: "not_installed",
      fix: "show_tunnel_help",
    });
  } finally {
    await c.app.close();
    await f.dispose();
  }
}, 20_000);

test("unexpected Tunnel exits restart with bounded backoff, then stop retrying", async () => {
  const f = await fixture();
  const counter = path.join(f.directory, "tunnel-runs.txt");
  const c = await companion(f, {
    tunnelCommand: [
      process.execPath,
      "-e",
      counterScript(
        counter,
        'console.error("dial tcp 10.0.0.1:443: connect: connection refused"); process.exit(1);',
      ),
    ],
    // Long enough that a loaded test machine still observes each scheduled retry.
    tunnelRestartDelaysMs: [300, 300, 300],
  });
  try {
    expect((await c.action({ action: "start_tunnel" })).status).toBe(200);
    const retrying = await until(c.status, (status) => status.tunnel.nextRetryAt !== null);
    expect(retrying.tunnel).toMatchObject({ state: "error", reason: "network" });
    expect(retrying.tunnel.message).toContain("自動重新啟動");
    const exhausted = await until(
      c.status,
      (status) =>
        status.tunnel.restartCount === 3 &&
        status.tunnel.state === "error" &&
        status.tunnel.nextRetryAt === null,
      15_000,
    );
    expect(exhausted.tunnel.reason).toBe("network");
    await Bun.sleep(400);
    expect(await runs(counter)).toBe(4);
    expect((await c.status()).tunnel.restartCount).toBe(3);

    // An explicit start is a fresh budget.
    expect((await c.action({ action: "start_tunnel" })).status).toBe(200);
    await until(c.status, (status) => status.tunnel.nextRetryAt !== null);
    expect((await c.status()).tunnel.restartCount).toBeLessThanOrEqual(1);
  } finally {
    await c.app.close();
    await f.dispose();
  }
}, 30_000);

test("an explicit stop or quit cancels a scheduled Tunnel restart", async () => {
  const f = await fixture();
  const counter = path.join(f.directory, "tunnel-runs.txt");
  const c = await companion(f, {
    tunnelCommand: [process.execPath, "-e", counterScript(counter, "process.exit(3);")],
    tunnelRestartDelaysMs: [600],
  });
  try {
    expect((await c.action({ action: "start_tunnel" })).status).toBe(200);
    const scheduled = await until(c.status, (status) => status.tunnel.nextRetryAt !== null);
    expect(scheduled.tunnel.reason).toBe("unknown");
    expect((await c.action({ action: "stop_tunnel" })).status).toBe(200);
    const stopped = await c.status();
    expect(stopped.tunnel).toMatchObject({ state: "stopped", nextRetryAt: null, reason: null });
    await Bun.sleep(1_000);
    expect(await runs(counter)).toBe(1);
    expect((await c.status()).tunnel.state).toBe("stopped");

    expect((await c.action({ action: "start_tunnel" })).status).toBe(200);
    await until(c.status, (status) => status.tunnel.nextRetryAt !== null);
    expect((await c.action({ action: "quit" })).status).toBe(200);
    await c.app.closed;
    await Bun.sleep(1_000);
    expect(await runs(counter)).toBe(2);
  } finally {
    await c.app.close();
    await f.dispose();
  }
}, 20_000);
