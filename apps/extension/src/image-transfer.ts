// Finds the image in a paste or drop. Pure: it only reads the DataTransfer-shaped object it is
// given, so tests pass plain objects. Nothing is uploaded or decoded here.

interface TransferItem {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/** The parts of DataTransfer (drop) and ClipboardData (paste) that are read. */
export interface TransferLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<TransferItem> | null;
  types?: ArrayLike<string> | null;
}

export type TransferContent =
  /** The first image file, plus how many more were offered (only one is imported). */
  | { kind: "image"; file: File; ignored: number }
  /** Files, but none is an image (a PDF, a ZIP…). */
  | { kind: "not-image" }
  /** Only a link or markup: an `<img>` dragged out of a web page carries no bytes. */
  | { kind: "link" }
  | { kind: "none" };

const linkTypes = ["text/uri-list", "text/html", "text/x-moz-url", "downloadurl"];

const isImage = (type: string) => type.toLowerCase().startsWith("image/");

function filesOf(data: TransferLike) {
  const files: File[] = [];
  for (const file of Array.from(data.files ?? [])) files.push(file);
  if (!files.length)
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  return files;
}

/**
 * The image in a paste or drop. A file's declared type only picks candidates; the bytes are
 * checked later. Files without a type (some file managers) still count, so the byte check can
 * accept or refuse them with a precise reason.
 */
export function imageFromTransfer(data: TransferLike | null | undefined): TransferContent {
  if (!data) return { kind: "none" };
  const files = filesOf(data);
  const candidates = files.filter((file) => !file.type || isImage(file.type));
  const [first] = candidates;
  if (first) return { kind: "image", file: first, ignored: files.length - 1 };
  if (files.length) return { kind: "not-image" };
  const types = Array.from(data.types ?? [], (type) => type.toLowerCase());
  return types.some((type) => linkTypes.includes(type)) ? { kind: "link" } : { kind: "none" };
}

export type DragKind = "files" | "link" | "none";

/**
 * What a drag carries while it is still over the panel. During dragover only the types are
 * readable: `Files` means real files; a link or markup alone cannot become an upload.
 */
export function dragKind(types: ArrayLike<string> | null | undefined): DragKind {
  const list = Array.from(types ?? []);
  if (list.includes("Files")) return "files";
  return list.some((type) => linkTypes.includes(type.toLowerCase())) ? "link" : "none";
}

/** True when a paste carries an image file, so a text paste is never intercepted. */
export function pasteHasImage(data: TransferLike | null | undefined) {
  return imageFromTransfer(data).kind === "image";
}

/**
 * The drop effect while dragging over the panel. Files with somewhere to go are copied. A link
 * or markup is also accepted, only so that the drop happens and leaves its lasting instruction
 * (copy the image instead); with `none` the browser would never fire the drop and the
 * instruction would vanish with the overlay. Files with nowhere to go are refused.
 */
export function dropEffectFor(kind: DragKind, hasTarget: boolean): "copy" | "none" {
  if (kind === "link") return "copy";
  return kind === "files" && hasTarget ? "copy" : "none";
}

/**
 * The browser's own name for the image context-menu item, as the zh-TW UI shows it: Chrome
 * says 複製圖片, Edge says 複製影像. Only the label differs; the clipboard content is the same.
 */
export function copyImageMenuLabel(userAgent: string) {
  return /\bEdg\//.test(userAgent) ? "複製影像" : "複製圖片";
}
