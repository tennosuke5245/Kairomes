import { expect, test } from "bun:test";
import type { FileResult, Snapshot } from "@kairomes/protocol";
import {
  FILE_PAGE,
  FILE_READ_LINES,
  fileLineCount,
  fileLines,
  fileMeta,
  fileRange,
  filterEntries,
  finalNewlineFromProbe,
  formatBytes,
  formatDimensions,
  hitStartLine,
  isImagePath,
  nextPageLine,
  pathCrumbs,
  splitPath,
  trimLookahead,
  utf8Bytes,
} from "./file-model.ts";

// What WorkspaceFiles.read returns for "one\r\ntwo\nthree\n": it splits on /\r?\n/, so the
// final newline counts as a fourth, empty line, and the page joins with "\n".
const file: FileResult = {
  kind: "file",
  workspace_id: "w",
  path: "src/main.ts",
  content: "one\ntwo\nthree\n",
  version: "a".repeat(64),
  start_line: 1,
  total_lines: 4,
  next_line: null,
  truncated: false,
  redacted: false,
};

test("one image rule replaces the duplicated regexes", () => {
  for (const path of ["a.png", "b/C.JPG", "c.jpeg", "d.webp"]) expect(isImagePath(path)).toBe(true);
  for (const path of ["a.svg", "png", "a.png.txt", "gif.gif"])
    expect(isImagePath(path)).toBe(false);
});

test("breadcrumbs list the path below the root, never the project name", () => {
  expect(pathCrumbs("")).toEqual([]);
  expect(pathCrumbs("apps/extension/src")).toEqual([
    { name: "apps", path: "apps" },
    { name: "extension", path: "apps/extension" },
    { name: "src", path: "apps/extension/src" },
  ]);
  expect(splitPath("apps/extension/src/a.ts")).toEqual({
    directory: "apps/extension/src",
    name: "a.ts",
  });
  expect(splitPath("README.md")).toEqual({ directory: "", name: "README.md" });
});

test("the folder filter is case-insensitive, keeps folders first and ignores blank input", () => {
  const entries: Snapshot["entries"] = [
    { name: "Main.ts", path: "Main.ts", kind: "file" },
    { name: "src", path: "src", kind: "directory" },
    { name: "maintenance", path: "maintenance", kind: "directory" },
  ];
  expect(filterEntries(entries, "  ").map((entry) => entry.name)).toEqual([
    "src",
    "maintenance",
    "Main.ts",
  ]);
  expect(filterEntries(entries, "MAIN").map((entry) => entry.name)).toEqual([
    "maintenance",
    "Main.ts",
  ]);
  expect(filterEntries(entries, "ｍａｉｎ").length).toBe(2);
  expect(filterEntries(entries, "zzz")).toEqual([]);
});

test("file lines number from start_line, drop the final newline and mark the focus line", () => {
  expect(fileLines(file)).toEqual([
    { number: 1, text: "one", focus: false },
    { number: 2, text: "two", focus: false },
    { number: 3, text: "three", focus: false },
  ]);
  const page = fileLines({ content: "x\ny", start_line: 40 }, 41);
  expect(page.map((line) => [line.number, line.focus])).toEqual([
    [40, false],
    [41, true],
  ]);
  expect(fileLines({ content: "", start_line: 1 })).toEqual([
    { number: 1, text: "", focus: false },
  ]);
});

test("the meta line states size, the page, redaction and source once", () => {
  expect(fileRange(file)).toEqual({ start: 1, end: 3, whole: true });
  expect(fileMeta(file)).toEqual(["3 行"]);
  const partial = {
    ...file,
    content: "a\nb",
    start_line: 151,
    total_lines: 1480,
    next_line: 153,
    redacted: true,
  };
  expect(fileMeta(partial, { historical: true })).toEqual([
    "1,480 行",
    "第 151–152 行",
    "已遮罩金鑰",
    "執行時讀取",
  ]);
  expect(hitStartLine(3)).toBe(1);
  expect(hitStartLine(40)).toBe(35);
});

test("a final newline is not an extra line: a complete file reads as whole", () => {
  expect(fileLineCount(file)).toBe(3);
  expect(fileRange(file).whole).toBe(true);
  // A 300-line file with a final newline, read in two pages of 150.
  const lines = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`);
  const last = {
    ...file,
    content: `${lines(151, 300).join("\n")}\n`,
    start_line: 151,
    total_lines: 301,
    next_line: null,
  };
  expect(fileLineCount(last)).toBe(300);
  expect(fileMeta(last)).toEqual(["300 行", "第 151–300 行"]);
  // A file without a final newline keeps the daemon count.
  const plain = { ...file, content: "one\ntwo", total_lines: 2 };
  expect(fileLineCount(plain)).toBe(2);
  expect(fileMeta(plain)).toEqual(["2 行"]);
  // A page that holds only the final empty line counts nothing extra.
  expect(fileLineCount({ ...last, content: "", start_line: 301 })).toBe(300);
  // An empty file is one empty line.
  expect(fileLineCount({ ...file, content: "", total_lines: 1 })).toBe(1);
});

/** What WorkspaceFiles.read pages for a file of `count` lines (see packages/workspace-core). */
function daemonPage(count: number, newline: boolean, start: number, maxLines: number) {
  const elements = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
  if (newline) elements.push("");
  const selected = elements.slice(start - 1, start - 1 + maxLines);
  const index = start - 1 + selected.length;
  return {
    ...file,
    content: selected.join("\n"),
    start_line: start,
    total_lines: elements.length,
    next_line: index < elements.length ? index + 1 : null,
    truncated: index < elements.length,
  };
}

test("one line of lookahead: no 下一頁 to an empty page past a final newline", () => {
  // 150 lines and a final newline: one page, read whole.
  const exact = trimLookahead(daemonPage(150, true, 1, FILE_READ_LINES));
  expect(fileMeta(exact)).toEqual(["150 行"]);
  expect(nextPageLine(exact)).toBeNull();
  expect(fileLines(exact).length).toBe(FILE_PAGE);
  // Without the lookahead the same file offered a page holding only the final newline.
  expect(daemonPage(150, true, 1, FILE_PAGE).next_line).toBe(151);
  // 151 real lines: the lookahead line is kept for the next page.
  const more = trimLookahead(daemonPage(151, false, 1, FILE_READ_LINES));
  expect(more.next_line).toBe(151);
  expect(more.truncated).toBe(true);
  expect(fileLines(more).length).toBe(FILE_PAGE);
  expect(fileLines(trimLookahead(daemonPage(151, false, 151, FILE_READ_LINES)))).toEqual([
    { number: 151, text: "line 151", focus: false },
  ]);
  // 300 lines and a final newline: page 2 ends the file.
  const second = trimLookahead(daemonPage(300, true, 151, FILE_READ_LINES));
  expect(nextPageLine(second)).toBeNull();
  expect(fileMeta(second)).toEqual(["300 行", "第 151–300 行"]);
  // A page cut short by the byte budget is left as the daemon sent it.
  const short = daemonPage(300, true, 1, 40);
  expect(trimLookahead(short)).toBe(short);
});

test("a read of the last line settles the count and 下一頁 on earlier pages", () => {
  const first = trimLookahead(daemonPage(300, true, 1, FILE_READ_LINES));
  // Unknown yet: the daemon count stands.
  expect(fileMeta(first)).toEqual(["301 行", "第 1–150 行"]);
  const probe = daemonPage(300, true, first.total_lines, 1);
  const newline = finalNewlineFromProbe(first, probe);
  expect(newline).toBe(true);
  expect(fileMeta(first, { endsWithNewline: newline })).toEqual(["300 行", "第 1–150 行"]);
  expect(fileLineCount(first, newline)).toBe(300);
  // A model page of lines 151–300 leaves only the final newline: no 下一頁.
  const modelPage = daemonPage(300, true, 151, FILE_PAGE);
  expect(nextPageLine(modelPage)).toBe(301);
  expect(nextPageLine(modelPage, true)).toBeNull();
  expect(fileRange(modelPage, true)).toEqual({ start: 151, end: 300, whole: false });
  // A file without a final newline: its last line is real.
  const plain = daemonPage(300, false, 1, FILE_READ_LINES);
  expect(finalNewlineFromProbe(plain, daemonPage(300, false, 300, 1))).toBe(false);
  expect(fileLineCount(trimLookahead(plain), false)).toBe(300);
  // A probe of another version says nothing.
  expect(finalNewlineFromProbe(first, { ...probe, version: "b".repeat(64) })).toBeUndefined();
});

test("image sizes carry no thousands separator", () => {
  expect(formatDimensions(1280, 720)).toBe("1280 × 720");
  expect(formatDimensions(12000, 9000)).toBe("12000 × 9000");
});

test("sizes read like 2.1 KiB, as on the side panel, and count UTF-8 bytes", () => {
  expect(formatBytes(980)).toBe("980 B");
  expect(formatBytes(2150)).toBe("2.1 KiB");
  expect(formatBytes(150 * 1024)).toBe("150 KiB");
  expect(formatBytes(3.1 * 1024 * 1024)).toBe("3.1 MiB");
  expect(utf8Bytes("喵a")).toBe(4);
});
