import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadWidget, readWorkbenchConnection, startWorkbench } from "@kairomes/daemon";
import {
  type ActivitySnapshot,
  type PanelSnapshot,
  readSnapshots,
  VERSION,
} from "@kairomes/protocol";
import { WorkspaceRegistry } from "@kairomes/workspace-core";
import { fixture } from "../../../tests/fixtures.ts";
import { readCompanionConnection, startCompanionApplication } from "./companion.ts";

async function until(check: () => boolean, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for mounted workspaces");
    await Bun.sleep(20);
  }
}

test("Companion is single-instance, locally controlled and can renew browser pairing", async () => {
  const f = await fixture();
  const opened: string[] = [];
  const app = await startCompanionApplication({
    dataDirectory: f.state,
    openBrowser: false,
    autoStartTunnel: false,
    opener: async (url) => {
      opened.push(url);
    },
  });
  const connection = await readCompanionConnection(f.state);
  const request = (
    route: string,
    body: object,
    token = connection.token,
    origin = connection.origin,
  ) =>
    fetch(`${connection.origin}${route}`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    expect(app.reused).toBe(false);
    const page = await fetch(connection.origin);
    const html = await page.text();
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("本機工具，現在有一個看得見的家。");
    expect(html).not.toContain(connection.token);

    expect((await request("/api/status", {}, "bad-token")).status).toBe(401);
    expect(
      (await request("/api/status", {}, connection.token, "https://evil.example")).status,
    ).toBe(403);
    const initial = await (await request("/api/status", {})).json();
    expect(initial.workbench.state).toBe("running");
    expect(initial.tunnel.state).toBe("stopped");
    expect(initial.extension.configured).toBe(false);
    expect(initial.workspaces).toEqual([f.workspace]);
    expect(JSON.stringify(initial)).not.toContain(connection.token);

    const secondRoot = path.join(f.directory, "second-project");
    await mkdir(secondRoot);
    const sourceFile = path.join(secondRoot, "keep-me.txt");
    await writeFile(sourceFile, "解除掛載不能刪除專案內容。", "utf8");
    const addedResponse = await request("/api/action", {
      action: "workspace_add",
      path: secondRoot,
      name: "第二個專案",
    });
    expect(addedResponse.status).toBe(200);
    const added = await addedResponse.json();
    expect(added.workspace.name).toBe("第二個專案");
    expect(JSON.stringify(added)).not.toContain(secondRoot);
    expect((await (await request("/api/status", {})).json()).workspaces).toHaveLength(2);
    expect(
      (
        await request("/api/action", {
          action: "workspace_remove",
          workspaceId: added.workspace.id,
        })
      ).status,
    ).toBe(200);
    expect((await (await request("/api/status", {})).json()).workspaces).toEqual([f.workspace]);
    expect(await readFile(sourceFile, "utf8")).toBe("解除掛載不能刪除專案內容。");

    const paired = await (
      await request("/api/action", {
        action: "configure_extension",
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
      })
    ).json();
    expect(paired.pairingUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pair#code=/);
    expect(
      JSON.parse(await readFile(`${f.state}/companion-settings.json`, "utf8")).extensionId,
    ).toBe("abcdefghijklmnopabcdefghijklmnop");
    expect((await (await request("/api/status", {})).json()).extension.configured).toBe(true);

    const second = await startCompanionApplication({
      dataDirectory: f.state,
      openBrowser: true,
      autoStartTunnel: false,
      opener: async (url) => {
        opened.push(url);
      },
    });
    expect(second.reused).toBe(true);
    expect(opened).toEqual([app.url]);

    expect((await request("/api/action", { action: "quit" })).status).toBe(200);
    await app.closed;
    await expect(readCompanionConnection(f.state)).rejects.toMatchObject({
      code: "COMPANION_UNAVAILABLE",
    });
  } finally {
    await app.close();
    await f.dispose();
  }
}, 20_000);

test("Companion automatically takes over when an external workbench disappears", async () => {
  const f = await fixture();
  const registry = await WorkspaceRegistry.open(f.state);
  const widget = await loadWidget();
  if (!widget) throw new Error("Test workbench widget is unavailable.");
  const external = await startWorkbench(registry, widget, 0);
  let externalClosed = false;
  const app = await startCompanionApplication({
    dataDirectory: f.state,
    openBrowser: false,
    autoStartTunnel: false,
  });
  try {
    const connection = await readCompanionConnection(f.state);
    const request = (body: object) =>
      fetch(`${connection.origin}/api/status`, {
        method: "POST",
        headers: {
          Origin: connection.origin,
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const attached = await (await request({})).json();
    expect(attached.workbench.state).toBe("external");
    expect(attached.workbenchVersion).toBe(VERSION);
    expect(attached.versionMismatch).toBe(false);
    // Pending counts come from the admin list; grants of an external process stay unknown.
    expect(attached.attention).toEqual({
      pending: { total: 0, byWorkspace: [] },
      grants: null,
      grantsKnown: false,
      lastMcpRequestAt: null,
      pairedPanels: 0,
    });
    await external.close();
    externalClosed = true;
    registry.close();

    const recovered = await (await request({})).json();
    expect(recovered.workbench.state).toBe("running");
    expect(recovered.workbench.message).toContain("Companion 管理");
    expect(recovered.attention.grantsKnown).toBe(true);
    expect(recovered.attention.grants).toEqual([]);
  } finally {
    if (!externalClosed) {
      await external.close();
      registry.close();
    }
    await app.close();
    await f.dispose();
  }
}, 20_000);

for (const mode of ["owned", "external"] as const) {
  test(`Companion ${mode} workspace changes reach open workbench and Extension streams`, async () => {
    const f = await fixture();
    const extensionId = "a".repeat(32);
    const extensionOrigin = `chrome-extension://${extensionId}`;
    const abort = new AbortController();
    const readers: Promise<unknown>[] = [];
    let external: Awaited<ReturnType<typeof startWorkbench>> | undefined;
    let app: Awaited<ReturnType<typeof startCompanionApplication>> | undefined;
    try {
      await writeFile(
        path.join(f.state, "companion-settings.json"),
        JSON.stringify({ extensionId }),
      );
      if (mode === "external") {
        const widget = await loadWidget();
        if (!widget) throw new Error("Test workbench widget is unavailable.");
        external = await startWorkbench(f.registry, widget, 0, extensionId);
      }
      app = await startCompanionApplication({
        dataDirectory: f.state,
        openBrowser: false,
        autoStartTunnel: false,
      });
      const companion = await readCompanionConnection(f.state);
      const workbench = await readWorkbenchConnection(f.state);
      const companionRequest = (body: object) =>
        fetch(`${companion.origin}/api/action`, {
          method: "POST",
          headers: {
            Origin: companion.origin,
            Authorization: `Bearer ${companion.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const workbenchRequest = (route: string, token: string, body: object, origin: string) =>
        fetch(`${workbench.origin}${route}`, {
          method: "POST",
          headers: {
            Origin: origin,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        });

      const pairing = await (await companionRequest({ action: "create_pairing" })).json();
      const parameters = new URLSearchParams(new URL(pairing.pairingUrl).hash.slice(1));
      const paired = await workbenchRequest(
        "/api/panel/pair",
        "",
        { code: parameters.get("code"), instanceId: workbench.instanceId },
        extensionOrigin,
      );
      expect(paired.status).toBe(200);
      const panel = await paired.json();
      const activitySnapshots: ActivitySnapshot[] = [];
      const panelSnapshots: PanelSnapshot[] = [];
      readers.push(
        readSnapshots<ActivitySnapshot>(
          await workbenchRequest("/api/activity/stream", workbench.uiToken, {}, workbench.origin),
          (snapshot) => activitySnapshots.push(snapshot),
          abort.signal,
        ).catch(() => {}),
      );
      readers.push(
        readSnapshots<PanelSnapshot>(
          await workbenchRequest("/api/panel/stream", panel.panelToken, {}, extensionOrigin),
          (snapshot) => panelSnapshots.push(snapshot),
          abort.signal,
        ).catch(() => {}),
      );
      await until(() => activitySnapshots.length > 0 && panelSnapshots.length > 0);
      expect(activitySnapshots.at(-1)?.workspaces?.map((workspace) => workspace.id)).toEqual([
        f.workspace.id,
      ]);
      expect(panelSnapshots.at(-1)?.workspaces?.map((workspace) => workspace.id)).toEqual([
        f.workspace.id,
      ]);

      const secondRoot = path.join(f.directory, "second-project");
      await mkdir(secondRoot);
      const addedResponse = await companionRequest({
        action: "workspace_add",
        path: secondRoot,
        name: "第二個專案",
      });
      expect(addedResponse.status).toBe(200);
      const added = await addedResponse.json();
      await until(
        () =>
          activitySnapshots
            .at(-1)
            ?.workspaces?.some((workspace) => workspace.id === added.workspace.id) === true &&
          panelSnapshots
            .at(-1)
            ?.workspaces?.some((workspace) => workspace.id === added.workspace.id) === true,
      );
      expect(JSON.stringify(activitySnapshots.at(-1))).not.toContain(secondRoot);
      expect(JSON.stringify(panelSnapshots.at(-1))).not.toContain(secondRoot);

      const activityCount = activitySnapshots.length;
      const panelCount = panelSnapshots.length;
      const removedResponse = await companionRequest({
        action: "workspace_remove",
        workspaceId: added.workspace.id,
      });
      expect(removedResponse.status).toBe(200);
      await until(
        () =>
          activitySnapshots.length > activityCount &&
          panelSnapshots.length > panelCount &&
          activitySnapshots
            .at(-1)
            ?.workspaces?.every((workspace) => workspace.id !== added.workspace.id) === true &&
          panelSnapshots
            .at(-1)
            ?.workspaces?.every((workspace) => workspace.id !== added.workspace.id) === true,
      );
      expect(activitySnapshots.at(-1)?.workspaces?.map((workspace) => workspace.id)).toEqual([
        f.workspace.id,
      ]);
      expect(panelSnapshots.at(-1)?.workspaces?.map((workspace) => workspace.id)).toEqual([
        f.workspace.id,
      ]);
    } finally {
      abort.abort();
      await Promise.allSettled(readers);
      await app?.close();
      await external?.close();
      await f.dispose();
    }
  }, 30_000);
}

test("Tunnel keeps the initiating failure visible even when shutdown exits zero", async () => {
  const f = await fixture();
  const app = await startCompanionApplication({
    dataDirectory: f.state,
    openBrowser: false,
    autoStartTunnel: false,
    tunnelCommand: [
      process.execPath,
      "-e",
      [
        'if (process.env.OPEN_WEB_UI !== "false") { console.error("OPEN_WEB_UI_OVERRIDE_MISSING"); process.exit(7); }',
        'console.error("WORKBENCH_UNAVAILABLE: synthetic attach failure");',
        'for (let index = 0; index < 36; index++) console.error(JSON.stringify({ level: "INFO", msg: "OnStop hook " + index }));',
      ].join(""),
    ],
  });
  try {
    const connection = await readCompanionConnection(f.state);
    const request = (route: string, body: object) =>
      fetch(`${connection.origin}${route}`, {
        method: "POST",
        headers: {
          Origin: connection.origin,
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    expect((await request("/api/action", { action: "start_tunnel" })).status).toBe(200);
    let status: Awaited<ReturnType<Response["json"]>> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await (await request("/api/status", {})).json();
      if (status.tunnel.state === "error") break;
      await Bun.sleep(20);
    }

    expect(status?.tunnel.state).toBe("error");
    expect(status?.tunnel.message).not.toContain("Exit 0");
    expect(status?.tunnel.logs).toContain("WORKBENCH_UNAVAILABLE: synthetic attach failure");
    expect(status?.tunnel.reason).toBe("workbench");
    expect(status?.tunnel.logs.length).toBeLessThanOrEqual(30);
  } finally {
    await app.close();
    await f.dispose();
  }
}, 20_000);

test("Companion keeps the Tunnel credential out of its workbench environment", async () => {
  const f = await fixture();
  const previous = process.env.CONTROL_PLANE_API_KEY;
  process.env.CONTROL_PLANE_API_KEY = "test-only-tunnel-credential";
  let app: Awaited<ReturnType<typeof startCompanionApplication>> | undefined;
  try {
    app = await startCompanionApplication({
      dataDirectory: f.state,
      openBrowser: false,
      autoStartTunnel: false,
      tunnelCommand: [
        process.execPath,
        "-e",
        'console.error(process.env.CONTROL_PLANE_API_KEY === "test-only-tunnel-credential" ? "TUNNEL_KEY_OK" : "TUNNEL_KEY_MISSING"); console.error(process.env.CONTROL_PLANE_API_KEY); setInterval(() => {}, 1000)',
      ],
    });
    expect(process.env.CONTROL_PLANE_API_KEY).toBeUndefined();
    const connection = await readCompanionConnection(f.state);
    const request = (route: string, body: object) =>
      fetch(`${connection.origin}${route}`, {
        method: "POST",
        headers: {
          Origin: connection.origin,
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect((await request("/api/action", { action: "start_tunnel" })).status).toBe(200);
    let status: Awaited<ReturnType<Response["json"]>> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await (await request("/api/status", {})).json();
      if (status.tunnel.logs.includes("TUNNEL_KEY_OK") && status.tunnel.logs.includes("[redacted]"))
        break;
      await Bun.sleep(20);
    }
    expect(status?.tunnel.logs).toContain("TUNNEL_KEY_OK");
    expect(status?.tunnel.logs).toContain("[redacted]");
    expect(JSON.stringify(status)).not.toContain("test-only-tunnel-credential");
  } finally {
    await app?.close();
    if (previous === undefined) delete process.env.CONTROL_PLANE_API_KEY;
    else process.env.CONTROL_PLANE_API_KEY = previous;
    await f.dispose();
  }
}, 20_000);
