import { z } from "zod";

export const MCP_AUTH_LIMITS = {
  admissionMs: 30_000,
  loginMs: 5 * 60_000,
  receiptMs: 10 * 60_000,
  receipts: 64,
  retiredIds: 1024,
  pending: 4,
} as const;

/** Trusted panel information only; no authorization URL or credentials. */
export const McpAuthSummarySchema = z
  .object({
    auth_phase: z.enum(["required", "starting", "waiting", "verifying", "authenticated", "error"]),
    tools_status: z.enum(["unknown", "loading", "current", "stale", "error"]),
    phase_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    error_code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional(),
    login_domain: z
      .string()
      .max(253)
      .regex(/^[a-z0-9.-]+$/i)
      .optional(),
  })
  .strict();
export type McpAuthSummary = z.infer<typeof McpAuthSummarySchema>;

const Identity = {
  instance_id: z.string().uuid(),
  server_id: z.string().uuid(),
  config_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  operation_id: z.string().uuid(),
};
const Admission = { accept_before: z.string().datetime() };
export const McpAuthInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), ...Identity, ...Admission }).strict(),
  z.object({ action: z.literal("cancel"), ...Identity, ...Admission }).strict(),
  z.object({ action: z.literal("forget"), ...Identity, ...Admission }).strict(),
  z
    .object({ action: z.literal("status"), ...Identity, operation: z.enum(["login", "forget"]) })
    .strict(),
]);
export type McpAuthInput = z.infer<typeof McpAuthInputSchema>;

export const McpAuthResultSchema = McpAuthSummarySchema.extend({
  ...Identity,
  operation: z.enum(["login", "forget"]),
  receipt_outcome: z.enum(["pending", "completed", "failed", "cancelled", "expired", "missing"]),
}).strict();
export type McpAuthResult = z.infer<typeof McpAuthResultSchema>;
