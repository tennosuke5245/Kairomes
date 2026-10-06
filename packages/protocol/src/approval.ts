import { z } from "zod";

/**
 * Longest denial reason in Unicode code points (how Zod counts). An HTML maxlength of 200
 * counts UTF-16 code units, so a field limited that way always stays within it.
 */
export const DENIAL_REASON_MAX_LENGTH = 200;

// Control characters, line separators and bidirectional overrides could hide or reorder text.
const unsafeReasonCharacters = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/**
 * Optional explanation the trusted local user attaches when denying a request. It is
 * trimmed, 1-200 code points and single-line. The model reads it back as `denial_reason`
 * on the denied item; only the paired Extension and the admin channel may submit one.
 */
export const DenialReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(DENIAL_REASON_MAX_LENGTH)
  .refine((value) => !unsafeReasonCharacters.test(value), {
    message: "拒絕原因不能包含控制字元或換行。",
  });

const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const Target = {
  session_id: z.string().uuid().optional(),
  command_id: z.string().uuid().optional(),
  change_id: z.string().uuid().optional(),
  import_id: z.string().uuid().optional(),
};
function singleTarget(input: {
  session_id?: string;
  command_id?: string;
  change_id?: string;
  import_id?: string;
}) {
  return (
    [input.session_id, input.command_id, input.change_id, input.import_id].filter(Boolean)
      .length === 1
  );
}

/**
 * Body of the trusted decision routes: `/api/panel/approvals` (paired Extension) and
 * `/api/approvals` (admin token). Exactly one target ID is required for a decision or stop.
 * `reason` is accepted only with `deny`; approve and stop reject it as an unknown key.
 */
export const ApprovalInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({ action: z.literal("approve"), ...Target, fingerprint: Fingerprint })
    .strict()
    .refine(singleTarget, "請指定一個核准目標"),
  z
    .object({
      action: z.literal("deny"),
      ...Target,
      fingerprint: Fingerprint,
      reason: DenialReasonSchema.optional(),
    })
    .strict()
    .refine(singleTarget, "請指定一個核准目標"),
  z
    .object({ action: z.literal("stop"), ...Target, fingerprint: z.string().optional() })
    .strict()
    .refine(singleTarget, "請指定一個停止目標"),
]);
/** What a trusted client sends. */
export type ApprovalInput = z.input<typeof ApprovalInputSchema>;
/** A validated approve, deny or stop; `reason` is already trimmed. */
export type ApprovalDecision = Exclude<z.output<typeof ApprovalInputSchema>, { action: "list" }>;
