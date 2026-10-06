import { expect, test } from "bun:test";
import { copyHandoffContent } from "./handoff-copy.ts";
import { HandoffRequestGuard, handoffInvalidReason } from "./handoff-session.ts";
import { type DesktopSnapshot, normalizeDesktopSnapshot } from "./model.ts";

function localSnapshot(): DesktopSnapshot {
  return normalizeDesktopSnapshot({
    credentialConfigured: false,
    tunnelClientInstalled: false,
    runtime: { state: "running", owned: true, message: "合成本機服務" },
    companion: {
      version: "0.1.4",
      overall: { tone: "warn", label: "合成狀態" },
      workspaces: [{ id: "workspace-a", name: "合成專案", capabilities: ["read"] }],
      workbench: { state: "running", label: "執行中", message: "", meta: "" },
      tunnel: { state: "stopped", label: "停止", message: "", meta: "", logs: [] },
      connector: { state: "waiting", label: "等待", message: "", meta: "" },
      extension: { configured: false },
    },
  });
}

test("known unmount and unavailable local status immediately disqualify a draft; Tunnel is not an H1 gate", () => {
  const current = localSnapshot();
  expect(handoffInvalidReason(current, "workspace-a", true)).toBeNull();
  expect(handoffInvalidReason(current, "workspace-a", false)).toContain("無法核對");
  expect(handoffInvalidReason(current, "different-workspace", true)).toContain("解除掛載");
  expect(handoffInvalidReason({ ...current, companion: null }, "workspace-a", true)).toContain(
    "無法核對",
  );
  for (const state of ["starting", "stopped", "error"] as const)
    expect(
      handoffInvalidReason(
        { ...current, runtime: { ...current.runtime, state } },
        "workspace-a",
        true,
      ),
    ).toContain("無法核對");
  if (!current.companion) throw new Error("Missing synthetic companion");
  for (const state of ["starting", "stopped", "error"] as const)
    expect(
      handoffInvalidReason(
        {
          ...current,
          companion: {
            ...current.companion,
            workbench: { ...current.companion.workbench, state },
          },
        },
        "workspace-a",
        true,
      ),
    ).toContain("無法核對");
  current.companion.workbench.state = "external";
  expect(handoffInvalidReason(current, "workspace-a", true)).toBeNull();
});

test("changing workspace or selecting another source prevents late preparation from copying", async () => {
  for (const change of ["source", "workspace", "close"]) {
    const guard = new HandoffRequestGuard();
    guard.activate("workspace-a");
    const active = guard.begin();
    const preview = { text: "合成舊來源", digest: "a".repeat(64) };
    let release = (_result: typeof preview) => {};
    const prepared = new Promise<typeof preview>((resolve) => {
      release = resolve;
    });
    const writes: string[] = [];
    const mutations: string[] = [];
    const copying = copyHandoffContent(preview, {
      prepare: () => prepared,
      writeText: async (text) => {
        writes.push(text);
      },
      invalidate: () => mutations.push("invalidate"),
      fallback: () => mutations.push("fallback"),
      active,
    });
    if (change === "source") guard.begin();
    else {
      guard.close();
      if (change === "workspace") guard.activate("workspace-b");
    }
    release(preview);
    expect(await copying).toBe(false);
    expect(writes).toEqual([]);
    expect(mutations).toEqual([]);
    expect(active()).toBe(false);
  }
});

test("a late source failure cannot invalidate a newer workspace review", async () => {
  const guard = new HandoffRequestGuard();
  guard.activate("workspace-a");
  const active = guard.begin();
  let reject = (_error: Error) => {};
  const prepared = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  let invalidated = false;
  const copying = copyHandoffContent(
    { text: "合成摘要", digest: "a".repeat(64) },
    {
      prepare: () => prepared,
      writeText: async () => {},
      invalidate: () => {
        invalidated = true;
      },
      fallback: () => {},
      active,
    },
  );
  guard.close();
  guard.activate("workspace-b");
  const current = guard.begin();
  reject(new Error("舊來源已斷線"));
  await expect(copying).rejects.toThrow("舊來源已斷線");
  expect(invalidated).toBe(false);
  expect(current()).toBe(true);
});
