import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadWidget, startWorkbench } from "@kairomes/daemon";
import { WorkspaceRegistry } from "@kairomes/workspace-core";
import { fixture } from "../../../tests/fixtures.ts";
import { readCompanionConnection, startCompanionApplication } from "./companion.ts";

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

    expect((await (await request({})).json()).workbench.state).toBe("external");
    await external.close();
    externalClosed = true;
    registry.close();

    const recovered = await (await request({})).json();
    expect(recovered.workbench.state).toBe("running");
    expect(recovered.workbench.message).toContain("Companion 管理");
  } finally {
    if (!externalClosed) {
      await external.close();
      registry.close();
    }
    await app.close();
    await f.dispose();
  }
}, 20_000);

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
