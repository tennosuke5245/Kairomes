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

const REVIEW_HUNK = /^@@ (?:exact replacement \d+(?: · all matches)?|create file|delete file) @@$/;

/**
 * workspace-core review hunks (exact replacement, create, delete) prefix every element of
 * text.split("\n"), so a text that ends in a newline adds one final bare "-" or "+" row. That
 * row is the newline itself, not an empty line: it is dropped and the counts follow. The last
 * row of a cut diff is kept, since its text may continue past the cut. (Focused `@@ N @@`
 * hunks share the final newline as context, so they never carry such a row.)
 */
export function withoutReviewNewlines(parsed: ParsedDiff): ParsedDiff {
  let droppedAdditions = 0;
  let droppedDeletions = 0;
  const files = parsed.files.map((file) => {
    let review = false;
    const lines = file.lines.filter((line, index, all) => {
      if (line.kind === "hunk") {
        review = REVIEW_HUNK.test(line.text);
        return true;
      }
      return (
        !review ||
        (line.kind !== "add" && line.kind !== "del") ||
        line.text !== "" ||
        all[index + 1]?.kind === line.kind ||
        (file.truncated && index === all.length - 1)
      );
    });
    if (lines.length === file.lines.length) return file;
    const count = (rows: readonly DiffLine[], kind: DiffLine["kind"]) =>
      rows.filter((row) => row.kind === kind).length;
    const additions = file.additions - (count(file.lines, "add") - count(lines, "add"));
    const deletions = file.deletions - (count(file.lines, "del") - count(lines, "del"));
    droppedAdditions += file.additions - additions;
    droppedDeletions += file.deletions - deletions;
    return { ...file, lines, additions, deletions };
  });
  return {
    ...parsed,
    files,
    additions: parsed.additions - droppedAdditions,
    deletions: parsed.deletions - droppedDeletions,
  };
}

/** The widget's parse of a change diff: the shared parser, minus review newline rows. */
export function parseChangeDiff(diff: string, truncated: boolean) {
  return withoutReviewNewlines(parseUnifiedDiff(diff, { truncated }));
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
