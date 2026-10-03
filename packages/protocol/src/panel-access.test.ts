import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  PanelAccessInputSchema,
  PanelAccessMutationSchema,
  PanelAccessReceiptSchema,
  PanelAccessStatusSchema,
  panelAccessFingerprint,
  panelAccessIdentity,
  type TrackedPanelAccessMutation,
} from "./panel-access.ts";

const workspace = "10000000-0000-4000-8000-000000000001";
const otherWorkspace = "10000000-0000-4000-8000-000000000002";
const request = "20000000-0000-4000-8000-000000000001";
const otherRequest = "20000000-0000-4000-8000-000000000002";
const recoveryRequest = "20000000-0000-4000-8000-000000000003";
const deadline = 1_800_000_030_000;
const hash = "a".repeat(64);
const enable = {
  action: "enable" as const,
  workspace_id: workspace,
  request_id: request,
  valid_until: deadline,
};
const supersedes = { request_id: request, valid_until: deadline, fingerprint: hash };
const recovery = {
  action: "disable" as const,
  workspace_id: workspace,
  request_id: recoveryRequest,
  valid_until: deadline + 1,
  supersedes,
};

function tracked(input: unknown): TrackedPanelAccessMutation {
  const parsed = PanelAccessMutationSchema.parse(input);
  if (parsed.request_id === undefined || parsed.valid_until === undefined)
    throw new Error("Tracked test input requires paired identity");
  return { ...parsed, request_id: parsed.request_id, valid_until: parsed.valid_until };
}

test("legacy access bodies retain their defaults without acquiring a tracked identity", () => {
  expect(PanelAccessMutationSchema.parse({ action: "enable", workspace_id: workspace })).toEqual({
    action: "enable",
    workspace_id: workspace,
    level: "full",
    minutes: 60,
  });
  expect(
    PanelAccessInputSchema.parse({
      action: "enable",
      workspace_id: workspace,
      level: "files",
      minutes: null,
    }),
  ).toEqual({ action: "enable", workspace_id: workspace, level: "files", minutes: null });
  expect(PanelAccessInputSchema.parse({ action: "disable", workspace_id: workspace })).toEqual({
    action: "disable",
    workspace_id: workspace,
  });
});

test("tracked mutations require a paired UUID and a safe positive integer deadline", () => {
  for (const action of ["enable", "disable"] as const) {
    const base = { action, workspace_id: workspace };
    expect(PanelAccessMutationSchema.safeParse({ ...base, request_id: request }).success).toBe(
      false,
    );
    expect(PanelAccessMutationSchema.safeParse({ ...base, valid_until: deadline }).success).toBe(
      false,
    );
    for (const valid_until of [1, deadline, Number.MAX_SAFE_INTEGER])
      expect(
        PanelAccessMutationSchema.safeParse({ ...base, request_id: request, valid_until }).success,
      ).toBe(true);
    for (const valid_until of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "30000"])
      expect(
        PanelAccessMutationSchema.safeParse({ ...base, request_id: request, valid_until }).success,
      ).toBe(false);
  }
});

test("access mutation bodies reject unsupported values and unrecognized authority fields", () => {
  for (const invalid of [
    { ...enable, action: "approve" },
    { ...enable, workspace_id: "project-name" },
    { ...enable, request_id: "request-name" },
    { ...enable, level: "admin" },
    { ...enable, minutes: 30 },
    { ...enable, minutes: "60" },
    { ...enable, token: "synthetic-value" },
    { ...enable, supersedes },
    { action: "disable", workspace_id: workspace, level: "full" },
    { action: "disable", workspace_id: workspace, minutes: 60 },
  ])
    expect(PanelAccessInputSchema.safeParse(invalid).success).toBe(false);
  for (const minutes of [15, 60, 240, null])
    expect(PanelAccessMutationSchema.safeParse({ ...enable, minutes }).success).toBe(true);
});

test("recovery requires a distinct tracked disable and a complete strict superseded identity", () => {
  expect(PanelAccessMutationSchema.parse(recovery)).toEqual(recovery);
  for (const invalid of [
    { action: "disable", workspace_id: workspace, supersedes },
    { ...recovery, request_id: request },
    { ...recovery, valid_until: undefined },
    { ...recovery, supersedes: { ...supersedes, request_id: "invalid" } },
    { ...recovery, supersedes: { ...supersedes, valid_until: 0 } },
    { ...recovery, supersedes: { ...supersedes, valid_until: Number.MAX_SAFE_INTEGER + 1 } },
    { ...recovery, supersedes: { request_id: request, fingerprint: hash } },
    { ...recovery, supersedes: { request_id: request, valid_until: deadline } },
    { ...recovery, supersedes: { ...supersedes, fingerprint: "a".repeat(63) } },
    { ...recovery, supersedes: { ...supersedes, fingerprint: "A".repeat(64) } },
    { ...recovery, supersedes: { ...supersedes, workspace_id: otherWorkspace } },
  ])
    expect(PanelAccessMutationSchema.safeParse(invalid).success).toBe(false);
});

test("normalized defaults and object key order produce the same browser and node fingerprint", async () => {
  const implicit = tracked(enable);
  const explicit = tracked({
    minutes: 60,
    valid_until: deadline,
    level: "full",
    request_id: request,
    workspace_id: workspace,
    action: "enable",
  });
  expect(panelAccessIdentity(implicit)).toBe(panelAccessIdentity(explicit));
  const actual = await panelAccessFingerprint(implicit);
  expect(actual).toMatch(/^[a-f0-9]{64}$/);
  expect(actual).toBe(await panelAccessFingerprint(explicit));
  expect(actual).toBe(createHash("sha256").update(panelAccessIdentity(explicit)).digest("hex"));
});

test("a tracked enable fingerprint binds action, workspace, level, duration, ID and deadline", async () => {
  const original = await panelAccessFingerprint(tracked(enable));
  for (const changed of [
    { ...enable, action: "disable" },
    { ...enable, workspace_id: otherWorkspace },
    { ...enable, level: "files" },
    { ...enable, minutes: 15 },
    { ...enable, minutes: 240 },
    { ...enable, minutes: null },
    { ...enable, request_id: otherRequest },
    { ...enable, valid_until: deadline + 1 },
  ])
    expect(await panelAccessFingerprint(tracked(changed))).not.toBe(original);
});

test("recovery fingerprint binds the full superseded identity as well as its own intent", async () => {
  const original = await panelAccessFingerprint(tracked(recovery));
  for (const changed of [
    { ...recovery, workspace_id: otherWorkspace },
    { ...recovery, request_id: otherRequest },
    { ...recovery, valid_until: deadline + 2 },
    { ...recovery, supersedes: undefined },
    { ...recovery, supersedes: { ...supersedes, request_id: otherRequest } },
    { ...recovery, supersedes: { ...supersedes, valid_until: deadline + 1 } },
    { ...recovery, supersedes: { ...supersedes, fingerprint: "b".repeat(64) } },
  ])
    expect(await panelAccessFingerprint(tracked(changed))).not.toBe(original);
  expect(
    await panelAccessFingerprint(
      tracked({
        ...recovery,
        supersedes: { fingerprint: hash, valid_until: deadline, request_id: request },
      }),
    ),
  ).toBe(original);
});

test("read-only status accepts only the action and opaque request ID", () => {
  const status = { action: "status" as const, request_id: request };
  expect(PanelAccessStatusSchema.parse(status)).toEqual(status);
  expect(PanelAccessInputSchema.parse(status)).toEqual(status);
  expect(PanelAccessMutationSchema.safeParse(status).success).toBe(false);
  for (const invalid of [
    { action: "status" },
    { ...status, request_id: "invalid" },
    { ...status, valid_until: deadline },
    { ...status, workspace_id: workspace },
    { ...status, supersedes },
    { ...status, level: "full" },
    { ...status, token: "synthetic-value" },
  ])
    expect(PanelAccessInputSchema.safeParse(invalid).success).toBe(false);
});

test("receipt schemas retain all explicit outcomes and their nullable identity", () => {
  for (const state of [
    "pending",
    "completed",
    "failed",
    "superseded",
    "expired",
    "missing",
  ] as const)
    for (const fingerprint of [hash, null]) {
      const receipt = { request_id: request, state, fingerprint };
      expect(PanelAccessReceiptSchema.parse(receipt)).toEqual(receipt);
    }
  const receipt = {
    request_id: request,
    state: "failed" as const,
    fingerprint: hash,
    message: "合成狀態".repeat(50),
  };
  expect(PanelAccessReceiptSchema.parse(receipt)).toEqual(receipt);
});

test("malformed receipts cannot masquerade as a settled mutation or carry authority", () => {
  const receipt = { request_id: request, state: "pending", fingerprint: hash };
  for (const invalid of [
    { ...receipt, request_id: "invalid" },
    { state: "pending", fingerprint: hash },
    { request_id: request, fingerprint: hash },
    { request_id: request, state: "missing" },
    { ...receipt, state: "success" },
    { ...receipt, state: "unknown" },
    { ...receipt, fingerprint: "a".repeat(63) },
    { ...receipt, fingerprint: "A".repeat(64) },
    { ...receipt, fingerprint: 1 },
    { ...receipt, message: "x".repeat(201) },
    { ...receipt, message: 1 },
    { ...receipt, token: "synthetic-value" },
    { ...receipt, accessGrants: [] },
    { ...receipt, valid_until: deadline },
  ])
    expect(PanelAccessReceiptSchema.safeParse(invalid).success).toBe(false);
});
