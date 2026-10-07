import { expect, test } from "bun:test";
import { groupMatches, highlightSnippet, searchSummary } from "./search-model.ts";

const join = (segments: ReturnType<typeof highlightSnippet>) =>
  segments.map((segment) => (segment.mark ? `[${segment.text}]` : segment.text)).join("");

test("matches become marked segments, case-insensitive by default", () => {
  expect(highlightSnippet("const approval = Approval();", "approval")).toEqual([
    { text: "const ", mark: false },
    { text: "approval", mark: true },
    { text: " = ", mark: false },
    { text: "Approval", mark: true },
    { text: "();", mark: false },
  ]);
  expect(join(highlightSnippet("approval Approval", "Approval", { caseSensitive: true }))).toBe(
    "approval [Approval]",
  );
});

test("a long line is re-centred so the match stays visible with … only at cut ends", () => {
  const text = `${"a".repeat(300)}needle${"b".repeat(300)}`;
  const result = join(highlightSnippet(text, "needle", { window: 60 }));
  expect(result).toContain("[needle]");
  expect(result.startsWith("…")).toBe(true);
  expect(result.endsWith("…")).toBe(true);
  expect(result.length).toBeLessThanOrEqual(60 + 2 + 2);
  const early = join(highlightSnippet(`needle${"b".repeat(300)}`, "needle", { window: 60 }));
  expect(early.startsWith("[needle]")).toBe(true);
  const late = join(highlightSnippet(`${"a".repeat(300)}needle`, "needle", { window: 60 }));
  expect(late.endsWith("[needle]")).toBe(true);
});

test("regex characters are literal, no match leaves plain text, emoji are never split", () => {
  expect(join(highlightSnippet("a.b*c", ".b*"))).toBe("a[.b*]c");
  expect(highlightSnippet("plain", "zzz")).toEqual([{ text: "plain", mark: false }]);
  expect(highlightSnippet("x", "")).toEqual([{ text: "x", mark: false }]);
  const emoji = `${"🐱".repeat(40)}貓${"🐱".repeat(40)}`;
  const cut = join(highlightSnippet(emoji, "貓", { window: 21 }));
  expect(cut).toContain("[貓]");
  expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});

test("results are grouped by file in first-appearance order with the filename first", () => {
  const groups = groupMatches([
    { path: "apps/extension/src/approval-panel.ts", line: 16, text: "a" },
    { path: "README.md", line: 2, text: "b" },
    { path: "apps/extension/src/approval-panel.ts", line: 175, text: "c" },
  ]);
  expect(groups.map((group) => [group.name, group.directory, group.hits.length])).toEqual([
    ["approval-panel.ts", "apps/extension/src", 2],
    ["README.md", "", 1],
  ]);
});

test("one summary line: count, scanned files and the limit, never hidden files", () => {
  const matches = Array.from({ length: 23 }, (_, line) => ({ path: "a", line, text: "" }));
  expect(searchSummary({ matches, scanned_files: 6, truncated: false })).toBe(
    "23 筆 · 已掃描 6 個檔案",
  );
  expect(searchSummary({ matches, scanned_files: 1200, truncated: true })).toBe(
    "23 筆 · 已掃描 1,200 個檔案 · 已達上限",
  );
});
