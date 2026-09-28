import { afterEach, beforeEach, expect, test } from "bun:test";
import { Inputs } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { TerminalManager } from "./terminal.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let manager: TerminalManager;
let now: number;
beforeEach(async () => {
  f = await fixture();
  now = Date.now();
  manager = new TerminalManager(f.registry, () => now);
});
afterEach(async () => {
  await manager.close();
  await f.dispose();
});
const request = () =>
  manager.request(
    Inputs.terminal_start.parse({
      workspace_id: f.workspace.id,
      shell: process.platform === "win32" ? "cmd" : "bash",
    }),
    "mcp",
  );

test("full host access covers existing and new sessions, and revoke stops both before further input", async () => {
  const pending = await request();
  expect(pending.session.state).toBe("pending");
  await manager.enableAccess(f.workspace.id, "full", 60, "panel-a", () => true);
  expect(manager.list()[0]?.state).toBe("running");
  const next = await request();
  expect(next.session.state).toBe("running");
  expect(next.session.expires_at).toBe(now + 60 * 60_000);
  expect(JSON.stringify(manager.access())).not.toContain("panel-a");
  await manager.input(next.session.id, "echo ACCESS_TEST\r", crypto.randomUUID());
  await manager.disableAccess(f.workspace.id);
  expect(manager.list().every((session) => session.state === "stopped")).toBe(true);
  await expect(
    manager.input(next.session.id, "echo SHOULD_NOT_RUN\r", crypto.randomUUID()),
  ).rejects.toThrow();
  expect((await request()).session.state).toBe("pending");
});

test("access expiry and lost pairing are enforced on use, not only by the sweeper", async () => {
  let valid = true;
  await manager.enableAccess(f.workspace.id, "full", 15, "panel", () => valid);
  const first = await request();
  now += 15 * 60_000;
  expect((await manager.poll(first.session.id, 0)).session.state).toBe("expired");
  expect(manager.access()).toEqual([]);
  expect((await request()).session.state).toBe("pending");
  await manager.enableAccess(f.workspace.id, "full", 60, "panel", () => valid);
  const second = await request();
  valid = false;
  await expect(
    manager.input(second.session.id, "echo DENIED\r", crypto.randomUUID()),
  ).rejects.toThrow();
  expect((await request()).session.state).toBe("pending");
});

test("revoke wins an in-flight automatic launch and unmount invalidates access", async () => {
  await manager.enableAccess(f.workspace.id, "full", 60, "panel", () => true);
  const starting = request();
  await manager.disableAccess(f.workspace.id);
  const result = await starting;
  expect(["pending", "stopped"]).toContain(result.session.state);
  await manager.enableAccess(f.workspace.id, "full", 60, "panel", () => true);
  const active = await request();
  f.registry.remove(f.workspace.id);
  expect((await manager.poll(active.session.id, 0)).session.state).toBe("stopped");
  expect(manager.access()).toEqual([]);
});

test("pairing ownership revokes only its grants; settings reject unsupported duration", async () => {
  await expect(
    manager.enableAccess(f.workspace.id, "full", 0 as 15, "panel", () => true),
  ).rejects.toThrow();
  await expect(
    manager.enableAccess(f.workspace.id, "full", 60, "panel", () => false),
  ).rejects.toThrow();
  await manager.enableAccess(f.workspace.id, "full", 60, "panel-a", () => true);
  await manager.revokeAccessOwner("panel-b");
  expect(manager.access()).toHaveLength(1);
  await manager.revokeAccessOwner("panel-a");
  expect(manager.access()).toHaveLength(0);
});

test("persistent access remains until revoke while each inherited shell stays bounded", async () => {
  await manager.enableAccess(f.workspace.id, "full", null, "panel", () => true);
  expect(manager.access()[0]).toMatchObject({ level: "full", expires_at: null });
  const active = await request();
  expect(active.session.state).toBe("running");
  expect(active.session.expires_at).toBe(now + 4 * 60 * 60_000);
  now += 2 * 60 * 60_000;
  expect(manager.access()).toHaveLength(1);
  await manager.disableAccess(f.workspace.id);
  expect(manager.access()).toEqual([]);
  expect((await manager.poll(active.session.id, 0)).session.state).toBe("stopped");
});

test("file-only access never auto-approves host terminals", async () => {
  await manager.enableAccess(f.workspace.id, "files", null, "panel", () => true);
  expect(manager.access()[0]).toMatchObject({ level: "files", expires_at: null });
  expect((await request()).session.state).toBe("pending");
});
