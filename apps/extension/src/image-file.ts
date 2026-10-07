import {
  IMAGE_IMPORT_MAX_BYTES,
  IMAGE_IMPORT_MAX_PIXELS,
  IMAGE_IMPORT_MAX_SIDE,
  type ImageMime,
  imageFormatName,
  imagePathProblemText,
  parentFolder,
} from "@kairomes/protocol/image-path";

// Pure checks for an image the local user drops, pastes or chooses in the panel. They mirror
// the daemon's structural checks so the panel can refuse early with one clear sentence; the
// daemon re-checks every byte before anything can be approved. No DOM here (Blob is enough).

export interface ImageHeader {
  mime: ImageMime;
  width: number;
  height: number;
  animated: boolean;
}

const u32be = (bytes: Uint8Array, at: number) =>
  (bytes[at] ?? 0) * 0x1000000 +
  ((bytes[at + 1] ?? 0) << 16) +
  ((bytes[at + 2] ?? 0) << 8) +
  (bytes[at + 3] ?? 0);
const u16be = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u16le = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, at: number) => u16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
const u32le = (bytes: Uint8Array, at: number) =>
  (u24le(bytes, at) | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/** The format named by the leading magic bytes (12 are enough), or undefined. */
export function sniffImageType(bytes: Uint8Array): ImageMime | undefined {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
    return "image/webp";
  return undefined;
}

function pngHeader(bytes: Uint8Array): ImageHeader | undefined {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return undefined;
  let animated = false;
  // An APNG declares acTL before its first IDAT.
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const type = ascii(bytes, offset + 4, 4);
    if (type === "acTL") animated = true;
    if (type === "acTL" || type === "IDAT" || type === "IEND") break;
    offset += 12 + u32be(bytes, offset);
  }
  return {
    mime: "image/png",
    width: u32be(bytes, 16),
    height: u32be(bytes, 20),
    animated,
  };
}

const startOfFrame = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegHeader(bytes: Uint8Array): ImageHeader | undefined {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker) && length >= 7)
      return {
        mime: "image/jpeg",
        height: u16be(bytes, offset + 3),
        width: u16be(bytes, offset + 5),
        animated: false,
      };
    offset += length;
  }
  return undefined;
}

function webpHeader(bytes: Uint8Array): ImageHeader | undefined {
  let animated = false;
  let size: { width: number; height: number } | undefined;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const type = ascii(bytes, offset, 4);
    const length = u32le(bytes, offset + 4);
    const payload = offset + 8;
    if (payload + length > bytes.length) break;
    if (type === "VP8X" && length >= 10) {
      animated ||= ((bytes[payload] ?? 0) & 0x02) !== 0;
      size ??= { width: u24le(bytes, payload + 4) + 1, height: u24le(bytes, payload + 7) + 1 };
    } else if (type === "ANIM" || type === "ANMF") animated = true;
    else if (type === "VP8L" && length >= 5 && bytes[payload] === 0x2f) {
      const [b1, b2, b3, b4] = [1, 2, 3, 4].map((index) => bytes[payload + index] ?? 0) as [
        number,
        number,
        number,
        number,
      ];
      size ??= {
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
      };
    } else if (
      type === "VP8 " &&
      length >= 10 &&
      bytes[payload + 3] === 0x9d &&
      bytes[payload + 4] === 0x01 &&
      bytes[payload + 5] === 0x2a
    )
      size ??= {
        width: u16le(bytes, payload + 6) & 0x3fff,
        height: u16le(bytes, payload + 8) & 0x3fff,
      };
    offset = payload + length + (length % 2);
  }
  return size ? { mime: "image/webp", ...size, animated } : undefined;
}

/** Format and pixel size from the container header (not a decode), or undefined. */
export function imageHeader(bytes: Uint8Array): ImageHeader | undefined {
  const mime = sniffImageType(bytes);
  if (mime === "image/png") return pngHeader(bytes);
  if (mime === "image/jpeg") return jpegHeader(bytes);
  if (mime === "image/webp") return webpHeader(bytes);
  return undefined;
}

/** Codes match the daemon's, so one message map covers local and server refusals. */
export type ImageProblem =
  | "EMPTY_IMAGE"
  | "ARTIFACT_TOO_LARGE"
  | "IMPORT_NOT_IMAGE"
  | "INVALID_IMAGE"
  | "UNSAFE_IMAGE_DIMENSIONS"
  | "ANIMATED_IMAGE_UNSUPPORTED";

export type ImageCheck = { ok: true; header: ImageHeader } | { ok: false; code: ImageProblem };

/** The same structural bounds the daemon enforces: 25 MiB, 16 MP, 16,384 px, still image. */
export function checkImageBytes(bytes: Uint8Array): ImageCheck {
  if (!bytes.length) return { ok: false, code: "EMPTY_IMAGE" };
  if (bytes.length > IMAGE_IMPORT_MAX_BYTES) return { ok: false, code: "ARTIFACT_TOO_LARGE" };
  if (!sniffImageType(bytes)) return { ok: false, code: "IMPORT_NOT_IMAGE" };
  const header = imageHeader(bytes);
  if (!header || header.width <= 0 || header.height <= 0)
    return { ok: false, code: "INVALID_IMAGE" };
  if (
    header.width > IMAGE_IMPORT_MAX_SIDE ||
    header.height > IMAGE_IMPORT_MAX_SIDE ||
    header.width * header.height > IMAGE_IMPORT_MAX_PIXELS
  )
    return { ok: false, code: "UNSAFE_IMAGE_DIMENSIONS" };
  if (header.animated) return { ok: false, code: "ANIMATED_IMAGE_UNSUPPORTED" };
  return { ok: true, header };
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array) {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  // A private copy: digest() must not observe a buffer someone else can still change.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(view));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** An image the user chose, checked and hashed; `blob` holds exactly the hashed bytes. */
export interface PreparedImage {
  blob: Blob;
  name: string;
  mime: ImageMime;
  size: number;
  width: number;
  height: number;
  sha256: string;
}

export type PrepareResult = { ok: true; image: PreparedImage } | { ok: false; code: ImageProblem };

/**
 * Reads a dropped, pasted or chosen file once, checks it, and hashes those same bytes. The
 * declared file type is ignored: the bytes name the format, as the daemon also decides.
 */
export async function prepareImage(file: Blob & { name?: string }): Promise<PrepareResult> {
  if (file.size > IMAGE_IMPORT_MAX_BYTES) return { ok: false, code: "ARTIFACT_TOO_LARGE" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = checkImageBytes(bytes);
  if (!checked.ok) return checked;
  const { mime, width, height } = checked.header;
  return {
    ok: true,
    image: {
      blob: new Blob([bytes], { type: mime }),
      name: typeof file.name === "string" ? file.name : "",
      mime,
      size: bytes.length,
      width,
      height,
      sha256: await sha256Hex(bytes),
    },
  };
}

/** `512 B`, `7.9 KiB`, `1.2 MiB` (binary units, as the 25 MiB limit is stated). */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** `PNG · 1200 × 800 · 245.1 KiB`: format, pixel size and file size from verified values. */
export function imageSummary(value: {
  mime: ImageMime;
  width: number;
  height: number;
  size: number;
}) {
  return `${imageFormatName(value.mime)} · ${value.width} × ${value.height} · ${formatBytes(value.size)}`;
}

/** Where an import error belongs in a form: the target path, the image, or the whole step. */
export type ImportErrorField = "path" | "image" | "general";

const pathCodes = new Set([
  "PARENT_NOT_FOUND",
  "FILE_EXISTS",
  "INVALID_PATH",
  "PRIVATE_PATH",
  "LINK_BLOCKED",
  "UNSUPPORTED_ARTIFACT_EXTENSION",
  "ARTIFACT_EXTENSION_MISMATCH",
  "NOT_DIRECTORY",
  "OUTSIDE_WORKSPACE",
  "WORKSPACE_CHANGED",
]);
const imageCodes = new Set([
  "EMPTY_IMAGE",
  "ARTIFACT_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "IMPORT_NOT_IMAGE",
  "INVALID_IMAGE",
  "UNSAFE_IMAGE_DIMENSIONS",
  "ANIMATED_IMAGE_UNSUPPORTED",
  "UPLOAD_INTERRUPTED",
  "UPLOAD_TIMEOUT",
  "DECODE_FAILED",
]);

export function importErrorField(code: string): ImportErrorField {
  if (pathCodes.has(code)) return "path";
  if (imageCodes.has(code)) return "image";
  return "general";
}

/**
 * One fixed sentence per error code (spec §7): daemon messages, HTTP bodies and URLs are never
 * shown. `path` and `mime` only fill in values the user already sees (the target and format).
 */
export function importErrorText(code: string, context: { path?: string; mime?: ImageMime } = {}) {
  const folder = context.path === undefined ? undefined : parentFolder(context.path);
  switch (code) {
    case "PARENT_NOT_FOUND":
      return folder
        ? `找不到資料夾「${folder}」；匯入不會自動建立資料夾，請先建立或改用既有資料夾。`
        : "找不到儲存資料夾；請改用既有資料夾。";
    case "FILE_EXISTS":
      return "這個位置已有同名檔案；匯入只建立新檔，請換一個檔名。";
    case "INVALID_PATH":
    case "PRIVATE_PATH":
    case "UNSUPPORTED_ARTIFACT_EXTENSION":
    case "ARTIFACT_EXTENSION_MISMATCH":
      return imagePathProblemText(code, context.mime);
    case "LINK_BLOCKED":
      return "路徑經過符號連結或 junction，不能匯入。";
    case "NOT_DIRECTORY":
    case "OUTSIDE_WORKSPACE":
    case "WORKSPACE_CHANGED":
      return "儲存位置已無效，請改用專案內的既有資料夾。";
    case "EMPTY_IMAGE":
      return "這個檔案是空的。";
    case "ARTIFACT_TOO_LARGE":
      return "圖片超過 25 MiB 上限。";
    case "UNSUPPORTED_MEDIA_TYPE":
    case "IMPORT_NOT_IMAGE":
      return "只能匯入 PNG、JPEG 或 WebP 圖片。";
    case "INVALID_IMAGE":
    case "DECODE_FAILED":
      return "無法讀取這張圖片，檔案可能不完整。";
    case "UNSAFE_IMAGE_DIMENSIONS":
      return "圖片太大：每邊最多 16,384 px，總像素最多 16 MP。";
    case "ANIMATED_IMAGE_UNSUPPORTED":
      return "不支援動畫圖片，請改用靜態圖片。";
    case "UPLOAD_INTERRUPTED":
      return "上傳中斷，請再試一次。";
    case "UPLOAD_TIMEOUT":
      return "上傳逾時，請再試一次。";
    case "IMPORT_EXPIRED":
    case "APPROVAL_EXPIRED":
      return "這筆匯入已到期。";
    case "IMPORT_CANCELLED":
      return "這筆匯入已取消。";
    case "IMPORT_DENIED":
      return "這筆匯入已拒絕。";
    case "IMPORT_NOT_AWAITING_FILE":
      return "這筆匯入已收到圖片，請核對預覽。";
    case "ARTIFACT_IMPORT_NOT_FOUND":
      return "找不到這筆匯入，可能已經結束。";
    case "ARTIFACT_IMPORT_LIMIT":
      return "進行中的圖片匯入太多，請先處理需確認中的匯入。";
    case "REQUEST_ID_REUSED":
      return "匯入內容已變更，請再按一次「匯入」。";
    case "PANEL_UNAUTHORIZED":
      return "配對已失效。";
    case "IMPORT_PREVIEW_REQUIRED":
      return "核准前須先在這裡載入並核對圖片預覽。";
    case "APPROVAL_MISMATCH":
      return "請求已變更；請重新審閱。";
    case "UNKNOWN":
      return "結果待確認。";
    case "OFFLINE":
      return "本機工作台恢復連線後再試。";
    case "UPLOAD_IN_PROGRESS":
      return "上一張圖片還在上傳。";
    default:
      return "匯入未被接受。";
  }
}
