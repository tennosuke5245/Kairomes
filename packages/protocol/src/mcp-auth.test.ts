import { expect, test } from "bun:test";
import { McpAuthInputSchema, McpAuthResultSchema } from "./mcp-auth.ts";

const identity = {
  instance_id: "00000000-0000-4000-8000-000000000001",
  server_id: "00000000-0000-4000-8000-000000000002",
  operation_id: "00000000-0000-4000-8000-000000000003",
  config_fingerprint: "a".repeat(64),
};

test("登入管理輸入拒絕憑證與任意目的地，查詢不能帶入新期限", () => {
  const start = { action: "start", ...identity, accept_before: "2026-10-03T01:00:00.000Z" };
  expect(McpAuthInputSchema.safeParse(start).success).toBe(true);
  for (const extra of ["token", "code", "state", "authorization_url", "issuer", "scope"])
    expect(McpAuthInputSchema.safeParse({ ...start, [extra]: "synthetic" }).success).toBe(false);
  const status = { action: "status", ...identity, operation: "login" };
  expect(McpAuthInputSchema.safeParse(status).success).toBe(true);
  expect(
    McpAuthInputSchema.safeParse({ ...status, accept_before: start.accept_before }).success,
  ).toBe(false);
  expect(McpAuthInputSchema.safeParse({ ...start, accept_before: 1 }).success).toBe(false);
});

test("登入管理回應只容許短分類與公開網域", () => {
  const result = {
    ...identity,
    operation: "login",
    receipt_outcome: "pending",
    auth_phase: "waiting",
    tools_status: "unknown",
    phase_version: 1,
    login_domain: "login.example.com",
  };
  expect(McpAuthResultSchema.safeParse(result).success).toBe(true);
  for (const extra of ["token", "client_secret", "authorization_url", "message"])
    expect(McpAuthResultSchema.safeParse({ ...result, [extra]: "synthetic" }).success).toBe(false);
  expect(
    McpAuthResultSchema.safeParse({ ...result, login_domain: "https://login.example.com/?code=x" })
      .success,
  ).toBe(false);
  expect(
    McpAuthResultSchema.safeParse({ ...result, error_code: "raw error with private content" })
      .success,
  ).toBe(false);
});
