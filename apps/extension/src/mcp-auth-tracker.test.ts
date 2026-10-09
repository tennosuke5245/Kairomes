import { expect, test } from "bun:test";
import type { McpAuthResult, McpAuthSummary } from "@kairomes/protocol";
import {
  McpAuthStorageConflict,
  McpAuthTracker,
  mcpAuthPresentation,
  writeMcpAuthPending,
} from "./mcp-auth-tracker.ts";

const source = "synthetic-owner-digest";
const identity = {
  instance_id: "00000000-0000-4000-8000-000000000001",
  server_id: "00000000-0000-4000-8000-000000000002",
  config_fingerprint: "1".repeat(64),
};
const intent = (
  action: "start" | "forget" = "start",
  id = "00000000-0000-4000-8000-000000000003",
) => ({
  ...identity,
  action,
  operation_id: id,
  accept_before: "2026-10-03T00:00:30.000Z",
});
const summary = (overrides: Partial<McpAuthSummary> = {}): McpAuthSummary => ({
  auth_phase: "waiting",
  tools_status: "unknown",
  phase_version: 1,
  ...overrides,
});
const result = (overrides: Partial<McpAuthResult> = {}): McpAuthResult => ({
  ...identity,
  operation_id: intent().operation_id,
  operation: "login",
  receipt_outcome: "pending",
  ...summary(),
  ...overrides,
});
// Before the synthetic intents' admission deadline.
const start = Date.parse("2026-10-03T00:00:00.000Z");
const tracker = (now = () => start) => {
  const value = new McpAuthTracker(now);
  value.bind(source);
  return value;
};

test("a lost start queries its original identity without starting another login", () => {
  const value = tracker();
  const request = intent();
  expect(value.begin(source, request)).toBe(true);
  value.markUnknown(source, request);
  expect(value.begin(source, intent())).toBe(false);
  expect(value.query(identity)).toEqual({
    ...identity,
    operation_id: request.operation_id,
    action: "status",
    operation: "login",
  });
  value.observeSummary(
    identity,
    summary({ auth_phase: "authenticated", tools_status: "current", phase_version: 4 }),
  );
  expect(value.current(identity)?.unknown).toBe(true);
  expect(value.accept(source, result())).toBe(true);
  expect(value.current(identity)?.unknown).toBe(false);
  expect(value.summary(identity)?.phase_version).toBe(4);
});

test("a missing receipt stays unknown only while the request can still be admitted", () => {
  let clock = start;
  const value = tracker(() => clock);
  value.begin(source, intent());
  expect(value.accept(source, result({ receipt_outcome: "missing" }))).toBe(true);
  expect(value.current(identity)?.unknown).toBe(true);
  expect(value.begin(source, intent())).toBe(false);
  // After the deadline the Host can never admit it: the returned summary decides what to show.
  clock = Date.parse(intent().accept_before) + 1;
  const required = { auth_phase: "required", tools_status: "stale", phase_version: 2 } as const;
  expect(value.accept(source, result({ receipt_outcome: "missing", ...required }))).toBe(true);
  expect(value.current(identity)).toBeUndefined();
  expect(mcpAuthPresentation(summary(required), value.current(identity))).toEqual({
    label: "需重新登入",
    action: "start",
    button: "登入",
  });
  expect(value.begin(source, intent("start", "00000000-0000-4000-8000-000000000005"))).toBe(true);
});

test("an expired receipt settles on the Host's current summary instead of staying unknown", () => {
  const value = tracker();
  for (const forget of [false, true]) {
    value.begin(source, intent());
    if (forget) value.begin(source, intent("forget", "00000000-0000-4000-8000-000000000004"));
    const operation = forget
      ? { operation: "forget" as const, operation_id: "00000000-0000-4000-8000-000000000004" }
      : {};
    const connected = {
      auth_phase: "authenticated",
      tools_status: "current",
      phase_version: forget ? 4 : 3,
    } as const;
    expect(
      value.accept(source, result({ receipt_outcome: "expired", ...connected, ...operation })),
    ).toBe(true);
    // Neither the forget nor the login it replaced is left behind to block the next action.
    expect(value.current(identity)).toBeUndefined();
    expect(value.saved(identity)).toBeUndefined();
    expect(mcpAuthPresentation(summary(connected), value.current(identity)).label).toBe("已連線");
  }
});

test("wrong identities never acknowledge a pending login", () => {
  const value = tracker();
  value.begin(source, intent());
  value.markUnknown(source, intent());
  for (const wrong of [
    { instance_id: "00000000-0000-4000-8000-000000000009" },
    { server_id: "00000000-0000-4000-8000-000000000009" },
    { config_fingerprint: "2".repeat(64) },
    { operation_id: "00000000-0000-4000-8000-000000000009" },
    { operation: "forget" as const },
  ])
    expect(value.accept(source, result({ receipt_outcome: "completed", ...wrong }))).toBe(false);
  expect(value.accept("another-owner", result({ receipt_outcome: "completed" }))).toBe(false);
  expect(value.accept(source, { ...result(), token: "synthetic-not-a-token" })).toBe(false);
  expect(value.current(identity)?.unknown).toBe(true);
});

test("pending status cannot settle a lost cancel; completed login wins a late cancellation", () => {
  const value = tracker();
  value.begin(source, intent());
  value.accept(source, result());
  const cancel = value.cancel(source, identity);
  expect(cancel).toEqual({ ...intent(), action: "cancel" });
  if (!cancel) throw new Error("Missing cancel");
  value.markUnknown(source, cancel);
  expect(value.accept(source, result({ phase_version: 2 }))).toBe(true);
  expect(value.current(identity)?.unknown).toBe(true);
  expect(value.cancel(source, identity)).toBeUndefined();
  expect(mcpAuthPresentation(summary(), value.current(identity)).action).toBe("query");
  expect(
    value.accept(
      source,
      result({
        receipt_outcome: "completed",
        auth_phase: "authenticated",
        tools_status: "current",
        phase_version: 3,
      }),
    ),
  ).toBe(true);
  expect(value.current(identity)).toBeUndefined();
});

test("failure saving a cancellation preserves the original host login for read-only recovery", () => {
  const value = tracker();
  value.begin(source, intent());
  value.accept(source, result());
  const cancel = value.cancel(source, identity);
  if (!cancel) throw new Error("Missing cancel");
  value.reject(source, cancel);
  expect(value.current(identity)?.request.operation_id).toBe(intent().operation_id);
  expect(value.current(identity)?.unknown).toBe(true);
  expect(value.current(identity)?.cancelling).toBe(false);
  expect(value.begin(source, intent())).toBe(false);
  value.accept(source, result());
  expect(value.current(identity)?.unknown).toBe(false);
});

test("a captured pending read becomes stale after cancel, forget or completion", () => {
  const value = tracker();
  value.begin(source, intent());
  value.accept(source, result());
  const beforeCancel = value.saved(identity);
  expect(value.queryStillCurrent(source, beforeCancel)).toBe(true);
  value.cancel(source, identity);
  expect(value.queryStillCurrent(source, beforeCancel)).toBe(false);
  const beforeForget = value.saved(identity);
  value.begin(source, intent("forget", "00000000-0000-4000-8000-000000000004"));
  expect(value.queryStillCurrent(source, beforeForget)).toBe(false);
  const beforeComplete = value.saved(identity);
  value.accept(
    source,
    result({
      operation: "forget",
      operation_id: "00000000-0000-4000-8000-000000000004",
      receipt_outcome: "completed",
      phase_version: 3,
    }),
  );
  expect(value.queryStillCurrent(source, beforeComplete)).toBe(false);
  expect(value.queryStillCurrent("foreign-owner", beforeComplete)).toBe(false);
});

test("forget recovery retains the old attempt until its own receipt completes", () => {
  const value = tracker();
  value.begin(source, intent());
  expect(
    mcpAuthPresentation(summary({ auth_phase: "required" }), value.current(identity), true),
  ).toEqual({ label: "啟動登入中…", action: "none", button: "" });
  value.markUnknown(source, intent());
  expect(
    mcpAuthPresentation(summary({ auth_phase: "required" }), value.current(identity), true),
  ).toEqual({ label: "登入狀態待確認", action: "query", button: "查詢狀態" });
  const forget = intent("forget", "00000000-0000-4000-8000-000000000004");
  expect(value.begin(source, forget)).toBe(true);
  expect(value.saved(identity)?.previous?.request.operation_id).toBe(intent().operation_id);
  expect(value.accept(source, result({ receipt_outcome: "completed", phase_version: 10 }))).toBe(
    false,
  );
  expect(
    value.accept(
      source,
      result({
        operation: "forget",
        operation_id: forget.operation_id,
        receipt_outcome: "missing",
      }),
    ),
  ).toBe(true);
  expect(value.current(identity)?.unknown).toBe(true);
  expect(
    value.accept(
      source,
      result({
        operation: "forget",
        operation_id: forget.operation_id,
        receipt_outcome: "completed",
        auth_phase: "required",
        phase_version: 3,
      }),
    ),
  ).toBe(true);
  expect(value.current(identity)).toBeUndefined();
  expect(
    value.accept(
      source,
      result({ receipt_outcome: "completed", auth_phase: "authenticated", phase_version: 2 }),
    ),
  ).toBe(false);
  value.observeSummary(identity, summary({ auth_phase: "authenticated", phase_version: 2 }));
  expect(value.summary(identity)?.auth_phase).toBe("required");
});

test("failed forget restores the original unknown and other servers remain independent", () => {
  const value = tracker();
  value.begin(source, intent());
  const other = {
    ...intent(),
    server_id: "00000000-0000-4000-8000-000000000005",
    operation_id: "00000000-0000-4000-8000-000000000006",
  };
  expect(value.begin(source, other)).toBe(true);
  const forget = intent("forget", "00000000-0000-4000-8000-000000000004");
  value.begin(source, forget);
  value.accept(
    source,
    result({ operation: "forget", operation_id: forget.operation_id, receipt_outcome: "failed" }),
  );
  expect(value.current(identity)?.request.action).toBe("start");
  expect(value.current(identity)?.unknown).toBe(true);
  expect(value.current(other)?.unknown).toBe(false);
  value.bind("replacement-owner");
  expect(value.current(identity)).toBeUndefined();
  expect(value.accept(source, result())).toBe(false);
});

test("reload restores an original cancel as unknown and rejects malformed or foreign saved data", () => {
  const value = tracker();
  value.begin(source, intent());
  value.cancel(source, identity);
  const saved = value.saved(identity);
  const restored = tracker();
  expect(restored.restore(source, identity, saved)).toBe(true);
  expect(restored.current(identity)?.unknown).toBe(true);
  restored.accept(source, result());
  expect(restored.current(identity)?.unknown).toBe(true);
  for (const bad of [
    { ...saved, token: "synthetic" },
    { ...saved, cancelling: "true" },
    { ...saved, request: { ...intent(), config_fingerprint: "2".repeat(64) } },
    { ...saved, request: { ...intent(), action: "status", operation: "login" } },
    { ...saved, previous: { request: intent(), cancelling: false } },
  ])
    expect(tracker().restore(source, identity, bad)).toBe(false);
  expect(tracker().restore("foreign-owner", identity, saved)).toBe(false);
});

test("storage compare and update prevents stale cleanup or another document replacing an attempt", async () => {
  const memory: Record<string, unknown> = {};
  const storage = {
    get: async (key: string) => ({ [key]: memory[key] }),
    set: async (data: Record<string, unknown>) => {
      Object.assign(memory, structuredClone(data));
    },
    remove: async (key: string) => {
      delete memory[key];
    },
  };
  const lock = async (_: string, work: () => Promise<void>) => work();
  const value = tracker();
  value.begin(source, intent());
  const first = value.saved(identity);
  await writeMcpAuthPending(storage, "synthetic-key", first, undefined, lock);
  value.cancel(source, identity);
  const cancelling = value.saved(identity);
  await writeMcpAuthPending(storage, "synthetic-key", cancelling, first, lock);
  await expect(
    writeMcpAuthPending(storage, "synthetic-key", undefined, first, lock),
  ).rejects.toBeInstanceOf(McpAuthStorageConflict);
  await expect(
    writeMcpAuthPending(storage, "synthetic-key", first, undefined, lock),
  ).rejects.toBeInstanceOf(McpAuthStorageConflict);
  expect(memory["synthetic-key"]).toEqual(cancelling);
  await writeMcpAuthPending(storage, "synthetic-key", undefined, cancelling, lock);
  expect(memory["synthetic-key"]).toBeUndefined();
});

test("card actions distinguish login verification, current tools, list failure and receipt uncertainty", () => {
  expect(mcpAuthPresentation(summary({ auth_phase: "required" }))).toEqual({
    label: "需要登入",
    action: "start",
    button: "登入",
  });
  expect(mcpAuthPresentation(summary({ auth_phase: "verifying" })).label).toBe("確認登入中…");
  expect(
    mcpAuthPresentation(summary({ auth_phase: "authenticated", tools_status: "loading" })).label,
  ).toBe("取得工具中…");
  expect(
    mcpAuthPresentation(summary({ auth_phase: "authenticated", tools_status: "current" })).action,
  ).toBe("refresh");
  expect(
    mcpAuthPresentation(summary({ auth_phase: "authenticated", tools_status: "error" })),
  ).toEqual({ label: "工具清單讀取失敗", action: "refresh", button: "重試" });
  expect(
    mcpAuthPresentation(
      summary({
        auth_phase: "authenticated",
        tools_status: "error",
        error_code: "connection_http_403",
      }),
    ),
  ).toEqual({ label: "MCP 連線失敗", action: "refresh", button: "重試" });
  expect(
    mcpAuthPresentation(summary({ auth_phase: "error", error_code: "browser_open_failed" })).button,
  ).toBe("再次開啟");
  expect(
    mcpAuthPresentation(summary({ auth_phase: "error", error_code: "auth_expired" })).label,
  ).toBe("登入逾時");
  expect(
    mcpAuthPresentation(summary({ auth_phase: "error", error_code: "auth_unsupported" })).action,
  ).toBe("none");
  expect(
    mcpAuthPresentation(summary({ auth_phase: "error", error_code: "unknown_safe_code" })).label,
  ).toBe("登入失敗");
  expect(
    mcpAuthPresentation(summary({ auth_phase: "required", tools_status: "stale" })).label,
  ).toBe("需重新登入");
  const value = tracker();
  value.begin(source, intent());
  value.markUnknown(source, intent());
  expect(
    mcpAuthPresentation(
      summary({ auth_phase: "authenticated", tools_status: "current" }),
      value.current(identity),
    ).action,
  ).toBe("query");
});
