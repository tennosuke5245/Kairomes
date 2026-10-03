import { z } from "zod";

export const HANDOFF_LIMITS = { files: 20, bytes: 8 * 1024 * 1024, text: 6000 } as const;
export type HandoffCoverage = {
  hasOlderTurns: boolean;
  textTruncated: boolean;
  itemsTruncated: boolean;
  recentTurnsRequested: number;
};

/** Safe filtering is deliberate; clipping eligible evidence is incomplete coverage. */
export function handoffCoverageTruncated(coverage: HandoffCoverage) {
  return coverage.textTruncated || coverage.itemsTruncated;
}

const ShortText = z.string().trim().max(500);
export const HandoffFieldsSchema = z
  .object({
    goal: ShortText.min(1),
    next_action: ShortText.min(1),
    completed: z.string().trim().max(1000).default(""),
    decisions: z.string().trim().max(1000).default(""),
    unknowns: z.string().trim().max(1000).default(""),
  })
  .strict();
export type HandoffFields = z.infer<typeof HandoffFieldsSchema>;

const DraftId = z.string().uuid();
export const HandoffInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start"),
      workspace_id: z.string().uuid(),
      provider: z.enum(["codex", "manual"]),
      draft_id: DraftId.optional(),
    })
    .strict(),
  z.object({ action: z.literal("list"), draft_id: DraftId, cursor: z.string().max(4096) }).strict(),
  z
    .object({
      action: z.literal("snapshot"),
      draft_id: DraftId,
      session_id: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("baseline"),
      draft_id: DraftId,
      paths: z.array(z.string().min(1).max(1024)).max(HANDOFF_LIMITS.files),
    })
    .strict(),
  z
    .object({
      action: z.literal("preview"),
      draft_id: DraftId,
      fields: HandoffFieldsSchema,
      source_stopped: z.boolean(),
      permissions_checked: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("prepare"),
      draft_id: DraftId,
      content_digest: z.string().regex(/^[a-f0-9]{64}$/),
      source_stopped: z.literal(true),
      permissions_checked: z.literal(true),
    })
    .strict(),
  z.object({ action: z.literal("cancel"), draft_id: DraftId }).strict(),
]);
export type HandoffInput = z.infer<typeof HandoffInputSchema>;
export function handoffSourceBlock(status: string, pendingTurns: number) {
  if (pendingTurns > 0 || ["inProgress", "active", "running"].includes(status))
    return {
      code: "HANDOFF_PENDING",
      message: "來源仍有進行中紀錄，僅供核對。",
    };
  if (["idle", "notLoaded"].includes(status)) return null;
  return {
    code: "HANDOFF_SOURCE_STATE",
    message: ["systemError", "error", "unavailable"].includes(status)
      ? "來源目前無法核對，請重新選取或改用手動摘要。"
      : "來源狀態未知，請重新選取或改用手動摘要。",
  };
}
export type HandoffPreview = {
  text: string;
  digest: string;
  complete: boolean;
  blocked_reason: string | null;
};
export type HandoffBaseline = {
  captured_at: string;
  files: {
    path: string;
    state: "supported" | "unknown";
    version: string | null;
    bytes: number | null;
    reason: string | null;
  }[];
  complete: boolean;
  total_bytes: number;
  git: {
    state: "available" | "unavailable";
    head: string | null;
    branch: string | null;
    dirty: { status: string; path: string; previousPath?: string }[];
    truncated: boolean;
  };
};
