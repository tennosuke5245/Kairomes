import { z } from "zod";
import { DenialReasonSchema } from "./approval.ts";

const CommandStateSchema = z.enum([
  "pending",
  "starting",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "denied",
  "expired",
]);
const CommandSchema = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  cwd: z.string(),
  argv: z.array(z.string()),
  timeout_ms: z.number().int(),
  state: CommandStateSchema,
  created_at: z.number(),
  started_at: z.number().nullable(),
  ended_at: z.number().nullable(),
  /** Epoch milliseconds; the approval deadline while pending, then the run deadline. */
  expires_at: z.number(),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  message: z.string().nullable(),
  /** Present only on a denied command whose local user typed a reason. */
  denial_reason: DenialReasonSchema.optional(),
});
export type Command = z.infer<typeof CommandSchema>;
export interface CommandApproval extends Command {
  fingerprint: string;
  absolute_cwd: string;
  executable: string;
  workspace_name: string;
}
export const CommandResultSchema = z.object({
  kind: z.literal("command"),
  command: CommandSchema,
  stdout: z.string(),
  stderr: z.string(),
  stdout_cursor: z.number().int().nonnegative(),
  stderr_cursor: z.number().int().nonnegative(),
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  has_more: z.boolean(),
  output_complete: z.boolean(),
});
export const CommandListSchema = z.object({
  kind: z.literal("commands"),
  commands: z.array(CommandSchema),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;
const Cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0);
/** Longest long poll for command_poll and terminal_poll; stays below the relay's 30 s timeout. */
export const POLL_WAIT_MAX_MS = 20_000;
/** Optional long-poll wait shared by command_poll and terminal_poll; 0 keeps a plain poll. */
export const PollWaitMs = z.number().int().min(0).max(POLL_WAIT_MAX_MS).default(0);
export const CommandInputs = {
  command_request: z
    .object({
      workspace_id: z.string().uuid(),
      request_id: z.string().uuid(),
      cwd: z.string().max(1024).default(""),
      argv: z
        .array(
          z
            .string()
            .max(4096)
            .refine((value) => !value.includes("\0"), "不接受 NUL"),
        )
        .min(1)
        .max(64),
      timeout_ms: z.number().int().min(100).max(900000).default(120000),
    })
    .strict(),
  command_list: z.object({}).strict(),
  command_poll: z
    .object({
      command_id: z.string().uuid(),
      stdout_cursor: Cursor,
      stderr_cursor: Cursor,
      wait_ms: PollWaitMs,
    })
    .strict(),
  command_cancel: z.object({ command_id: z.string().uuid() }).strict(),
};
export const commandLabels: Record<Command["state"], string> = {
  pending: "等待核准",
  starting: "啟動中",
  running: "執行中",
  succeeded: "已成功",
  failed: "已失敗",
  timed_out: "已逾時",
  cancelled: "已取消",
  denied: "已拒絕",
  expired: "授權已到期",
};
export function commandActive(command: Pick<Command, "state">) {
  return ["pending", "starting", "running"].includes(command.state);
}
