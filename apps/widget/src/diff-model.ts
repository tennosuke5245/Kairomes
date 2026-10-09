import {
  type DiffFile,
  type DiffFileStatus,
  type DiffLine,
  type ParsedDiff,
  parseUnifiedDiff,
} from "@kairomes/protocol/diff-lines";

// One diff presentation for the overview and the file-change detail (design spec §4 Diff):
// per-file sections, +N −M, old and new gutters, hunk labels. Lines are budgeted so a large
// change stays responsive; every file still shows its counts and its first rows.

export const DIFF_STATUS: Record<DiffFileStatus, { label: string; tone?: "warning" }> = {
  modified: { label: "修改" },
  added: { label: "新檔案" },
  deleted: { label: "刪除", tone: "warning" },
  renamed: { label: "重新命名" },
};

/**
 * The widget's parse of a change diff: the shared parser, which also drops the final newline
 * row of a review hunk, so the workbench and the side panel show the same rows and counts.
 */
export function parseChangeDiff(diff: string, truncated: boolean) {
  return parseUnifiedDiff(diff, { truncated });
}

/** Rows per file kept even when the shared budget is spent. */
export const MIN_ROWS_PER_FILE = 6;

export interface DiffSection {
  key: string;
  file: DiffFile;
  lines: DiffLine[];
  /** Rows not rendered until 顯示其餘 N 行. */
  hidden: number;
}

export function diffSections(
  parsed: ParsedDiff,
  budget: number,
  expanded: ReadonlySet<string> = new Set(),
): DiffSection[] {
  let left = budget;
  return parsed.files.map((file, index) => {
    const key = `${index}:${file.path}`;
    const all = file.lines;
    const take = expanded.has(key)
      ? all.length
      : Math.min(all.length, Math.max(left, MIN_ROWS_PER_FILE));
    left = Math.max(0, left - take);
    return { key, file, lines: all.slice(0, take), hidden: all.length - take };
  });
}

/** False for exact replacements: they carry no line numbers, so no gutter is reserved. */
export function diffNumbered(file: Pick<DiffFile, "lines">) {
  return file.lines.some((line) => line.oldLine !== undefined || line.newLine !== undefined);
}

/** The sign column: content glyphs, not icons. */
export function diffSign(kind: DiffLine["kind"]) {
  return kind === "add" ? "+" : kind === "del" ? "−" : "";
}

/** +12 −3; 至少 +12 −3 when the diff was cut, so later lines were never counted. */
export function diffCounts(diff: { additions: number; deletions: number; truncated?: boolean }) {
  return `${diff.truncated ? "至少 " : ""}+${diff.additions} −${diff.deletions}`;
}

/**
 * 2 個檔案 · +12 −3. A cut diff may be missing whole files, so the change's own file count
 * is used when it is known, and the line counts read 至少.
 */
export function diffTotals(parsed: ParsedDiff, fileCount?: number) {
  const files = parsed.truncated
    ? Math.max(fileCount ?? 0, parsed.files.length)
    : parsed.files.length;
  return `${files} 個檔案 · ${diffCounts(parsed)}`;
}
