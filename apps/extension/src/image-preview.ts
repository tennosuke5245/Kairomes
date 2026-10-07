import type { ArtifactImportApproval } from "@kairomes/protocol";
import type { ImageHeader } from "./image-file.ts";

// Preview gating for a pending image import. 匯入圖片 is enabled only after this panel fetched
// the pending bytes itself, hashed them to the import's full SHA-256, matched size, format and
// pixel size, and decoded them. The daemon separately refuses an approve from a panel that did
// not read the bytes (IMPORT_PREVIEW_REQUIRED); both must hold.

type PreviewItem = Pick<
  ArtifactImportApproval,
  "id" | "fingerprint" | "state" | "version" | "byte_size" | "mime_type" | "width" | "height"
>;

/** Identity of the exact content a preview shows. Any new fingerprint or bytes is a new key. */
export function previewKey(item: PreviewItem) {
  return JSON.stringify([
    item.id,
    item.fingerprint,
    item.version,
    item.byte_size,
    item.mime_type,
    item.width,
    item.height,
  ]);
}

export type PreviewProblem =
  | "network"
  | "gone"
  | "size"
  | "type"
  | "hash"
  | "dimensions"
  | "decode"
  | "unauthorized";

export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string }
  | { status: "failed"; key: string; problem: PreviewProblem };

/** True only when the verified preview belongs to this exact pending content. */
export function previewReady(state: PreviewState, item: PreviewItem) {
  return (
    item.state === "pending" &&
    item.version !== null &&
    state.status === "ready" &&
    state.key === previewKey(item)
  );
}

/** A preview should be (re)loaded: pending bytes exist and no load for them is done or running. */
export function previewNeeded(state: PreviewState, item: PreviewItem) {
  if (item.state !== "pending" || item.version === null) return false;
  if (state.status === "idle") return true;
  return state.key !== previewKey(item);
}

export interface ReceivedPreview {
  size: number;
  /** Response Content-Type. */
  type: string;
  sha256: string;
  /** Header read from the received bytes (undefined when unreadable). */
  header: ImageHeader | undefined;
}

/**
 * Compares the received bytes with the pending import, field by field, in the order a problem
 * is most useful to report. EXIF orientation may swap width and height on decode, so the
 * header (not the decoded bitmap) is compared, and the decode itself is checked separately.
 */
export function verifyPreview(item: PreviewItem, received: ReceivedPreview) {
  if (
    item.version === null ||
    item.byte_size === null ||
    item.mime_type === null ||
    item.width === null ||
    item.height === null
  )
    return "gone" satisfies PreviewProblem;
  if (received.size !== item.byte_size) return "size" satisfies PreviewProblem;
  const type = received.type.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== item.mime_type || received.header?.mime !== item.mime_type)
    return "type" satisfies PreviewProblem;
  if (received.sha256 !== item.version) return "hash" satisfies PreviewProblem;
  if (received.header.width !== item.width || received.header.height !== item.height)
    return "dimensions" satisfies PreviewProblem;
  return undefined;
}

/** Decoded size matches the verified header, allowing an EXIF quarter turn. */
export function decodedMatches(
  item: Pick<PreviewItem, "width" | "height">,
  decoded: { width: number; height: number },
) {
  return (
    (decoded.width === item.width && decoded.height === item.height) ||
    (decoded.width === item.height && decoded.height === item.width)
  );
}

/** One status sentence for a failed preview; 匯入圖片 stays disabled in every case. */
export function previewProblemText(problem: PreviewProblem) {
  switch (problem) {
    case "network":
      return "無法載入預覽，請重新載入。";
    case "gone":
      return "這張圖片已無法預覽，可能已到期或已處理。";
    case "unauthorized":
      return "配對已失效，無法載入預覽。";
    case "decode":
      return "瀏覽器無法顯示這張圖片，因此不能匯入。";
    default:
      return "收到的圖片與待審內容不符，因此不能匯入。";
  }
}

/** Display size for decoding: at most `max` px on the longer side, never upscaled. */
export function previewScale(width: number, height: number, max = 2048) {
  const longest = Math.max(width, height);
  if (longest <= max) return undefined;
  return width >= height ? { resizeWidth: max } : { resizeHeight: max };
}
