import { expect, spyOn, test } from "bun:test";
import { request as httpRequest } from "node:http";
import {
  type PanelAccessResponse,
  panelAccessFingerprint,
  type TrackedPanelAccessMutation,
} from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { startWorkbench } from "./preview.ts";
import { ToolService } from "./tools.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

const extensionId = "a".repeat(32);
const extensionOrigin = `chrome-extension://${extensionId}`;
const html = "<html><head><!--KAIROMES_MODE--></head><body>合成工作台</body></html>";

async function setup() {
  const f = await fixture();
  const app = await startWorkbench(f.registry, html, 0, extensionId);
  const connection = await readWorkbenchConnection(f.state);
  const post = (route: string, token: string, body: unknown, origin = extensionOrigin) =>
    fetch(`${connection.origin}${route}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  const pair = async () => {
    const created = await (
      await post("/api/pairing/create", connection.adminToken, { extensionId }, connection.origin)
    ).json();
    const code = new URLSearchParams(new URL(created.pairingUrl).hash.slice(1)).get("code");
    return (
      await post("/api/panel/pair", "", { code, instanceId: connection.instanceId })
    ).json() as Promise<{ panelToken: string }>;
  };
  const panel = await pair();
  const input = (): TrackedPanelAccessMutation => ({
    action: "enable",
    workspace_id: f.workspace.id,
    level: "files",
    minutes: null,
    request_id: crypto.randomUUID(),
    valid_until: Date.now() + 30_000,
  });
  return {
    f,
    app,
    connection,
    panel,
    pair,
    post,
    input,
    close: async () => {
      await app.close();
      await f.dispose();
    },
  };
}

function heldBody(origin: string, token: string, body: unknown) {
  const encoded = JSON.stringify(body);
  let release!: () => void;
  let destroy!: () => void;
  const response = new Promise<{
    status: number;
    body: PanelAccessResponse & { message?: string };
  }>((resolve, reject) => {
    const request = httpRequest(
      `${origin}/api/panel/access`,
      {
        method: "POST",
        headers: {
          Origin: extensionOrigin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(encoded),
        },
      },
      (incoming) => {
        let content = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          content += chunk;
        });
        incoming.on("end", () => {
          try {
            resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(content) });
          } catch (cause) {
            reject(cause);
          }
        });
        incoming.on("error", reject);
      },
    );
    request.on("error", reject);
    request.write(encoded.slice(0, 1));
    release = () => request.end(encoded.slice(1));
    destroy = () => request.destroy();
  });
  return { response, release, destroy };
}

test("panel receipts preserve legacy snapshots, isolate owners and reject same-ID body changes without replay", async () => {
  const s = await setup();
  try {
    const legacy = await (
      await s.post("/api/panel/access", s.panel.panelToken, {
        action: "enable",
        workspace_id: s.f.workspace.id,
        level: "files",
        minutes: null,
      })
    ).json();
    expect(legacy.access_receipt).toBeUndefined();
    expect(legacy.accessGrants).toHaveLength(1);
    const body = s.input();
    const first: PanelAccessResponse = await (
      await s.post("/api/panel/access", s.panel.panelToken, body)
    ).json();
    expect(first.access_receipt).toMatchObject({
      state: "completed",
      request_id: body.request_id,
      fingerprint: await panelAccessFingerprint(body),
    });
    const replay: PanelAccessResponse = await (
      await s.post("/api/panel/access", s.panel.panelToken, body)
    ).json();
    expect(replay.accessGrants?.[0]?.id).toBe(first.accessGrants?.[0]?.id);
    expect(
      (
        await s.post("/api/panel/access", s.panel.panelToken, {
          ...body,
          valid_until: body.valid_until + 1,
        })
      ).status,
    ).toBe(409);
    const other = await s.pair();
    const missing: PanelAccessResponse = await (
      await s.post("/api/panel/access", other.panelToken, {
        action: "status",
        request_id: body.request_id,
      })
    ).json();
    expect(missing.access_receipt).toEqual({
      request_id: body.request_id,
      state: "missing",
      fingerprint: null,
    });
    for (const token of [s.connection.uiToken, s.connection.mcpToken, s.connection.adminToken])
      expect(
        (
          await s.post("/api/panel/access", token, {
            action: "status",
            request_id: body.request_id,
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await s.post(
          "/api/panel/access",
          s.panel.panelToken,
          { action: "status", request_id: body.request_id },
          s.connection.origin,
        )
      ).status,
    ).toBe(403);
  } finally {
    await s.close();
  }
});

test("a recovery revoke fences an enable whose HTTP body has not arrived yet", async () => {
  const s = await setup();
  const body = s.input();
  const pending = heldBody(s.connection.origin, s.panel.panelToken, body);
  try {
    const recovery: TrackedPanelAccessMutation = {
      action: "disable",
      workspace_id: body.workspace_id,
      request_id: crypto.randomUUID(),
      valid_until: Date.now() + 30_000,
      supersedes: {
        request_id: body.request_id,
        valid_until: body.valid_until,
        fingerprint: await panelAccessFingerprint(body),
      },
    };
    const revoked: PanelAccessResponse = await (
      await s.post("/api/panel/access", s.panel.panelToken, recovery)
    ).json();
    expect(revoked.access_receipt?.state).toBe("completed");
    expect(revoked.accessGrants).toEqual([]);
    pending.release();
    const late = await pending.response;
    expect(late.status).toBe(200);
    expect(late.body.access_receipt?.state).toBe("superseded");
    expect(late.body.accessGrants).toEqual([]);
    const status: PanelAccessResponse = await (
      await s.post("/api/panel/access", s.panel.panelToken, {
        action: "status",
        request_id: recovery.request_id,
      })
    ).json();
    expect(status.access_receipt?.fingerprint).toBe(await panelAccessFingerprint(recovery));
    expect(status.accessGrants).toEqual([]);
  } finally {
    pending.destroy();
    await s.close();
  }
});

test("a pairing revoked during body parsing cannot later disable a replacement owner's grant", async () => {
  const s = await setup();
  let entered!: () => void;
  const parsing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalJson = Request.prototype.json;
  const json = spyOn(Request.prototype, "json").mockImplementation(function (this: Request) {
    if (
      new URL(this.url).pathname === "/api/panel/access" &&
      this.headers.get("authorization") === `Bearer ${s.panel.panelToken}`
    )
      entered();
    return originalJson.call(this);
  });
  const disable = { action: "disable", workspace_id: s.f.workspace.id };
  const pending = heldBody(s.connection.origin, s.panel.panelToken, disable);
  try {
    await parsing;
    expect((await s.post("/api/panel/disconnect", s.panel.panelToken, {})).status).toBe(200);
    const other = await s.pair();
    const grant: PanelAccessResponse = await (
      await s.post("/api/panel/access", other.panelToken, {
        action: "enable",
        workspace_id: s.f.workspace.id,
        level: "files",
        minutes: null,
      })
    ).json();
    const id = grant.accessGrants?.[0]?.id;
    pending.release();
    const late = await pending.response;
    expect(late.status).toBe(401);
    expect(late.body.accessGrants).toBeUndefined();
    const current: PanelAccessResponse = await (
      await s.post("/api/panel/access", other.panelToken, {
        action: "status",
        request_id: crypto.randomUUID(),
      })
    ).json();
    expect(current.accessGrants?.[0]?.id).toBe(id);
  } finally {
    pending.destroy();
    json.mockRestore();
    await s.close();
  }
});

test("a pairing revoked while an accepted mutation awaits cannot receive another owner's snapshot", async () => {
  const s = await setup();
  let entered!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = ToolService.prototype.enableAccess;
  const mock = spyOn(ToolService.prototype, "enableAccess").mockImplementation(async function (
    this: ToolService,
    ...args
  ) {
    await original.apply(this, args);
    if (args[0] === s.f.workspace.id && args[3] === s.panel.panelToken) {
      entered();
      await gate;
    }
  });
  let operation: Promise<Response> | undefined;
  try {
    const body = s.input();
    operation = s.post("/api/panel/access", s.panel.panelToken, body);
    await admitted;
    const pending: PanelAccessResponse = await (
      await s.post("/api/panel/access", s.panel.panelToken, {
        action: "status",
        request_id: body.request_id,
      })
    ).json();
    expect(pending.access_receipt?.state).toBe("pending");
    expect(pending.accessGrants).toHaveLength(1);
    await s.post("/api/panel/disconnect", s.panel.panelToken, {});
    const other = await s.pair();
    await s.post("/api/panel/access", other.panelToken, {
      action: "enable",
      workspace_id: s.f.workspace.id,
      level: "files",
      minutes: null,
    });
    release();
    const late = await operation;
    expect(late.status).toBe(401);
    expect(await late.json()).not.toHaveProperty("accessGrants");
  } finally {
    release();
    await operation?.catch(() => {});
    mock.mockRestore();
    await s.close();
  }
});
