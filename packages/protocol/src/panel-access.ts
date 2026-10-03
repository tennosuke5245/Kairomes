import { z } from "zod";
import type { PanelSnapshot } from "./activity.ts";

export const PANEL_ACCESS_LIMITS = {
  intentMs: 30_000,
  receiptMs: 10 * 60_000,
  receipts: 64,
  pending: 4,
  primaryIds: 128,
  ids: 256,
  owners: 8,
} as const;

const Identity = {
  request_id: z.string().uuid().optional(),
  valid_until: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
};
const Supersedes = z
  .object({
    request_id: z.string().uuid(),
    valid_until: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const PanelAccessMutationSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("enable"),
        workspace_id: z.string().uuid(),
        level: z.enum(["files", "full"]).default("full"),
        minutes: z.union([z.literal(15), z.literal(60), z.literal(240), z.null()]).default(60),
        ...Identity,
      })
      .strict(),
    z
      .object({
        action: z.literal("disable"),
        workspace_id: z.string().uuid(),
        ...Identity,
        supersedes: Supersedes.optional(),
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    if ((input.request_id === undefined) !== (input.valid_until === undefined))
      context.addIssue({ code: "custom", message: "Request identity and deadline must be paired" });
    if (input.action === "disable" && input.supersedes && !input.request_id)
      context.addIssue({ code: "custom", message: "Recovery requires a request identity" });
    if (
      input.action === "disable" &&
      input.supersedes &&
      input.supersedes.request_id === input.request_id
    )
      context.addIssue({ code: "custom", message: "Recovery must have its own request identity" });
  });
export type PanelAccessMutation = z.infer<typeof PanelAccessMutationSchema>;
export type TrackedPanelAccessMutation = PanelAccessMutation & {
  request_id: string;
  valid_until: number;
};
export const PanelAccessStatusSchema = z
  .object({ action: z.literal("status"), request_id: z.string().uuid() })
  .strict();
export const PanelAccessInputSchema = z.union([PanelAccessMutationSchema, PanelAccessStatusSchema]);
export const PanelAccessReceiptSchema = z
  .object({
    request_id: z.string().uuid(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    state: z.enum(["pending", "completed", "failed", "superseded", "expired", "missing"]),
    message: z.string().max(200).optional(),
  })
  .strict();
export type PanelAccessReceipt = z.infer<typeof PanelAccessReceiptSchema>;
export type PanelAccessResponse = PanelSnapshot & { access_receipt?: PanelAccessReceipt };

/** Only normalized inputs belong in this identity; it contains no token or grant. */
export function panelAccessIdentity(input: TrackedPanelAccessMutation) {
  return JSON.stringify([
    input.action,
    input.workspace_id,
    input.action === "enable" ? input.level : null,
    input.action === "enable" ? input.minutes : null,
    input.request_id,
    input.valid_until,
    input.action === "disable" && input.supersedes
      ? [input.supersedes.request_id, input.supersedes.valid_until, input.supersedes.fingerprint]
      : null,
  ]);
}

export async function panelAccessFingerprint(input: TrackedPanelAccessMutation) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(panelAccessIdentity(input)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
