import { expect, test } from "bun:test";
import { type McpAuthInput, type McpAuthResult, McpAuthResultSchema } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { McpHostManager } from "./mcp-host.ts";
import { startWorkbench } from "./preview.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

/** Probe the HTTP trust boundary independently from the OAuth state machine. */
class AuthProbe extends McpHostManager {
  authCalls = 0;
  revoked = 0;
  override auth(_owner: string, input: McpAuthInput): McpAuthResult {
    this.authCalls++;
    return {
      instance_id: input.instance_id,
      server_id: input.server_id,
      config_fingerprint: input.config_fingerprint,
      operation_id: input.operation_id,
      operation:
        input.action === "forget"
          ? "forget"
          : input.action === "status"
            ? input.operation
            : "login",
      receipt_outcome: "missing",
      auth_phase: "required",
      tools_status: "unknown",
      phase_version: 0,
    };
  }
  override revokeAuthOwner(owner: string) {
    this.revoked++;
    super.revokeAuthOwner(owner);
  }
}

test("原生登入只接受精確 Extension Origin、配對憑證與當次實例", async () => {
  const f = await fixture();
  const host = new AuthProbe(f.state);
  const extensionId = "a".repeat(32);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const app = await startWorkbench(
    f.registry,
    "<html><!--KAIROMES_MODE--></html>",
    0,
    extensionId,
    { mcpHost: host },
  );
  try {
    const connection = await readWorkbenchConnection(f.state);
    const post = (
      route: string,
      token: string,
      body: unknown,
      origin = extensionOrigin,
      contentType = "application/json",
    ) =>
      fetch(`${connection.origin}${route}`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": contentType, Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const issued = await (
      await post("/api/pairing/create", connection.adminToken, { extensionId }, connection.origin)
    ).json();
    const fragment = new URLSearchParams(new URL(issued.pairingUrl).hash.slice(1));
    const paired = await (
      await post("/api/panel/pair", "", {
        code: fragment.get("code"),
        instanceId: connection.instanceId,
      })
    ).json();
    const input = {
      action: "status",
      instance_id: connection.instanceId,
      server_id: crypto.randomUUID(),
      config_fingerprint: "a".repeat(64),
      operation: "login",
      operation_id: crypto.randomUUID(),
    };
    const route = "/api/panel/mcp-auth";
    for (const token of [connection.uiToken, connection.mcpToken, connection.adminToken, "invalid"])
      expect((await post(route, token, input)).status).toBe(401);
    for (const origin of [
      connection.origin,
      "https://chatgpt.com",
      `chrome-extension://${"b".repeat(32)}`,
    ])
      expect((await post(route, paired.panelToken, input, origin)).status).toBe(403);
    expect((await fetch(`${connection.origin}${route}`)).status).toBe(403);
    expect(
      (await post(route, paired.panelToken, input, extensionOrigin, "text/plain")).status,
    ).toBe(415);
    expect((await post(route, paired.panelToken, { ...input, token: "synthetic" })).status).toBe(
      400,
    );
    expect(
      (await post(route, paired.panelToken, { ...input, instance_id: crypto.randomUUID() })).ok,
    ).toBe(false);
    expect(host.authCalls).toBe(0);
    const accepted = await post(route, paired.panelToken, input);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("access-control-allow-origin")).toBe(extensionOrigin);
    expect(McpAuthResultSchema.parse(await accepted.json())).toMatchObject({
      instance_id: input.instance_id,
      server_id: input.server_id,
      operation_id: input.operation_id,
      receipt_outcome: "missing",
    });
    expect(host.authCalls).toBe(1);
    expect((await post("/api/panel/disconnect", paired.panelToken, {})).status).toBe(200);
    expect(host.revoked).toBe(1);
    expect((await post(route, paired.panelToken, input)).status).toBe(401);
    expect(host.authCalls).toBe(1);
  } finally {
    await app.close();
    await f.dispose();
  }
});
