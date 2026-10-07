// Pure unified-diff parser shared by the extension approval view and the widget (B2). No DOM:
// callers render `text` through textContent or React text nodes only.
//
// It understands standard `git diff` / unified output and the review diffs that
// @kairomes/workspace-core produces for file changes:
//   --- a/<path> / +++ b/<path>, --- /dev/null, +++ /dev/null
//   @@ exact replacement N @@, @@ exact replacement N · all matches @@  (no line numbers)
//   @@ create file @@, @@ delete file @@                              (whole file)
//   @@ N @@                                                           (first changed line)
// Files are joined with a blank line. A truncated diff stays marked as truncated so the
// caller can keep it non-approvable.
//
// Review hunks prefix every element of text.split("\n"), so a text that ends in a newline
// carries one final bare "+" or "-" row: the newline itself, not an empty line. The parser
// drops that row (see withoutReviewNewlines) so every surface counts a file of N lines as +N.

export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content without the +/-/space prefix; the raw header for hunk and meta rows. */
  text: string;
  /** Short zh-TW label for hunk rows, e.g. 第 12 行起, 替換 1, 新檔案. */
  label?: string;
  oldLine?: number;
  newLine?: number;
}

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";

export interface DiffFile {
  /** Workspace-relative path without the a/ or b/ prefix; "" when the input had no header. */
  path: string;
  previousPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** True for the last file of a truncated diff: its lines are incomplete. */
  truncated: boolean;
  lines: DiffLine[];
}

export interface ParsedDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** Passed through from the source (`diff_truncated`); a truncated diff is not approvable. */
  truncated: boolean;
}

type Hunk = {
  /** Standard hunks carry line counts; workspace-core review hunks run until the next header. */
  counted: boolean;
  oldLeft: number;
  newLeft: number;
  old?: number;
  new?: number;
};

const standardHunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const focusedHunk = /^@@ (\d+) @@$/;
const replacementHunk = /^@@ exact replacement (\d+)( · all matches)? @@$/;
const gitHeader = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/;

/** Splits a diff path for display: the directory (meta colour) and the file name (strong). */
export function diffPathParts(path: string) {
  const slash = path.lastIndexOf("/");
  return { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

function unquote(value: string) {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const body = value.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8 };
  for (let index = 0; index < body.length; index++) {
    const character = body[index] ?? "";
    if (character !== "\\") {
      bytes.push(...encoder.encode(character));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const next = body[index + 1] ?? "";
    bytes.push(escapes[next] ?? next.charCodeAt(0));
    index++;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Path from a ---/+++ line; null for /dev/null. Drops a trailing tab-separated timestamp. */
function headerPath(raw: string): string | null {
  const value = unquote(raw.split("\t")[0] ?? "");
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

function hunkLabel(row: string) {
  const replacement = replacementHunk.exec(row);
  if (replacement) return `替換 ${replacement[1]}${replacement[2] ? " · 全部相符處" : ""}`;
  if (row === "@@ create file @@") return "新檔案";
  if (row === "@@ delete file @@") return "刪除檔案";
  const focused = focusedHunk.exec(row);
  if (focused) return `第 ${focused[1]} 行起`;
  const standard = standardHunk.exec(row);
  if (standard) return `第 ${Number(standard[3]) || Number(standard[1]) || 1} 行起`;
  return undefined;
}

const reviewHunk = /^@@ (?:exact replacement \d+(?: · all matches)?|create file|delete file) @@$/;

/**
 * Drops the final newline row of each workspace-core review hunk and returns how many add and
 * del rows it removed. A whole-file hunk (create, delete) ends with the file's last newline. An
 * exact replacement drops its two newline rows only when both the old and the new text end in
 * a newline; a replacement that adds or removes a newline keeps them, so the change stays
 * visible. The last row of a cut diff is kept, since its text may continue past the cut.
 * Focused `@@ N @@` and standard hunks share the final newline as context and are left alone.
 * The legacy approval page (approval-page-script.ts) applies the same rule.
 */
function withoutReviewNewlines(file: DiffFile) {
  const drop = new Set<number>();
  const lines = file.lines;
  const bare = (index: number) =>
    index >= 0 && lines[index]?.text === "" && !(file.truncated && index === lines.length - 1);
  for (let start = 0; start < lines.length; start++) {
    const header = lines[start];
    if (header?.kind !== "hunk" || !reviewHunk.test(header.text)) continue;
    let end = start + 1;
    while (end < lines.length && lines[end]?.kind !== "hunk") end++;
    let lastAdd = -1;
    let lastDel = -1;
    for (let index = start + 1; index < end; index++) {
      if (lines[index]?.kind === "add") lastAdd = index;
      else if (lines[index]?.kind === "del") lastDel = index;
    }
    if (header.text === "@@ create file @@") {
      if (lastAdd === end - 1 && bare(lastAdd)) drop.add(lastAdd);
    } else if (header.text === "@@ delete file @@") {
      if (lastDel === end - 1 && bare(lastDel)) drop.add(lastDel);
    } else if (bare(lastDel) && bare(lastAdd)) {
      drop.add(lastDel);
      drop.add(lastAdd);
    }
    start = end - 1;
  }
  if (!drop.size) return;
  for (const index of drop) {
    if (lines[index]?.kind === "add") file.additions--;
    else file.deletions--;
  }
  file.lines = lines.filter((_, index) => !drop.has(index));
}

/**
 * Parses unified diff text into per-file line lists with old/new line numbers where the
 * format provides them. Unrecognised input falls back to one section with an empty path.
 */
export function parseUnifiedDiff(text: string, options: { truncated?: boolean } = {}): ParsedDiff {
  const rows = text.split(/\r?\n/);
  if (rows.at(-1) === "") rows.pop();
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let fileHasHunk = false;
  let hunk: Hunk | undefined;
  let binaryPatch = false;
  let previousBlank = true;

  const startFile = (path = "", previousPath?: string) => {
    file = {
      path,
      ...(previousPath !== undefined && previousPath !== path ? { previousPath } : {}),
      status: previousPath !== undefined && previousPath !== path ? "renamed" : "modified",
      additions: 0,
      deletions: 0,
      binary: false,
      truncated: false,
      lines: [],
    };
    files.push(file);
    fileHasHunk = false;
    hunk = undefined;
    binaryPatch = false;
    return file;
  };
  const current = () => file ?? startFile();
  const setPaths = (target: DiffFile, oldPath: string | null, newPath: string | null) => {
    if (oldPath === null && newPath !== null) {
      target.path = newPath;
      target.status = "added";
    } else if (newPath === null && oldPath !== null) {
      target.path = oldPath;
      target.status = "deleted";
    } else if (oldPath !== null && newPath !== null) {
      target.path = newPath;
      if (oldPath !== newPath) {
        target.previousPath = oldPath;
        target.status = "renamed";
      }
    }
  };

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] ?? "";
    const blank: boolean = previousBlank;
    previousBlank = row === "";
    const insideCounted = hunk?.counted === true && (hunk.oldLeft > 0 || hunk.newLeft > 0);

    if (!insideCounted) {
      if (row.startsWith("diff --git ")) {
        const match = gitHeader.exec(row);
        startFile(unquote(match?.[2] ?? ""), match ? unquote(match[1] ?? "") : undefined);
        continue;
      }
      // A ---/+++ pair opens a file. Inside an uncounted review hunk it must follow the blank
      // separator line, so a removed line whose content starts with "-- " is not mistaken.
      const next = rows[index + 1];
      if (
        row.startsWith("--- ") &&
        next?.startsWith("+++ ") &&
        (hunk === undefined || hunk.counted || blank)
      ) {
        const target = file && !fileHasHunk ? file : startFile();
        setPaths(target, headerPath(row.slice(4)), headerPath(next.slice(4)));
        index++;
        previousBlank = false;
        hunk = undefined;
        continue;
      }
      if (row.startsWith("@@")) {
        const target = current();
        fileHasHunk = true;
        binaryPatch = false;
        const label = hunkLabel(row);
        target.lines.push({ kind: "hunk", text: row, ...(label ? { label } : {}) });
        const standard = standardHunk.exec(row);
        const focused = focusedHunk.exec(row);
        if (standard) {
          hunk = {
            counted: true,
            old: Number(standard[1]),
            oldLeft: standard[2] === undefined ? 1 : Number(standard[2]),
            new: Number(standard[3]),
            newLeft: standard[4] === undefined ? 1 : Number(standard[4]),
          };
        } else if (focused) {
          let leading = 0;
          while (rows[index + 1 + leading]?.startsWith(" ")) leading++;
          const start = Math.max(1, Number(focused[1]) - leading);
          hunk = { counted: false, oldLeft: 0, newLeft: 0, old: start, new: start };
        } else if (row === "@@ create file @@") {
          target.status = "added";
          hunk = { counted: false, oldLeft: 0, newLeft: 0, new: 1 };
        } else if (row === "@@ delete file @@") {
          target.status = "deleted";
          hunk = { counted: false, oldLeft: 0, newLeft: 0, old: 1 };
        } else hunk = { counted: false, oldLeft: 0, newLeft: 0 };
        continue;
      }
    }

    const target = current();
    if (hunk === undefined || (hunk.counted && !insideCounted)) {
      // File-level metadata between headers and hunks (or after a finished counted hunk).
      // Header rows are represented by path/status; only informative metadata stays a row.
      if (row === "" || binaryPatch || row.startsWith("index ")) continue;
      if (row.startsWith("new file mode")) target.status = "added";
      else if (row.startsWith("deleted file mode")) target.status = "deleted";
      else if (row.startsWith("rename from ") || row.startsWith("copy from ")) {
        target.previousPath = unquote(row.replace(/^(rename|copy) from /, ""));
        target.status = "renamed";
      } else if (row.startsWith("rename to ") || row.startsWith("copy to "))
        target.path = unquote(row.replace(/^(rename|copy) to /, ""));
      else if (row === "GIT binary patch") {
        target.binary = true;
        binaryPatch = true;
      } else if (/^Binary files .* differ$/.test(row)) {
        target.binary = true;
        const paths = /^Binary files (.+) and (.+) differ$/.exec(row);
        if (paths && !target.path)
          setPaths(target, headerPath(paths[1] ?? ""), headerPath(paths[2] ?? ""));
      } else if (!target.path && !target.lines.length && !fileHasHunk && /^[+\- ]/.test(row)) {
        // No header at all: keep the content readable as one section.
        hunk = { counted: false, oldLeft: 0, newLeft: 0 };
        index--;
        previousBlank = blank;
      } else target.lines.push({ kind: "meta", text: row });
      continue;
    }

    // Inside a hunk.
    if (row === "" && !insideCounted) continue; // the blank line between review files
    const sign = row[0] ?? " ";
    const content = row.slice(1);
    if (sign === "\\") {
      target.lines.push({ kind: "meta", text: row });
    } else if (sign === "+") {
      target.lines.push({
        kind: "add",
        text: content,
        ...(hunk.new !== undefined ? { newLine: hunk.new++ } : {}),
      });
      target.additions++;
      if (hunk.counted) hunk.newLeft--;
    } else if (sign === "-") {
      target.lines.push({
        kind: "del",
        text: content,
        ...(hunk.old !== undefined ? { oldLine: hunk.old++ } : {}),
      });
      target.deletions++;
      if (hunk.counted) hunk.oldLeft--;
    } else if (sign === " " || row === "") {
      target.lines.push({
        kind: "context",
        text: content,
        ...(hunk.old !== undefined ? { oldLine: hunk.old++ } : {}),
        ...(hunk.new !== undefined ? { newLine: hunk.new++ } : {}),
      });
      if (hunk.counted) {
        hunk.oldLeft--;
        hunk.newLeft--;
      }
    } else {
      target.lines.push({ kind: "meta", text: row });
    }
  }

  const truncated = options.truncated === true;
  const last = files.at(-1);
  if (truncated && last) last.truncated = true;
  for (const item of files) withoutReviewNewlines(item);
  return {
    files,
    additions: files.reduce((sum, item) => sum + item.additions, 0),
    deletions: files.reduce((sum, item) => sum + item.deletions, 0),
    truncated,
  };
}
