import { z } from "zod";
import { DenialReasonSchema } from "./approval.ts";
import { type Artifact, ArtifactMimeSchema, ArtifactSchema } from "./artifact.ts";

/**
 * The file object ChatGPT hydrates for a field listed in `_meta["openai/fileParams"]`. The Apps
 * SDK requires exactly these four declared properties with only `download_url` and `file_id`
 * required, so the properties stay plain strings: length limits are checked by the daemon after
 * the call instead of in the published schema the host inspects.
 */
export const OpenAIFileReferenceSchema = z
  .object({
    download_url: z.string(),
    file_id: z.string(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  })
  .strict();
export type OpenAIFileReference = z.infer<typeof OpenAIFileReferenceSchema>;

/** Bounds the daemon enforces on a hydrated file object before any network request. */
export const OPENAI_FILE_REFERENCE_LIMITS = {
  download_url: 4096,
  file_id: 512,
  mime_type: 200,
  file_name: 255,
} as const;

export const ImageImportStateSchema = z.enum([
  /** Waiting for the local user to drop, paste or choose the image in the side panel. */
  "awaiting_file",
  /** Downloading and verifying the host-provided file. */
  "preparing",
  /** Verified bytes wait for an individual approval in the paired side panel. */
  "pending",
  "applying",
  "applied",
  "denied",
  "cancelled",
  "expired",
  "conflict",
  "failed",
]);
export type ArtifactImportState = z.infer<typeof ImageImportStateSchema>;

/**
 * not_written: this import created no file. written_verified: the approved bytes were written
 * and read back. unknown: a write started and its result is not confirmed yet (always the value
 * while applying), so check the target before doing anything else.
 */
export const ImageImportWriteOutcomeSchema = z.enum(["not_written", "written_verified", "unknown"]);
export type ArtifactImportWriteOutcome = z.infer<typeof ImageImportWriteOutcomeSchema>;

/** How the bytes of an import arrived. Trusted panel and admin surfaces only. */
export type ArtifactImportDelivery = "host_file" | "user_supplied";
/**
 * Who opened an import, as recorded by the daemon (never taken from request text): `tool` for
 * an MCP or local tool request such as ChatGPT's image_import_request, `panel` for the local
 * user's own 匯入圖片 in the side panel.
 */
export type ArtifactImportOrigin = "tool" | "panel";

/**
 * Internal view shared by the trusted panel and the local workbench activity stream. It never
 * holds a download URL. Image fields stay null until verified bytes exist.
 */
export type ArtifactImport = {
  id: string;
  request_id: string;
  workspace_id: string;
  path: string;
  summary: string;
  /** Host file ID of a hydrated file parameter; null for an import without one. */
  source_file_id: string | null;
  /** Sanitized display name; never used to build a path. */
  source_file_name: string | null;
  claimed_mime_type: string | null;
  mime_type: Artifact["mime_type"] | null;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  /** Full SHA-256 of the verified bytes. */
  version: string | null;
  state: ArtifactImportState;
  write_outcome: ArtifactImportWriteOutcome;
  created_at: number;
  applied_at: number | null;
  /** Epoch milliseconds: the deadline of the current waiting state. */
  expires_at: number;
  /** Code of the last problem with the source, upload or write; null when none. */
  error_code: string | null;
  message: string | null;
  /** Present only on a denied import whose local user typed a reason. */
  denial_reason?: string;
  artifact: Artifact | null;
};

/**
 * Trusted panel view: adds the decision fingerprint and diagnostics, never a URL. The
 * fingerprint changes when verified bytes arrive, so a review of the waiting slot can never
 * approve the image: approve needs `pending` and the fingerprint of that exact content, while
 * deny also accepts the waiting fingerprint of `awaiting_file` or `preparing`.
 */
export interface ArtifactImportApproval extends ArtifactImport {
  fingerprint: string;
  workspace_name: string;
  delivery: ArtifactImportDelivery;
  /** Trusted origin: only `panel` imports may hide the summary or be withdrawn as 取消匯入. */
  origin: ArtifactImportOrigin;
  /** First 12 hex characters of `version`; decisions always compare the full hash. */
  sha256_short: string | null;
  /** The upload_id whose bytes were accepted (or are being received); null before any upload. */
  upload_id: string | null;
}

/**
 * How image_import_request calls arrived since this service started (trusted surfaces only).
 * hydrated: `file` held an allowed host download URL; omitted: no `file`; rejected: `file` was
 * an object the daemon refused (a sandbox path, Base64 or a URL off the allowlist). A `file`
 * that is not an object at all fails the published schema before it reaches the daemon.
 */
export type ImageImportHydration = { hydrated: number; omitted: number; rejected: number };

/** Formats the trusted upload route accepts as its raw request body. */
export const IMAGE_IMPORT_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** Header carrying the UUID that makes one upload attempt idempotent. */
export const IMAGE_IMPORT_UPLOAD_ID_HEADER = "X-Kairomes-Upload-Id";

const ImportId = z.string().uuid();

export const ImageImportInputs = {
  image_import_request: z
    .object({
      workspace_id: z.string().uuid(),
      request_id: z
        .string()
        .uuid()
        .describe(
          "New UUID per logical import; reuse it only to retry the identical request after an uncertain response.",
        ),
      path: z
        .string()
        .min(1)
        .max(1024)
        .describe(
          "Relative path of the new image inside the workspace, with / separators and a .png, .jpg, .jpeg or .webp extension matching the image. The parent folder must already exist; existing files are never overwritten.",
        ),
      summary: z.string().min(1).max(200).describe("Short description shown to the local user."),
      file: OpenAIFileReferenceSchema.optional().describe(
        "The conversation image as a file attached by ChatGPT. Never fill it yourself with /mnt/data or sandbox paths, Base64 or URLs; omit it when ChatGPT does not attach the image.",
      ),
    })
    .strict(),
  image_import_poll: z.object({ import_id: ImportId }).strict(),
  image_import_cancel: z.object({ import_id: ImportId }).strict(),
} as const;

/**
 * Body of `POST /api/panel/imports`, which opens a user-initiated import in `awaiting_file`.
 * The panel then uploads the bytes to `/api/panel/imports/:id/file` and the local user still
 * approves the verified preview through `/api/panel/approvals`.
 */
export const PanelImportCreateSchema = z
  .object({
    workspace_id: z.string().uuid(),
    request_id: z.string().uuid(),
    path: z.string().min(1).max(1024),
    summary: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type PanelImportCreate = z.input<typeof PanelImportCreateSchema>;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** Model-facing view. Source file IDs and names, fingerprints and delivery stay local. */
export const ImageImportSchema = z
  .object({
    id: ImportId,
    request_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    path: z.string().min(1).max(1024),
    summary: z.string().min(1).max(200),
    state: ImageImportStateSchema,
    write_outcome: ImageImportWriteOutcomeSchema,
    mime_type: ArtifactMimeSchema.nullable(),
    byte_size: z.number().int().positive().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    version: Sha256.nullable(),
    created_at: z.number().int().nonnegative(),
    expires_at: z.number().int().nonnegative(),
    applied_at: z.number().int().nonnegative().nullable(),
    error_code: z.string().max(64).nullable(),
    message: z.string().max(500).nullable(),
    denial_reason: DenialReasonSchema.optional(),
    artifact: ArtifactSchema.nullable(),
  })
  .strict();
export type ImageImport = z.infer<typeof ImageImportSchema>;
export const ImageImportResultSchema = z
  .object({
    kind: z.literal("image_import"),
    image_import: ImageImportSchema,
    /** English next step for the model. */
    guidance: z.string().max(1000),
  })
  .strict();
export type ImageImportResult = z.infer<typeof ImageImportResultSchema>;

export const artifactImportLabels: Record<ArtifactImportState, string> = {
  awaiting_file: "等待圖片",
  preparing: "準備中",
  pending: "等待核准",
  applying: "寫入中",
  applied: "已匯入",
  denied: "已拒絕",
  cancelled: "已取消",
  expired: "已過期",
  conflict: "目的檔案已存在",
  failed: "匯入失敗",
};

/**
 * State to display. `failed` with write_outcome=unknown means a file may exist at the target,
 * so it is shown as `uncertain` (結果待確認; also the `toneFor` key) and never as 匯入失敗.
 */
export function artifactImportDisplayState(
  value: Pick<ArtifactImport, "state" | "write_outcome">,
): ArtifactImportState | "uncertain" {
  return value.state === "failed" && value.write_outcome === "unknown" ? "uncertain" : value.state;
}

/** Status label from state and write_outcome; use instead of `artifactImportLabels[state]`. */
export function artifactImportLabel(value: Pick<ArtifactImport, "state" | "write_outcome">) {
  const state = artifactImportDisplayState(value);
  return state === "uncertain" ? "結果待確認" : artifactImportLabels[state];
}

/** Imports that still hold a slot: waiting for an image, preparing, pending or writing. */
export function artifactImportActive(value: Pick<ArtifactImport, "state">) {
  return (
    value.state === "awaiting_file" ||
    value.state === "preparing" ||
    value.state === "pending" ||
    value.state === "applying"
  );
}
