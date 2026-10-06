import { z } from "zod";
import type { Artifact } from "./artifact.ts";

/** ChatGPT injects this object for fields declared in openai/fileParams. */
const OpenAIFileReferenceSchema = z
  .object({
    download_url: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        "Temporary HTTPS download URL injected by the ChatGPT host. Never use /mnt/data, sandbox:, a local path or a model-invented URL.",
      ),
    file_id: z
      .string()
      .min(1)
      .max(512)
      .describe("Opaque OpenAI file ID paired with the host-injected download URL."),
    mime_type: z.string().min(1).max(200).optional().describe("Host-reported MIME type."),
    file_name: z.string().min(1).max(255).optional().describe("Host-reported file name."),
  })
  .strict();
export type OpenAIFileReference = z.infer<typeof OpenAIFileReferenceSchema>;

export type ArtifactImport = {
  id: string;
  request_id: string;
  workspace_id: string;
  path: string;
  summary: string;
  source_file_id: string;
  source_file_name: string | null;
  claimed_mime_type: string | null;
  mime_type: Artifact["mime_type"];
  byte_size: number;
  width: number;
  height: number;
  version: string;
  state:
    | "pending"
    | "applying"
    | "applied"
    | "denied"
    | "cancelled"
    | "expired"
    | "conflict"
    | "failed";
  created_at: number;
  applied_at: number | null;
  /** Epoch milliseconds; while pending, the approval deadline. */
  expires_at: number;
  message: string | null;
  /** Present only on a denied import whose local user typed a reason. */
  denial_reason?: string;
  artifact: Artifact | null;
};

export interface ArtifactImportApproval extends ArtifactImport {
  fingerprint: string;
  workspace_name: string;
}

export type ArtifactImportResult = {
  kind: "artifact_import";
  artifact_import: ArtifactImport;
};

/** Internal media-import request while the public ChatGPT host contract is paused. */
export const ArtifactImportRequestSchema = z
  .object({
    workspace_id: z.string().uuid(),
    request_id: z.string().uuid(),
    path: z.string().min(1).max(1024),
    summary: z.string().min(1).max(200),
    file: OpenAIFileReferenceSchema.describe(
      "Actual ChatGPT file parameter. The host must inject file_id and a temporary download_url.",
    ),
  })
  .strict();

export const artifactImportLabels: Record<ArtifactImport["state"], string> = {
  pending: "等待核准",
  applying: "寫入中",
  applied: "已匯入",
  denied: "已拒絕",
  cancelled: "已取消",
  expired: "已過期",
  conflict: "目的檔案已存在",
  failed: "匯入失敗",
};

export function artifactImportActive(value: Pick<ArtifactImport, "state">) {
  return value.state === "pending" || value.state === "applying";
}
