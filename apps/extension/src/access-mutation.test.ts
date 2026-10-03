import { expect, test } from "bun:test";
import {
  type PanelConnection,
  panelAccessFingerprint,
  type TrackedPanelAccessMutation,
} from "@kairomes/protocol";
import {
  AccessMutationTracker,
  AccessPendingConflict,
  accessPendingStorageKey,
  writeAccessPending,
} from "./access-mutation.ts";

const workspace = "00000000-0000-4000-8000-000000000001";
const source: PanelConnection = {
  instanceId: "00000000-0000-4000-8000-000000000002",
  origin: "http://127.0.0.1:4000",
  panelToken: "synthetic-panel-owner",
  workbenchUrl: "http://127.0.0.1:4000/",
};
function request(): TrackedPanelAccessMutation {
  return {
    action: "enable",
    workspace_id: workspace,
    level: "full",
    minutes: 60,
    request_id: crypto.randomUUID(),
    valid_until: Date.now() + 30_000,
  };
}
async function unknown() {
  const tracker = new AccessMutationTracker();
  tracker.bind(source);
  const body = request();
  const fingerprint = await panelAccessFingerprint(body);
  tracker.begin(source, body, fingerprint);
  tracker.markUnknown(source, body.request_id);
  return { tracker, body, fingerprint };
}

test("pending, missing, expired, superseded and unrelated receipts cannot settle an unknown access intent", async () => {
  const { tracker, body, fingerprint } = await unknown();
  for (const state of ["pending", "missing", "expired", "superseded"] as const) {
    expect(
      tracker.observe(source, {
        request_id: body.request_id,
        fingerprint: state === "missing" ? null : fingerprint,
        state,
      }),
    ).toBe(false);
    expect(tracker.hasUnknown).toBe(true);
  }
  for (const receipt of [
    { request_id: crypto.randomUUID(), fingerprint, state: "completed" },
    { request_id: body.request_id, fingerprint: "0".repeat(64), state: "completed" },
    undefined,
  ])
    expect(tracker.observe(source, receipt)).toBe(false);
  expect(tracker.hasUnknown).toBe(true);
  expect(() => tracker.begin(source, request(), fingerprint)).toThrow("結果待確認。");
});

test("only a terminal receipt for the exact owner, request and complete body releases the lock", async () => {
  for (const state of ["completed", "failed"] as const) {
    const { tracker, body, fingerprint } = await unknown();
    expect(
      tracker.observe({ ...source }, { request_id: body.request_id, fingerprint, state }),
    ).toBe(false);
    expect(tracker.hasUnknown).toBe(true);
    expect(tracker.observe(source, { request_id: body.request_id, fingerprint, state })).toBe(true);
    expect(tracker.current).toBeUndefined();
  }
});

test("reload restores the exact unfinished intent even after its submission deadline", async () => {
  const { tracker, body } = await unknown();
  const saved = tracker.saved();
  const restored = new AccessMutationTracker();
  const reloadedSource = { ...source };
  restored.bind(reloadedSource);
  await restored.restore(reloadedSource, saved);
  expect(restored.hasUnknown).toBe(true);
  expect(restored.unknownRequest).toEqual(body);
  await expect(
    restored.restore(reloadedSource, { ...saved, fingerprint: "f".repeat(64) }),
  ).rejects.toThrow("結果待確認。");
});

test("recovery persists its original intent and a rejected recovery restores that original lock", async () => {
  const { tracker, body, fingerprint } = await unknown();
  const recovery: TrackedPanelAccessMutation = {
    action: "disable",
    workspace_id: workspace,
    request_id: crypto.randomUUID(),
    valid_until: Date.now() + 30_000,
    supersedes: { request_id: body.request_id, valid_until: body.valid_until, fingerprint },
  };
  const recoveryFingerprint = await panelAccessFingerprint(recovery);
  expect(tracker.begin(source, recovery, recoveryFingerprint)).toBe(true);
  const cache = tracker.saved();
  const restored = new AccessMutationTracker();
  restored.bind(source);
  await restored.restore(source, cache);
  expect(restored.current?.previous?.request).toEqual(body);
  expect(restored.hasUnknown).toBe(true);
  tracker.reject(source, recovery.request_id);
  expect(tracker.unknownRequest).toEqual(body);
  expect(tracker.hasUnknown).toBe(true);
});

test("a late receipt and restore cannot overwrite the replacement owner's unfinished request", async () => {
  const old = await unknown();
  const nextSource = { ...source, panelToken: "replacement-synthetic-owner" };
  const next = request();
  const nextFingerprint = await panelAccessFingerprint(next);
  const restoring = old.tracker.restore(source, old.tracker.saved());
  old.tracker.bind(nextSource);
  old.tracker.begin(nextSource, next, nextFingerprint);
  old.tracker.markUnknown(nextSource, next.request_id);
  await restoring;
  expect(
    old.tracker.observe(source, {
      request_id: old.body.request_id,
      fingerprint: old.fingerprint,
      state: "completed",
    }),
  ).toBe(false);
  expect(old.tracker.unknownRequest).toEqual(next);
  expect(old.tracker.hasUnknown).toBe(true);
  const oldKey = await accessPendingStorageKey(source);
  expect(await accessPendingStorageKey(nextSource)).not.toBe(oldKey);
  expect(oldKey).not.toContain(source.panelToken);
});

function storage() {
  const values: Record<string, unknown> = {};
  let sequence: Promise<void> = Promise.resolve();
  return {
    values,
    get: async (key: string) => ({ [key]: values[key] }),
    set: async (next: Record<string, unknown>) => {
      Object.assign(values, next);
    },
    remove: async (key: string) => {
      delete values[key];
    },
    lock: (_key: string, work: () => Promise<void>) => {
      const result = sequence.then(work);
      sequence = result.catch(() => {});
      return result;
    },
  };
}

test("two sidepanel documents cannot overwrite each other's unconfirmed identity before sending", async () => {
  const a = await unknown();
  const b = await unknown();
  const cache = storage();
  let sent = 0;
  const results = await Promise.allSettled(
    [a, b].map(async ({ tracker }) => {
      await writeAccessPending(cache, source, tracker.saved(), undefined, cache.lock);
      sent++;
    }),
  );
  expect(sent).toBe(1);
  expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
  const stored = (await cache.get(await accessPendingStorageKey(source)))[
    await accessPendingStorageKey(source)
  ];
  const restored = new AccessMutationTracker();
  restored.bind(source);
  await restored.restore(source, stored);
  expect(restored.hasUnknown).toBe(true);
});

test("late old cleanup cannot erase a persisted recovery, while exact terminal cleanup can", async () => {
  const { tracker, body, fingerprint } = await unknown();
  const cache = storage();
  await writeAccessPending(cache, source, tracker.saved(), undefined, cache.lock);
  const recovery: TrackedPanelAccessMutation = {
    action: "disable",
    workspace_id: workspace,
    request_id: crypto.randomUUID(),
    valid_until: Date.now() + 30_000,
    supersedes: { request_id: body.request_id, valid_until: body.valid_until, fingerprint },
  };
  const recoveryFingerprint = await panelAccessFingerprint(recovery);
  tracker.begin(source, recovery, recoveryFingerprint);
  await writeAccessPending(
    cache,
    source,
    tracker.saved(),
    { id: body.request_id, fingerprint },
    cache.lock,
  );
  await expect(
    writeAccessPending(cache, source, undefined, { id: body.request_id, fingerprint }, cache.lock),
  ).rejects.toBeInstanceOf(AccessPendingConflict);
  const key = await accessPendingStorageKey(source);
  expect(cache.values[key]).toEqual(tracker.saved());
  await writeAccessPending(
    cache,
    source,
    undefined,
    { id: recovery.request_id, fingerprint: recoveryFingerprint },
    cache.lock,
  );
  expect(cache.values[key]).toBeUndefined();
});

test("storage or lock failure prevents delivery instead of creating an untracked mutation", async () => {
  const { tracker } = await unknown();
  const cache = storage();
  let sent = false;
  await expect(
    (async () => {
      await writeAccessPending(cache, source, tracker.saved(), undefined, async () => {
        throw new Error("Lock unavailable");
      });
      sent = true;
    })(),
  ).rejects.toThrow("Lock unavailable");
  expect(sent).toBe(false);
  expect(Object.keys(cache.values)).toHaveLength(0);
});
