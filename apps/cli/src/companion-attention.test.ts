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
    byKind: [
      { kind: "command", workspace_id: first, count: 1 },
      { kind: "command", workspace_id: second, count: 1 },
      { kind: "terminal", workspace_id: first, count: 1 },
      { kind: "file_change", workspace_id: first, count: 1 },
    ],
    earliestExpiresAt: new Date(now + 60_000).toISOString(),
  });
  const text = JSON.stringify(summary);
  for (const secret of ["private", "fffff", "secret", "--token", "not-a-uuid"])
    expect(text).not.toContain(secret);
});

test("an image import waiting for its image counts under 需確認 like on the side panel", () => {
  const now = 2_000_000;
  const item = (state: string, extra: object = {}) => ({
    state,
    workspace_id: first,
    expires_at: now + 600_000,
    source_file_id: null,
    ...extra,
  });
  const summary = pendingSummary(
    {
      sessions: [item("awaiting_file")],
      commands: [item("preparing")],
      changes: [],
      imports: [
        item("awaiting_file", { expires_at: now + 300_000 }),
        item("preparing"),
        item("pending"),
        item("applying"),
        item("applied"),
        item("awaiting_file", { expires_at: now - 1 }),
      ],
    },
    now,
  );
  // Only imports use the extra states; a malformed command or session state still is not 需確認.
  expect(summary).toMatchObject({
    total: 3,
    byKind: [{ kind: "import", workspace_id: first, count: 3 }],
    earliestExpiresAt: new Date(now + 300_000).toISOString(),
  });
});

test("pending summary reports the earliest deadline among live requests only", () => {
  const now = 5_000_000;
  const item = (expires_at: unknown) => ({ state: "pending", workspace_id: first, expires_at });
  const summary = pendingSummary(
    {
      sessions: [item(now + 90_000)],
      commands: [item(now - 1), item(now + 30_000), item("soon")],
      changes: [item(Number.NaN)],
      imports: [{ ...item(now + 5_000), state: "approved" }],
    },
    now,
  );
  expect(summary?.total).toBe(4);
  expect(summary?.earliestExpiresAt).toBe(new Date(now + 30_000).toISOString());
  expect(summary?.byKind).toEqual([
    { kind: "command", workspace_id: first, count: 2 },
    { kind: "terminal", workspace_id: first, count: 1 },
    { kind: "file_change", workspace_id: first, count: 1 },
  ]);
});

test("an expiry outside the Date range never breaks the summary", () => {
  const now = 5_000_000;
  const item = (expires_at: unknown) => ({ state: "pending", workspace_id: first, expires_at });
  // An external workbench is another program: 1e16 used to reach toISOString and throw.
  const lists = (expires: unknown[]) => ({
    sessions: [],
    commands: expires.map(item),
    changes: [],
    imports: [],
  });
  for (const outOfRange of [
    1e16,
    8.64e15 + 1,
    Number.MAX_VALUE,
    Number.POSITIVE_INFINITY,
    1.5e9 + 0.5,
  ]) {
    const summary = pendingSummary(lists([outOfRange]), now);
    expect(summary).toEqual({
      total: 1,
      byWorkspace: [{ workspace_id: first, count: 1 }],
      byKind: [{ kind: "command", workspace_id: first, count: 1 }],
      earliestExpiresAt: null,
    });
  }
  // A valid deadline beside a malformed one is still reported.
  expect(pendingSummary(lists([1e16, now + 30_000]), now)?.earliestExpiresAt).toBe(
    new Date(now + 30_000).toISOString(),
  );
  expect(pendingSummary(lists([8.64e15]), now)?.earliestExpiresAt).toBe(
    new Date(8.64e15).toISOString(),
  );
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
    byKind: [],
    earliestExpiresAt: null,
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
