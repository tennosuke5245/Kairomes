import { expect, test } from "bun:test";
import type { ActivityEntry, ActivitySnapshot } from "@kairomes/protocol";
import { retainWorkspaceNames } from "./workspace-name-history.ts";

const a = "10000000-0000-4000-8000-000000000001";
const b = "10000000-0000-4000-8000-000000000002";
const entry: ActivityEntry = {
  id: "historical-file",
  seq: 1,
  focusSeq: 1,
  source: "mcp",
  kind: "tool",
  tool: "file_read",
  title: "讀取檔案",
  state: "completed",
  updatedAt: 0,
  workspaceId: a,
  resultId: "retained-result",
};
const snapshot: ActivitySnapshot = {
  instanceId: "same-instance",
  seq: 1,
  sessions: [],
  workspaces: [
    { id: a, name: "來源專案 A", capabilities: ["read"] },
    { id: b, name: "另一專案 B", capabilities: ["read"] },
  ],
  entries: [entry],
};

test("unmounting retains a referenced source name without recreating a mounted workspace", () => {
  const initial = retainWorkspaceNames(undefined, snapshot, []);
  expect([...initial.names]).toEqual([[a, "來源專案 A"]]);
  const unmounted = {
    ...snapshot,
    workspaces: snapshot.workspaces?.filter((item) => item.id !== a),
  };
  const history = retainWorkspaceNames(initial, unmounted, []);
  expect(history.names.get(a)).toBe("來源專案 A");
  expect(unmounted.workspaces?.some((item) => item.id === a)).toBe(false);
  expect(history.names.has(b)).toBe(false);
  expect(retainWorkspaceNames(history, { ...unmounted, seq: 2 }, [])).toBe(history);
});

test("fixed results retain labels after activity eviction, then labels disappear when unreferenced", () => {
  const initial = retainWorkspaceNames(undefined, snapshot, []);
  const evicted = { ...snapshot, entries: [], workspaces: [] };
  const fixed = retainWorkspaceNames(initial, evicted, [a]);
  expect(fixed.names.get(a)).toBe("來源專案 A");
  expect(retainWorkspaceNames(fixed, evicted, []).names.size).toBe(0);
});

test("restart clears historical names; mounted renames update labels and unknown IDs stay unknown", () => {
  const initial = retainWorkspaceNames(undefined, snapshot, []);
  const restarted = retainWorkspaceNames(
    initial,
    { ...snapshot, instanceId: "new-instance", workspaces: [] },
    [a],
  );
  expect(restarted.names.size).toBe(0);
  const renamed = retainWorkspaceNames(
    initial,
    {
      ...snapshot,
      workspaces: [{ id: a, name: "重新命名 A", capabilities: ["read"] }],
      entries: [...snapshot.entries, { ...entry, id: "unknown", workspaceId: b }],
    },
    [],
  );
  expect(renamed.names.get(a)).toBe("重新命名 A");
  expect(renamed.names.has(b)).toBe(false);
});
