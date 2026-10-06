import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type AccessGrant, WorkspaceListSchema } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { grantSummary } from "./preview.ts";
import { approvalMode, ToolService } from "./tools.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let service: ToolService;
beforeEach(async () => {
  f = await fixture();
  service = new ToolService(f.registry, true);
});
afterEach(async () => {
  await service.close();
  await f.dispose();
});

async function listed(name: "workspace_list" | "workbench_open" = "workspace_list") {
  const result = await service.call(name, {}, "mcp");
  expect(result.isError).not.toBe(true);
  return {
    raw: JSON.stringify(result),
    workspaces: WorkspaceListSchema.parse(result.structuredContent).workspaces,
  };
}

test("approval mode maps only level and expiry, never grant identity", () => {
  expect(approvalMode(undefined)).toEqual({ mode: "per_request", expires_at: null });
  const grant = {
    id: "grant-id-must-stay-private",
    workspace_id: crypto.randomUUID(),
    workspace_name: "w",
    level: "files" as const,
    expires_at: Date.UTC(2026, 9, 6, 12, 30),
  };
  expect(approvalMode(grant)).toEqual({ mode: "files", expires_at: "2026-10-06T12:30:00.000Z" });
  expect(approvalMode({ ...grant, level: "full", expires_at: null })).toEqual({
    mode: "full",
    expires_at: null,
  });
  expect(JSON.stringify(approvalMode(grant))).not.toContain(grant.id);
});

test("Companion grant summary carries level and ISO expiry, never grant identity", async () => {
  const owner = "panel-owner-secret";
  await service.enableAccess(f.workspace.id, "files", 15, owner, () => true);
  const [grant] = service.terminals.access();
  const summary = grantSummary(service.terminals.access());
  expect(summary).toEqual([
    {
      workspace_id: f.workspace.id,
      level: "files",
      expires_at: new Date(grant?.expires_at ?? 0).toISOString(),
    },
  ]);
  expect(grantSummary([{ ...(grant as AccessGrant), level: "full", expires_at: null }])).toEqual([
    { workspace_id: f.workspace.id, level: "full", expires_at: null },
  ]);
  for (const secret of [grant?.id ?? "missing", owner, grant?.workspace_name ?? "missing"])
    expect(JSON.stringify(summary)).not.toContain(secret);
});

test("workspace_list and workbench_open report each workspace's live approval mode", async () => {
  const otherRoot = path.join(f.directory, "other");
  await mkdir(otherRoot);
  const other = await f.registry.add(otherRoot, "其他專案");
  const owner = "panel-owner-secret";
  for (const name of ["workspace_list", "workbench_open"] as const) {
    const initial = await listed(name);
    expect(initial.workspaces.map((workspace) => workspace.approval)).toEqual([
      { mode: "per_request", expires_at: null },
      { mode: "per_request", expires_at: null },
    ]);
  }

  const before = Date.now();
  await service.enableAccess(f.workspace.id, "files", 15, owner, () => true);
  const files = await listed();
  const granted = files.workspaces.find((workspace) => workspace.id === f.workspace.id);
  expect(granted?.approval?.mode).toBe("files");
  const expiresAt = Date.parse(granted?.approval?.expires_at ?? "");
  expect(expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
  expect(files.workspaces.find((workspace) => workspace.id === other.id)?.approval).toEqual({
    mode: "per_request",
    expires_at: null,
  });

  await service.enableAccess(f.workspace.id, "full", null, owner, () => true);
  const full = await listed("workbench_open");
  expect(full.workspaces.find((workspace) => workspace.id === f.workspace.id)?.approval).toEqual({
    mode: "full",
    expires_at: null,
  });
  // Grant ids, owners, pairing tokens and absolute roots never reach the model.
  const grantId = service.terminals.access()[0]?.id ?? "missing";
  for (const secret of [grantId, owner, f.root, otherRoot]) expect(full.raw).not.toContain(secret);

  await service.revokeAccessOwner(owner);
  expect((await listed()).workspaces.every((w) => w.approval?.mode === "per_request")).toBe(true);
});

test("revoked, unpaired and unmounted grants fall back to per_request", async () => {
  let paired = true;
  await service.enableAccess(f.workspace.id, "full", 60, "panel", () => paired);
  expect((await listed()).workspaces[0]?.approval?.mode).toBe("full");
  paired = false;
  expect((await listed()).workspaces[0]?.approval).toEqual({
    mode: "per_request",
    expires_at: null,
  });

  paired = true;
  await service.enableAccess(f.workspace.id, "files", 60, "panel", () => paired);
  expect((await listed()).workspaces[0]?.approval?.mode).toBe("files");
  await service.disableAccess(f.workspace.id);
  expect((await listed()).workspaces[0]?.approval?.mode).toBe("per_request");

  await service.enableAccess(f.workspace.id, "full", 60, "panel", () => paired);
  f.registry.remove(f.workspace.id);
  expect((await listed()).workspaces).toEqual([]);
});
