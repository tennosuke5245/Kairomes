import { z } from "zod";
import { DenialReasonSchema } from "./approval.ts";

const FileVersion = z.string().regex(/^[a-f0-9]{64}$/);
const FilePath = z.string().min(1).max(1024);
const ReplacementSchema = z
  .object({
    old_text: z.string().min(1).max(32768),
    new_text: z.string().max(32768),
    replace_all: z.boolean().default(false),
  })
  .strict();

const FileChangeOperationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("edit"),
      path: FilePath,
      expected_version: FileVersion,
      replacements: z.array(ReplacementSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      operation: z.literal("write"),
      path: FilePath,
      expected_version: FileVersion.nullable().default(null),
      content: z.string().max(65536),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      path: FilePath,
      expected_version: FileVersion,
    })
    .strict(),
]);
export type FileChangeOperation = z.infer<typeof FileChangeOperationSchema>;

const FileChangeStateSchema = z.enum([
  "pending",
  "applying",
  "applied",
  "denied",
  "cancelled",
  "expired",
  "conflict",
  "failed",
]);
const FileChangeItemSchema = z.object({
  operation: z.enum(["edit", "write", "delete"]),
  path: FilePath,
  before_version: FileVersion.nullable(),
  after_version: FileVersion.nullable(),
});
const FileChangeSchema = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  summary: z.string(),
  state: FileChangeStateSchema,
  created_at: z.number(),
  applied_at: z.number().nullable(),
  /** Epoch milliseconds; while pending, the approval deadline. */
  expires_at: z.number(),
  message: z.string().nullable(),
  /** Present only on a denied change whose local user typed a reason. */
  denial_reason: DenialReasonSchema.optional(),
  files: z.array(FileChangeItemSchema),
});
export type FileChange = z.infer<typeof FileChangeSchema>;
export interface FileChangeApproval extends FileChange {
  fingerprint: string;
  workspace_name: string;
  /**
   * Review diff while the change is pending or applying; empty once it has finished, so the
   * trusted panel snapshot stays small. Check diff_available before rendering.
   */
  diff: string;
  diff_truncated: boolean;
  /** True only for pending and applying changes, whose full review diff is included. */
  diff_available: boolean;
}
export const FileChangeResultSchema = z.object({
  kind: z.literal("file_change"),
  change: FileChangeSchema,
  diff: z.string(),
  diff_truncated: z.boolean(),
});
export type FileChangeResult = z.infer<typeof FileChangeResultSchema>;
export const FileChangeListSchema = z.object({
  kind: z.literal("file_changes"),
  changes: z.array(FileChangeSchema),
});

export const FileChangeInputs = {
  file_change_request: z
    .object({
      workspace_id: z.string().uuid(),
      request_id: z.string().uuid(),
      summary: z.string().min(1).max(200),
      changes: z.array(FileChangeOperationSchema).min(1).max(16),
    })
    .strict(),
  file_change_list: z.object({}).strict(),
  file_change_poll: z.object({ change_id: z.string().uuid() }).strict(),
  file_change_cancel: z.object({ change_id: z.string().uuid() }).strict(),
} as const;

export const fileChangeLabels: Record<FileChange["state"], string> = {
  pending: "等待核准",
  applying: "套用中",
  applied: "已套用",
  denied: "已拒絕",
  cancelled: "已取消",
  expired: "已過期",
  conflict: "檔案已變更",
  failed: "套用失敗",
};

export function fileChangeActive(change: Pick<FileChange, "state">) {
  return ["pending", "applying"].includes(change.state);
}
