import { expect, test } from "bun:test";
import { parseUnifiedDiff } from "@kairomes/protocol/diff-lines";
import {
  DIFF_STATUS,
  diffCounts,
  diffNumbered,
  diffSections,
  diffSign,
  diffTotals,
  MIN_ROWS_PER_FILE,
  parseChangeDiff,
} from "./diff-model.ts";

const twoFiles = [
  "--- a/src/main.ts",
  "+++ b/src/main.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old",
  "+new",
  " tail",
  "",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ create file @@",
  ...Array.from({ length: 30 }, (_, index) => `+line ${index + 1}`),
].join("\n");

test("one section per file with counts, status labels and old/new line numbers", () => {
  const parsed = parseUnifiedDiff(twoFiles);
  const sections = diffSections(parsed, 400);
  expect(
    sections.map((section) => [section.file.path, DIFF_STATUS[section.file.status].label]),
  ).toEqual([
    ["src/main.ts", "修改"],
    ["src/new.ts", "新檔案"],
  ]);
  const first = sections[0]?.lines ?? [];
  expect(first.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
    ["hunk", undefined, undefined],
    ["context", 1, 1],
    ["del", 2, undefined],
    ["add", undefined, 2],
    ["context", 3, 3],
  ]);
  expect(first[0]?.label).toBe("第 1 行起");
  expect(diffTotals(parsed)).toBe("2 個檔案 · +31 −1");
  expect(DIFF_STATUS.deleted).toEqual({ label: "刪除", tone: "warning" });
});

test("exact replacements reserve no line-number gutter", () => {
  const parsed = parseUnifiedDiff(
    ["--- a/a.md", "+++ b/a.md", "@@ exact replacement 1 @@", "-old", "+new"].join("\n"),
  );
  expect(diffNumbered(parsed.files[0] ?? { lines: [] })).toBe(false);
  expect(parseUnifiedDiff(twoFiles).files.every(diffNumbered)).toBe(true);
});

test("a line budget keeps every file visible and expands one file on request", () => {
  const parsed = parseUnifiedDiff(twoFiles);
  const tight = diffSections(parsed, 5);
  expect(tight[0]?.lines.length).toBe(5);
  expect(tight[1]?.lines.length).toBe(MIN_ROWS_PER_FILE);
  expect(tight[1]?.hidden).toBe(31 - MIN_ROWS_PER_FILE);
  const opened = diffSections(parsed, 5, new Set([tight[1]?.key ?? ""]));
  expect(opened[1]?.hidden).toBe(0);
  expect(opened[1]?.lines.length).toBe(31);
});

test("signs are content glyphs and a truncated diff stays marked", () => {
  expect([diffSign("add"), diffSign("del"), diffSign("context"), diffSign("hunk")]).toEqual([
    "+",
    "−",
    "",
    "",
  ]);
  const parsed = parseUnifiedDiff(twoFiles, { truncated: true });
  expect(parsed.truncated).toBe(true);
  expect(parsed.files.at(-1)?.truncated).toBe(true);
});

test("counts from a cut diff read as a minimum and take the file count from the change", () => {
  const cut = parseUnifiedDiff(twoFiles, { truncated: true });
  // Four files changed; the cut diff only reached two of them.
  expect(diffTotals(cut, 4)).toBe("4 個檔案 · 至少 +31 −1");
  expect(diffTotals(cut)).toBe("2 個檔案 · 至少 +31 −1");
  expect(diffCounts(cut.files.at(-1) ?? cut)).toBe("至少 +30 −0");
  expect(diffCounts(cut.files[0] ?? cut)).toBe("+1 −1");
  // A complete diff states its own counts.
  expect(diffTotals(parseUnifiedDiff(twoFiles), 4)).toBe("2 個檔案 · +31 −1");
});

// Captured from WorkspaceChanges.prepare: an edit of "-- dash item\n" to "-- dashed item\n",
// a delete of "first\nsecond\n" and a create of "# New\n\nbody\n".
const prepared =
  "--- a/notes.md\n+++ b/notes.md\n@@ exact replacement 1 @@\n--- dash item\n-\n+-- dashed item\n+\n\n--- a/gone.md\n+++ /dev/null\n@@ delete file @@\n-first\n-second\n-\n\n--- /dev/null\n+++ b/src/new.md\n@@ create file @@\n+# New\n+\n+body\n+";

test("a text ending in a newline adds no empty -/+ row and no count", () => {
  const rows = (lines: readonly { kind: string; text: string }[]) =>
    lines.map((line) => [line.kind, line.text]);
  const parsed = parseChangeDiff(prepared, false);
  expect(
    parsed.files.map(({ path, additions, deletions }) => [path, additions, deletions]),
  ).toEqual([
    ["notes.md", 1, 1],
    ["gone.md", 0, 2],
    ["src/new.md", 3, 0],
  ]);
  expect(diffTotals(parsed)).toBe("3 個檔案 · +4 −3");
  expect(rows(parsed.files[0]?.lines ?? [])).toEqual([
    ["hunk", "@@ exact replacement 1 @@"],
    ["del", "-- dash item"],
    ["add", "-- dashed item"],
  ]);
  // A blank line inside the text stays; only the final newline row goes.
  expect(rows(parsed.files[2]?.lines ?? [])).toEqual([
    ["hunk", "@@ create file @@"],
    ["add", "# New"],
    ["add", ""],
    ["add", "body"],
  ]);
  expect(parsed.files[1]?.lines.map((line) => line.oldLine)).toEqual([undefined, 1, 2]);
  // The shared parser still sees the raw rows; only the widget's view drops them.
  expect(parseUnifiedDiff(prepared).additions).toBe(6);
  // Focused hunks share the final newline as context and are left alone.
  const focused = ["--- a/a.ts", "+++ b/a.ts", "@@ 2 @@", " one", "-", "+two", " three"].join("\n");
  expect(parseChangeDiff(focused, false)).toEqual(parseUnifiedDiff(focused));
  // The last row of a cut diff may stop mid-text, so it is kept.
  const cut = parseChangeDiff(
    ["--- /dev/null", "+++ b/a.txt", "@@ create file @@", "+a", "+"].join("\n"),
    true,
  );
  expect(cut.additions).toBe(2);
  expect(diffTotals(cut, 1)).toBe("1 個檔案 · 至少 +2 −0");
});
