import type { FileResult, Snapshot } from "@kairomes/protocol";

// Pure helpers for the shared file browser and viewer (C4, C5). Paths are workspace-relative
// with forward slashes; nothing here touches the DOM or storage.

/** Image types the workbench previews through artifact_preview instead of file_read. */
const IMAGE_PATH = /\.(?:png|jpe?g|webp)$/i;

export function isImagePath(path: string) {
  return IMAGE_PATH.test(path);
}

/** Default and maximum workspace_snapshot page (LIMITS.directoryEntries). */
export const BROWSE_LIMIT = 200;

export interface Crumb {
  name: string;
  path: string;
}

/** Breadcrumb segments below the project root; the root itself is the House button. */
export function pathCrumbs(path: string): Crumb[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

/** Splits a relative path into a directory (meta) and the file name (shown first). */
export function splitPath(path: string) {
  const slash = path.lastIndexOf("/");
  return { directory: slash < 0 ? "" : path.slice(0, slash), name: path.slice(slash + 1) };
}

const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

type Entry = Snapshot["entries"][number];

/** Client-side filter over the loaded folder: case-insensitive name match, folders first. */
export function filterEntries(entries: readonly Entry[], query: string): Entry[] {
  const needle = fold(query.trim());
  const matching = needle ? entries.filter((entry) => fold(entry.name).includes(needle)) : entries;
  return [...matching].sort(
    (a, b) => Number(b.kind === "directory") - Number(a.kind === "directory"),
  );
}

/** Below this many entries the filter field would only add noise. */
export const FILTER_MIN_ENTRIES = 12;

export interface FileLine {
  number: number;
  text: string;
  focus: boolean;
}

/** One (number, code) row per line of the loaded page; a final newline adds no empty row. */
export function fileLines(file: Pick<FileResult, "content" | "start_line">, focusLine?: number) {
  const rows = file.content.split("\n");
  if (rows.length > 1 && rows.at(-1) === "") rows.pop();
  return rows.map(
    (text, index): FileLine => ({
      number: file.start_line + index,
      text: text.endsWith("\r") ? text.slice(0, -1) : text,
      focus: file.start_line + index === focusLine,
    }),
  );
}

type FilePage = Pick<FileResult, "content" | "start_line" | "total_lines" | "next_line">;

/**
 * The daemon splits a file on newlines, so a file that ends with one reports an extra, empty
 * final line in total_lines. Its last page shows that (the content ends with a newline); on
 * earlier pages only a read of that line can tell (finalNewlineFromProbe).
 */
function pageShowsFinalNewline(file: FilePage) {
  return (
    file.next_line === null &&
    file.total_lines > 1 &&
    (file.content.endsWith("\n") || (file.content === "" && file.start_line === file.total_lines))
  );
}

/** Lines in the file; `endsWithNewline` is what a probe of the last line found, if anything. */
export function fileLineCount(file: FilePage, endsWithNewline?: boolean) {
  const newline = endsWithNewline ?? pageShowsFinalNewline(file);
  return newline && file.total_lines > 1 ? file.total_lines - 1 : file.total_lines;
}

/** Where 下一頁 starts; none when all that is left is the final newline's empty line. */
export function nextPageLine(file: FilePage, endsWithNewline?: boolean) {
  if (file.next_line === null) return null;
  return endsWithNewline && file.next_line >= file.total_lines ? null : file.next_line;
}

/** The page shown: first and last line numbers, and whether it is the whole file. */
export function fileRange(file: FilePage, endsWithNewline?: boolean) {
  const count = fileLines(file).length;
  const end = Math.max(file.start_line, file.start_line + count - 1);
  return {
    start: file.start_line,
    end: Math.min(end, Math.max(fileLineCount(file, endsWithNewline), file.start_line)),
    whole: file.start_line <= 1 && nextPageLine(file, endsWithNewline) === null,
  };
}

/** One meta line for the viewer: 148 行 · 第 1–150 行 · 已遮罩金鑰 · 執行時讀取. */
export function fileMeta(
  file: FilePage & Pick<FileResult, "redacted">,
  options: { historical?: boolean; endsWithNewline?: boolean } = {},
) {
  const range = fileRange(file, options.endsWithNewline);
  return [
    `${fileLineCount(file, options.endsWithNewline).toLocaleString("en-US")} 行`,
    range.whole ? undefined : `第 ${range.start}–${range.end} 行`,
    file.redacted ? "已遮罩金鑰" : undefined,
    options.historical ? "執行時讀取" : undefined,
  ].filter((part): part is string => !!part);
}

/** Lines per file_read page (Inputs.file_read max_lines default). */
export const FILE_PAGE = 150;

/** Lines the viewer reads per page: one more than it shows, to see whether the page ends the file. */
export const FILE_READ_LINES = FILE_PAGE + 1;

/**
 * A page read with FILE_READ_LINES, trimmed back to FILE_PAGE lines. When the extra line is
 * the file's final empty line (the file ends with a newline), the page is the last one, so
 * the viewer never offers 下一頁 to an empty page.
 */
export function trimLookahead(file: FileResult, page = FILE_PAGE): FileResult {
  const rows = file.content.split("\n");
  if (rows.length <= page) return file;
  if (file.next_line === null && rows.length === page + 1 && rows[page] === "") return file;
  return {
    ...file,
    content: rows.slice(0, page).join("\n"),
    next_line: file.start_line + page,
    truncated: true,
  };
}

/**
 * A read of a multi-page file's last reported line (start_line = total_lines, max_lines 1):
 * the line is empty exactly when the file ends with a newline. Undefined when the probe read
 * another version of the file.
 */
export function finalNewlineFromProbe(
  page: Pick<FileResult, "version" | "total_lines">,
  probe: Pick<FileResult, "version" | "total_lines" | "start_line" | "content">,
) {
  if (
    probe.version !== page.version ||
    probe.total_lines !== page.total_lines ||
    probe.start_line !== page.total_lines
  )
    return undefined;
  return probe.content === "";
}

/** Start line for a search hit: a few lines of context above the match. */
export function hitStartLine(line: number) {
  return Math.max(1, line - 5);
}

/** 980 B, 12.4 KiB, 3.1 MiB: the shared formatter, so the side panel reads the same size. */
export { formatBytes } from "@kairomes/protocol/ui-state";

/** Image size as 1280 × 720: pixel counts carry no thousands separator. */
export function formatDimensions(width: number, height: number) {
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/** UTF-8 size of text, for output and content sizes. */
export function utf8Bytes(text: string) {
  return new TextEncoder().encode(text).length;
}
