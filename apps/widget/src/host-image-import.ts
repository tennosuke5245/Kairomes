import { OPENAI_FILE_REFERENCE_LIMITS } from "@kairomes/protocol";
import { type ImageMime, imageMimeForPath, isImageMime } from "@kairomes/protocol/image-path";

// Optional ChatGPT host helper: when the host page exposes window.openai.selectFiles and
// getFileDownloadUrl, the widget can hand a chosen conversation image to image_import_request,
// exactly as the model would. It decides nothing: the image is verified and approved only in
// the Kairomes side panel. The short-lived download URL is passed straight into the tool call
// and is never rendered, stored in state or logged; neither is the file ID.

export interface HostFileApi {
  selectFiles(options: unknown): Promise<unknown>;
  getFileDownloadUrl(input: { fileId: string }): Promise<unknown>;
}

/** The host's file helpers, or undefined when either is missing (the action is then hidden). */
export function hostFileApi(scope: unknown): HostFileApi | undefined {
  const openai =
    scope && typeof scope === "object" ? (scope as { openai?: unknown }).openai : undefined;
  if (!openai || typeof openai !== "object") return undefined;
  const { selectFiles, getFileDownloadUrl } = openai as Record<string, unknown>;
  if (typeof selectFiles !== "function" || typeof getFileDownloadUrl !== "function")
    return undefined;
  return {
    selectFiles: (options) => Promise.resolve(selectFiles.call(openai, options)),
    getFileDownloadUrl: (input) => Promise.resolve(getFileDownloadUrl.call(openai, input)),
  };
}

export interface HostImage {
  fileId: string;
  /** Display name from the host (untrusted text). */
  fileName?: string;
  mimeType?: ImageMime;
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;

function field(entry: Record<string, unknown>, ...names: string[]) {
  for (const name of names) if (entry[name] !== undefined) return entry[name];
  return undefined;
}

/**
 * A host file name for display: untrusted text shown as is, except characters that render as
 * nothing or reorder text (bidi overrides, zero-width, controls), which become visible escapes.
 */
export function visibleFileName(name: string) {
  return name.replace(
    /[\p{Cc}\p{Cf}\u2028\u2029]/gu,
    (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

/** The first file of a selection, whatever envelope the host used; undefined if none. */
export function selectedImage(value: unknown): HostImage | undefined {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { files?: unknown }).files)
      ? (value as { files: unknown[] }).files
      : value && typeof value === "object"
        ? [value]
        : [];
  const entry = list[0];
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  const fileId = text(
    field(record, "fileId", "file_id", "id"),
    OPENAI_FILE_REFERENCE_LIMITS.file_id,
  );
  if (!fileId) return undefined;
  const fileName = text(
    field(record, "fileName", "file_name", "name"),
    OPENAI_FILE_REFERENCE_LIMITS.file_name,
  );
  const mime = field(record, "mimeType", "mime_type", "type");
  return {
    fileId,
    ...(fileName ? { fileName } : {}),
    ...(isImageMime(mime) ? { mimeType: mime } : {}),
  };
}

/** An https download URL from the host's answer, or undefined. Never shown anywhere. */
export function downloadUrlOf(value: unknown) {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? field(value as Record<string, unknown>, "downloadUrl", "download_url", "url")
        : undefined;
  const url = text(raw, OPENAI_FILE_REFERENCE_LIMITS.download_url);
  if (!url) return undefined;
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The format a chosen file claims, from its MIME type or else its name. */
export function hostImageMime(image: HostImage): ImageMime | undefined {
  return image.mimeType ?? (image.fileName ? imageMimeForPath(image.fileName) : undefined);
}

export const HOST_IMPORT_SUMMARY = "從 ChatGPT 工作台選擇的圖片";

/** Arguments of image_import_request; the same request ID is reused for a retry. */
export function hostImportArguments(input: {
  workspaceId: string;
  path: string;
  requestId: string;
  image: HostImage;
  downloadUrl: string;
}) {
  return {
    workspace_id: input.workspaceId,
    request_id: input.requestId,
    path: input.path,
    summary: HOST_IMPORT_SUMMARY,
    file: {
      download_url: input.downloadUrl,
      file_id: input.image.fileId,
      ...(input.image.mimeType ? { mime_type: input.image.mimeType } : {}),
      ...(input.image.fileName ? { file_name: input.image.fileName } : {}),
    },
  };
}
