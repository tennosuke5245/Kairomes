// Target-path rules for an image import, shared by the side panel and the widget. Pure data
// and string checks: no zod, no DOM. The daemon stays authoritative (workspace-core paths.ts and
// artifact-imports.ts); these mirror its rules so a surface can explain a problem before it
// sends anything. Error codes are the daemon's own.

import { formatBytes } from "./ui-state.ts";

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

/** Same bounds as LIMITS.artifactBytes and LIMITS.importPixels (checked in a test). */
export const IMAGE_IMPORT_MAX_BYTES = 25 * 1024 * 1024;
export const IMAGE_IMPORT_MAX_PIXELS = 16 * 1024 * 1024;
export const IMAGE_IMPORT_MAX_SIDE = 16_384;
export const IMAGE_IMPORT_PATH_MAX = 1024;

const extensions: Record<ImageMime, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
};
const formatNames: Record<ImageMime, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

export function isImageMime(value: unknown): value is ImageMime {
  return typeof value === "string" && Object.hasOwn(extensions, value);
}

/** `PNG`, `JPEG`, `WebP`. */
export const imageFormatName = (mime: ImageMime) => formatNames[mime];

/** The import formats by name (`WebP`); any other image type by its upper-cased subtype (`GIF`). */
export function imageTypeName(mime: string) {
  return isImageMime(mime) ? imageFormatName(mime) : mime.replace(/^image\//, "").toUpperCase();
}

/**
 * `1280 × 720 · PNG · 184 KiB`: one caption order for every surface, the size only when it is
 * known. Pixel counts carry no thousands separator.
 */
export function imageCaption(value: {
  width: number;
  height: number;
  mime: string;
  bytes?: number;
}) {
  return [
    `${Math.round(value.width)} × ${Math.round(value.height)}`,
    imageTypeName(value.mime),
    ...(value.bytes ? [formatBytes(value.bytes)] : []),
  ].join(" · ");
}

/** The preferred extension for a format: `.png`, `.jpg`, `.webp`. */
export const imageExtension = (mime: ImageMime) => extensions[mime][0] as string;

/** `path.posix.extname`, lower-cased: the last dot of the last segment, never a leading one. */
export function pathExtension(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** The format a target path names by its extension, if it is an importable image. */
export function imageMimeForPath(path: string): ImageMime | undefined {
  const extension = pathExtension(path);
  return (Object.keys(extensions) as ImageMime[]).find((mime) =>
    extensions[mime].includes(extension),
  );
}

// Same lists as packages/workspace-core/src/paths.ts.
const deniedDirectories = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".config",
  ".kairomes",
  "node_modules",
  ".next",
  "dist",
  "coverage",
]);
const deniedFiles = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
const reservedName = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/** A path segment the local policy never exposes (.git, node_modules, .env*, keys…). */
export function isPrivateSegment(name: string) {
  const lower = name.toLowerCase();
  return (
    deniedDirectories.has(lower) ||
    deniedFiles.has(lower) ||
    lower.startsWith(".kairomes-") ||
    lower.startsWith(".env") ||
    /\.(pem|key|p12|pfx|sqlite|sqlite3|db)(-wal|-shm)?$/i.test(lower)
  );
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (
      code < 32 ||
      code === 127 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}

export type ImagePathProblem =
  | "INVALID_PATH"
  | "PRIVATE_PATH"
  | "UNSUPPORTED_ARTIFACT_EXTENSION"
  | "ARTIFACT_EXTENSION_MISMATCH";

/**
 * The first rule a target path breaks, in the daemon's order: image extension, then the shared
 * relative-path rules, then private names. With `mime`, the extension must also name that
 * format. Only the daemon can tell whether the parent folder exists or the file is new.
 */
export function imagePathProblem(path: string, mime?: ImageMime): ImagePathProblem | undefined {
  if (!path || path.length > IMAGE_IMPORT_PATH_MAX) return "INVALID_PATH";
  const named = imageMimeForPath(path);
  if (!named) return "UNSUPPORTED_ARTIFACT_EXTENSION";
  if (path.startsWith("/") || /[\\:]/u.test(path) || hasControlCharacters(path))
    return "INVALID_PATH";
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        !part || part === "." || part === ".." || /[. ]$/.test(part) || reservedName.test(part),
    )
  )
    return "INVALID_PATH";
  if (parts.some(isPrivateSegment)) return "PRIVATE_PATH";
  if (mime && named !== mime) return "ARTIFACT_EXTENSION_MISMATCH";
  return undefined;
}

/** The folder part of a relative path (`design/placeholders`), or "" for the project root. */
export function parentFolder(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

const genericStems = new Set(["image", "images", "blob", "untitled", "download", "file", "圖片"]);

/**
 * A file-name stem from an untrusted display name: no folders, no extension, no control,
 * reordering or Windows-reserved characters, no private or reserved names, at most 80
 * characters. Undefined when nothing meaningful is left (`image.png` from a paste).
 */
export function sanitizeImageStem(name: string) {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  const cleaned = (dot > 0 ? base.slice(0, dot) : base)
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
    .replace(/[<>:"/\\|?*#%&{}$!'`=@+,;[\]^~]/g, "-")
    .replace(/\s+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+/, "");
  const stem = Array.from(cleaned)
    .slice(0, 80)
    .join("")
    .replace(/[-. ]+$/, "");
  if (
    !stem ||
    genericStems.has(stem.toLowerCase()) ||
    isPrivateSegment(stem) ||
    reservedName.test(stem)
  )
    return undefined;
  return stem;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `image-20261007-143205` in local time: a fallback name that rarely collides. */
export function timestampStem(now: number) {
  const date = new Date(now);
  return `image-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Default target for a new image: `<folder>/<sanitized name><extension of its real format>`,
 * e.g. `images/cover.png`. Always passes {@link imagePathProblem} for that format.
 */
export function suggestImagePath(input: {
  name: string;
  mime: ImageMime;
  now: number;
  folder?: string;
}) {
  const folder = (input.folder ?? "images").replace(/^\/+|\/+$/g, "");
  const extension = imageExtension(input.mime);
  const join = (stem: string) => (folder ? `${folder}/${stem}${extension}` : `${stem}${extension}`);
  const stem = sanitizeImageStem(input.name);
  const named = stem ? join(stem) : undefined;
  if (named && !imagePathProblem(named, input.mime)) return named;
  const fallback = join(timestampStem(input.now));
  return imagePathProblem(fallback, input.mime)
    ? `${timestampStem(input.now)}${extension}`
    : fallback;
}

/** Same name with the extension of another format: `cover.png` → `cover.jpg`. */
export function withImageExtension(path: string, mime: ImageMime) {
  const extension = pathExtension(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  return `${stem}${imageExtension(mime)}`;
}

/** One sentence per path rule, shared by the side panel and the widget (zh-TW). */
export function imagePathProblemText(problem: ImagePathProblem, mime?: ImageMime) {
  switch (problem) {
    case "INVALID_PATH":
      return "請輸入專案內的相對路徑，以 / 分隔，例如 images/cover.png。";
    case "PRIVATE_PATH":
      return "這個位置受保護（例如 .git、node_modules 或 .env），不能存放匯入的圖片。";
    case "UNSUPPORTED_ARTIFACT_EXTENSION":
      return "檔名須以 .png、.jpg、.jpeg 或 .webp 結尾。";
    case "ARTIFACT_EXTENSION_MISMATCH":
      return mime
        ? `這張圖片是 ${imageFormatName(mime)}，檔名請用 ${imageExtension(mime)} 結尾。`
        : "副檔名和圖片格式不符。";
  }
}
