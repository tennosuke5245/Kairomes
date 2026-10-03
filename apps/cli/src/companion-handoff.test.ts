import { expect, test } from "bun:test";
import { loadWidget, readWorkbenchConnection, startWorkbench } from "@kairomes/daemon";
import { WorkspaceRegistry } from "@kairomes/workspace-core";
import { fixture } from "../../../tests/fixtures.ts";
import { readCompanionConnection, startCompanionApplication } from "./companion.ts";

test("H1 strict cancellation still clears drafts after the external workbench disappears without restarting it", async () => {
  const f = await fixture();
  const registry = await WorkspaceRegistry.open(f.state);
  const widget = await loadWidget();
  if (!widget) throw new Error("Synthetic workbench fixture is unavailable");
  const external = await startWorkbench(registry, widget, 0);
  let externalClosed = false;
  const app = await startCompanionApplication({
    dataDirectory: f.state,
    openBrowser: false,
    autoStartTunnel: false,
  });
  try {
    const companion = await readCompanionConnection(f.state);
    const request = (input: unknown) =>
      fetch(`${companion.origin}/api/handoff`, {
        method: "POST",
        headers: {
          Origin: companion.origin,
          Authorization: `Bearer ${companion.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
    const started = await (
      await request({ action: "start", workspace_id: f.workspace.id, provider: "manual" })
    ).json();
    expect(started.draft_id).toMatch(/^[a-f0-9-]{36}$/);
    await external.close();
    externalClosed = true;
    registry.close();
    await expect(readWorkbenchConnection(f.state)).rejects.toMatchObject({
      code: "WORKBENCH_UNAVAILABLE",
    });
    const invalid = await request({
      action: "cancel",
      draft_id: started.draft_id,
      method: "thread/resume",
    });
    expect(invalid.status).toBe(400);
    const cancelled = await request({ action: "cancel", draft_id: started.draft_id });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ cancelled: true });
    expect(await (await request({ action: "cancel", draft_id: started.draft_id })).json()).toEqual({
      cancelled: true,
    });
    await expect(readWorkbenchConnection(f.state)).rejects.toMatchObject({
      code: "WORKBENCH_UNAVAILABLE",
    });
    const absent = await request({ action: "cancel", draft_id: crypto.randomUUID() });
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({ cancelled: true });
    await expect(readWorkbenchConnection(f.state)).rejects.toMatchObject({
      code: "WORKBENCH_UNAVAILABLE",
    });
  } finally {
    if (!externalClosed) {
      await external.close();
      registry.close();
    }
    await app.close();
    await f.dispose();
  }
}, 20000);

test("Desktop H1 is strict Companion-only local control; model, iframe and panel credentials cannot enter", async () => {
  const f = await fixture();
  const app = await startCompanionApplication({
    dataDirectory: f.state,
    openBrowser: false,
    autoStartTunnel: false,
  });
  try {
    const companion = await readCompanionConnection(f.state);
    const request = (
      body: unknown,
      token = companion.token,
      origin = companion.origin,
      route = "/api/handoff",
    ) =>
      fetch(`${companion.origin}${route}`, {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const configured = await (
      await request(
        { action: "configure_extension", extensionId },
        companion.token,
        companion.origin,
        "/api/action",
      )
    ).json();
    const workbench = await readWorkbenchConnection(f.state);
    const parameters = new URLSearchParams(new URL(configured.pairingUrl).hash.slice(1));
    const panelRequest = (route: string, body: unknown, token = "") =>
      fetch(`${workbench.origin}${route}`, {
        method: "POST",
        headers: {
          Origin: `chrome-extension://${extensionId}`,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const paired = await (
      await panelRequest("/api/panel/pair", {
        code: parameters.get("code"),
        instanceId: workbench.instanceId,
      })
    ).json();
    const grantBefore = await (
      await panelRequest(
        "/api/panel/access",
        { action: "enable", workspace_id: f.workspace.id, level: "files", minutes: 15 },
        paired.panelToken,
      )
    ).json();
    expect(grantBefore.accessGrants).toHaveLength(1);
    const start = { action: "start", workspace_id: f.workspace.id, provider: "manual" };
    for (const token of [
      "",
      "bad",
      workbench.uiToken,
      workbench.mcpToken,
      workbench.adminToken,
      paired.panelToken,
    ])
      expect((await request(start, token)).status).toBe(401);
    expect((await request(start, companion.token, "https://evil.example")).status).toBe(403);
    expect(
      (await request(start, companion.token, "chrome-extension://abcdefghijklmnopabcdefghijklmnop"))
        .status,
    ).toBe(403);
    expect((await request({ ...start, method: "thread/resume" })).status).toBe(400);
    expect((await request({ ...start, source_home: "private" })).status).toBe(400);
    expect((await request({ action: "thread/read", session_id: "invented" })).status).toBe(400);
    const initial = await (await request(start)).json();
    expect(initial.draft_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(initial)).not.toContain(companion.token);
    expect(JSON.stringify(initial)).not.toContain(f.root);
    const baseline = await (
      await request({ action: "baseline", draft_id: initial.draft_id, paths: ["README.md"] })
    ).json();
    expect(baseline.complete).toBe(true);
    expect(JSON.stringify(baseline)).not.toContain("# Fixture");
    const preview = await (
      await request({
        action: "preview",
        draft_id: initial.draft_id,
        fields: { goal: "合成目標", next_action: "先核對版本" },
        source_stopped: true,
        permissions_checked: true,
      })
    ).json();
    expect(preview.complete).toBe(true);
    const ready = await (
      await request({
        action: "prepare",
        draft_id: initial.draft_id,
        content_digest: preview.digest,
        source_stopped: true,
        permissions_checked: true,
      })
    ).json();
    expect(ready.state).toBe("ready-to-copy");
    expect(ready.text).toBe(preview.text);
    expect(JSON.stringify(ready)).not.toContain(f.root);
    expect(ready.received).toBeUndefined();
    expect(ready.grant).toBeUndefined();
    const grantAfter = await (
      await panelRequest("/api/panel/approvals", { action: "list" }, paired.panelToken)
    ).json();
    expect(grantAfter.accessGrants).toEqual(grantBefore.accessGrants);
    expect(
      (
        await request(
          { action: "retry_workbench" },
          companion.token,
          companion.origin,
          "/api/action",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request({
          action: "prepare",
          draft_id: initial.draft_id,
          content_digest: preview.digest,
          source_stopped: true,
          permissions_checked: true,
        })
      ).status,
    ).toBe(400);
    const sensitive = await request({
      action: "preview",
      draft_id: initial.draft_id,
      fields: { goal: `sk-proj-${"a".repeat(30)}`, next_action: "核對" },
      source_stopped: true,
      permissions_checked: true,
    });
    expect(sensitive.status).toBe(400);
    expect(await sensitive.text()).not.toContain("sk-proj-");
    expect((await request({ action: "cancel", draft_id: initial.draft_id })).status).toBe(200);
    expect(
      (await request({ action: "baseline", draft_id: initial.draft_id, paths: [] })).status,
    ).toBe(400);
    expect(
      (
        await request(
          { payload: "x".repeat(4096) },
          companion.token,
          companion.origin,
          "/api/status",
        )
      ).status,
    ).toBe(400);
  } finally {
    await app.close();
    await f.dispose();
  }
}, 20000);
