import { expect, test } from "bun:test";
import {
  ApprovalInputSchema,
  DENIAL_REASON_MAX_LENGTH,
  DenialReasonSchema,
  FileChangeResultSchema,
} from "./index.ts";

const char = (code: number) => String.fromCodePoint(code);
const id = "00000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);

test("denial reasons are trimmed, bounded and single-line", () => {
  expect(DenialReasonSchema.parse("  請改用既有的 helper  ")).toBe("請改用既有的 helper");
  expect(DenialReasonSchema.parse("請".repeat(DENIAL_REASON_MAX_LENGTH))).toHaveLength(200);
  // Surrounding whitespace, including line breaks, is trimmed before the length check.
  expect(DenialReasonSchema.parse(`${char(10)} ${"a".repeat(200)} ${char(9)}`)).toHaveLength(200);
  // Emoji sequences (joined with U+200D) are ordinary text; the limit counts code points.
  const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map(char).join("");
  expect(DenialReasonSchema.parse(`不要 ${family}`)).toBe(`不要 ${family}`);
  expect(DenialReasonSchema.safeParse(char(0x1f600).repeat(200)).success).toBe(true);
  expect(DenialReasonSchema.safeParse(char(0x1f600).repeat(201)).success).toBe(false);

  for (const rejected of [
    "",
    "   ",
    "a".repeat(201),
    `第一行${char(10)}第二行`,
    `tab${char(9)}inside`,
    `bell${char(7)}`,
    `null${char(0)}byte`,
    `delete${char(0x7f)}`,
    `c1${char(0x85)}control`,
    `line${char(0x2028)}separator`,
    `paragraph${char(0x2029)}separator`,
    `override${char(0x202e)}txt.exe`,
    `isolate${char(0x2066)}text${char(0x2069)}`,
  ])
    expect(DenialReasonSchema.safeParse(rejected).success).toBe(false);
});

test("decision bodies accept a reason only together with deny", () => {
  expect(
    ApprovalInputSchema.parse({ action: "deny", change_id: id, fingerprint, reason: " 太大 " }),
  ).toEqual({ action: "deny", change_id: id, fingerprint, reason: "太大" });
  expect(ApprovalInputSchema.parse({ action: "deny", command_id: id, fingerprint })).toEqual({
    action: "deny",
    command_id: id,
    fingerprint,
  });
  for (const body of [
    { action: "approve", session_id: id, fingerprint, reason: "ok" },
    { action: "stop", command_id: id, reason: "stop it" },
    { action: "list", reason: "x" },
    { action: "deny", import_id: id, fingerprint, reason: "" },
    { action: "deny", import_id: id, fingerprint, reason: `a${char(7)}` },
    { action: "deny", import_id: id, fingerprint, reason: "a".repeat(201) },
    { action: "deny", import_id: id, fingerprint, reason: 42 },
    // Exactly one target and a well-formed fingerprint are still required.
    { action: "deny", fingerprint, reason: "x" },
    { action: "deny", change_id: id, command_id: id, fingerprint, reason: "x" },
    { action: "deny", change_id: id, fingerprint: "bad", reason: "x" },
  ])
    expect(ApprovalInputSchema.safeParse(body).success).toBe(false);
});

test("model-facing results declare the optional denial reason", () => {
  const change = {
    id,
    request_id: id,
    workspace_id: id,
    summary: "更新",
    state: "denied",
    created_at: 1,
    applied_at: null,
    expires_at: 2,
    message: null,
    files: [],
  };
  const result = { kind: "file_change", change, diff: "", diff_truncated: false };
  expect(FileChangeResultSchema.safeParse(result).success).toBe(true);
  expect(
    FileChangeResultSchema.parse({ ...result, change: { ...change, denial_reason: "改小一點" } })
      .change.denial_reason,
  ).toBe("改小一點");
  expect(
    FileChangeResultSchema.safeParse({ ...result, change: { ...change, denial_reason: "" } })
      .success,
  ).toBe(false);
});
