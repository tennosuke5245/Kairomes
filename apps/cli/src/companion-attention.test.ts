import { expect, test } from "bun:test";
import { connectionSummary, healthVersion, pendingSummary } from "./companion-attention.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

test("pending summary keeps counts per workspace and nothing else", () => {
  const now = 1_000_000;
  const pending = (workspace_id: string, extra: object = {}) => ({
    id: crypto.randomUUID(),
    state: "pending",
    workspace_id,
    workspace_name: "private-name",
    fingerprint: "f".repeat(64),
    absolute_cwd: "/home/me/private-project",
    command: ["secret-tool", "--token", "abc"],
    diff: "+secret line",
    expires_at: now + 60_000,
    ...extra,
  });
  const summary = pendingSummary(
    {
      sessions: [pending(first), pending(first, { state: "running" })],
      commands: [pending(second), pending(first), pending(first, { expires_at: now - 1 })],
      changes: [pending(first), pending("not-a-uuid"), null, "x"],
      imports: [pending(second, { state: "denied" })],
    },
    now,
  );
  expect(summary).toEqual({
    total: 4,
    byWorkspace: [
      { workspace_id: first, count: 3 },
      { workspace_id: second, count: 1 },
    ],
  });
  const text = JSON.stringify(summary);
  for (const secret of ["private", "fffff", "secret", "--token", "not-a-uuid"])
    expect(text).not.toContain(secret);
});

test("pending summary is null for a malformed or oversized list", () => {
  expect(pendingSummary(null)).toBeNull();
  expect(pendingSummary("list")).toBeNull();
  expect(pendingSummary({ sessions: [], commands: [], changes: {} })).toBeNull();
  expect(pendingSummary({ commands: [], changes: [] })).toBeNull();
  expect(
    pendingSummary({ sessions: Array(4097).fill({}), commands: [], changes: [], imports: [] }),
  ).toBeNull();
  // An older workbench without media imports still reports the other lists.
  expect(pendingSummary({ sessions: [], commands: [], changes: [] })).toEqual({
    total: 0,
    byWorkspace: [],
  });
});

test("connection summary keeps only a valid timestamp and a bounded panel count", () => {
  expect(
    connectionSummary({
      mode: "workbench",
      instanceId: crypto.randomUUID(),
      lastMcpRequestAt: "2026-10-06T12:00:00.000Z",
      pairedPanels: 2,
      extra: "ignored",
    }),
  ).toEqual({ lastMcpRequestAt: "2026-10-06T12:00:00.000Z", pairedPanels: 2 });
  expect(connectionSummary({ lastMcpRequestAt: "soon", pairedPanels: -1 })).toEqual({
    lastMcpRequestAt: null,
    pairedPanels: null,
  });
  expect(connectionSummary({ lastMcpRequestAt: null, pairedPanels: 1.5 })).toEqual({
    lastMcpRequestAt: null,
    pairedPanels: null,
  });
  expect(connectionSummary(null)).toEqual({ lastMcpRequestAt: null, pairedPanels: null });
  expect(healthVersion({ status: "ok", version: "0.2.0" })).toBe("0.2.0");
  expect(healthVersion({ status: "ok" })).toBeNull();
  expect(healthVersion({ version: "0.2.0; rm -rf" })).toBeNull();
});
