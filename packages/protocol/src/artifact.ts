import { z } from "zod";

export const ArtifactMimeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);

export const ArtifactSchema = z.object({
  kind: z.literal("artifact"),
  artifact_id: z.string().regex(/^[a-f0-9]{64}$/),
  workspace_id: z.string().uuid(),
  path: z.string().min(1).max(1024),
  media_kind: z.literal("image"),
  mime_type: ArtifactMimeSchema,
  byte_size: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  modified_at: z.number().int().nonnegative(),
  previewable: z.literal(true),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

const WorkspaceId = z.string().uuid();
const RelativeArtifactPath = z.string().min(1).max(1024);

export const ArtifactInputs = {
  artifact_preview: z
    .object({
      workspace_id: WorkspaceId,
      path: RelativeArtifactPath,
    })
    .strict(),
} as const;

export const ArtifactContentInputSchema = z
  .object({
    workspace_id: WorkspaceId,
    path: RelativeArtifactPath,
    version: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
