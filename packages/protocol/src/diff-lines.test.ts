import { expect, test } from "bun:test";
import { type DiffLine, diffPathParts, parseUnifiedDiff } from "./diff-lines.ts";

const content = (lines: DiffLine[]) =>
  lines.filter((line) => line.kind !== "meta").map((line) => [line.kind, line.text]);
const numbers = (lines: DiffLine[]) =>
  lines
    .filter((line) => line.kind === "add" || line.kind === "del" || line.kind === "context")
    .map((line) => [line.kind, line.oldLine ?? null, line.newLine ?? null]);

test("review diffs from workspace-core: replacements, create, delete and focused rewrites", () => {
  const diff = [
    "--- a/README.md",
    "+++ b/README.md",
    "@@ exact replacement 1 @@",
    "-Hello Kairomes",
    "+Hello Meow",
    "@@ exact replacement 2 · all matches @@",
    "-a",
    "+b",
    "",
    "--- /dev/null",
    "+++ b/docs/new.md",
    "@@ create file @@",
    "+# New",
    "+",
    "",
    "--- a/src/old.ts",
    "+++ /dev/null",
    "@@ delete file @@",
    "-export {};",
    "",
    "--- a/src/main.ts",
    "+++ b/src/main.ts",
    "@@ 4 @@",
    " two",
    " three",
    "-four",
    "+FOUR",
    " five",
    " six",
  ].join("\n");
  const parsed = parseUnifiedDiff(diff);
  // "+# New" then the bare "+" of its final newline: the file has one line, not two.
  expect(parsed).toMatchObject({ additions: 4, deletions: 4, truncated: false });
  expect(
    parsed.files.map(({ path, status, additions, deletions }) => [
      path,
      status,
      additions,
      deletions,
    ]),
  ).toEqual([
    ["README.md", "modified", 2, 2],
    ["docs/new.md", "added", 1, 0],
    ["src/old.ts", "deleted", 0, 1],
    ["src/main.ts", "modified", 1, 1],
  ]);
  const [readme, created, deleted, rewritten] = parsed.files;
  expect(readme?.lines.filter((line) => line.kind === "hunk").map((line) => line.label)).toEqual([
    "替換 1",
    "替換 2 · 全部相符處",
  ]);
  // Exact replacements carry no position, so no line numbers are invented.
  expect(numbers(readme?.lines ?? [])).toEqual([
    ["del", null, null],
    ["add", null, null],
    ["del", null, null],
    ["add", null, null],
  ]);
  expect(numbers(created?.lines ?? [])).toEqual([["add", null, 1]]);
  expect(created?.lines.at(-1)?.text).toBe("# New");
  expect(numbers(deleted?.lines ?? [])).toEqual([["del", 1, null]]);
  expect(rewritten?.lines[0]).toMatchObject({ kind: "hunk", label: "第 4 行起" });
  expect(numbers(rewritten?.lines ?? [])).toEqual([
    ["context", 2, 2],
    ["context", 3, 3],
    ["del", 4, null],
    ["add", null, 4],
    ["context", 5, 5],
    ["context", 6, 6],
  ]);
});

// Captured from WorkspaceChanges.prepare: an edit of "-- dash item\n" to "-- dashed item\n",
// a delete of "first\nsecond\n" and a create of "# New\n\nbody\n".
const prepared =
  "--- a/notes.md\n+++ b/notes.md\n@@ exact replacement 1 @@\n--- dash item\n-\n+-- dashed item\n+\n\n--- a/gone.md\n+++ /dev/null\n@@ delete file @@\n-first\n-second\n-\n\n--- /dev/null\n+++ b/src/new.md\n@@ create file @@\n+# New\n+\n+body\n+";

test("a review text ending in a newline adds no empty -/+ row and no count", () => {
  const rows = (lines: readonly { kind: string; text: string }[]) =>
    lines.map((line) => [line.kind, line.text]);
  const parsed = parseUnifiedDiff(prepared);
  expect(
    parsed.files.map(({ path, additions, deletions }) => [path, additions, deletions]),
  ).toEqual([
    ["notes.md", 1, 1],
    ["gone.md", 0, 2],
    ["src/new.md", 3, 0],
  ]);
  expect([parsed.additions, parsed.deletions]).toEqual([4, 3]);
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
  expect(parsed.files[2]?.lines.map((line) => line.newLine)).toEqual([undefined, 1, 2, 3]);

  // A replacement that adds or removes a newline keeps both rows, so the change stays visible.
  const joined = ["--- a/a.txt", "+++ b/a.txt", "@@ exact replacement 1 @@", "-x", "-", "+y"];
  expect(rows(parseUnifiedDiff(joined.join("\n")).files[0]?.lines ?? [])).toEqual([
    ["hunk", "@@ exact replacement 1 @@"],
    ["del", "x"],
    ["del", ""],
    ["add", "y"],
  ]);
  // Two trailing blank rows are one blank line plus the newline: one row stays.
  const blank = ["--- /dev/null", "+++ b/a.txt", "@@ create file @@", "+a", "+", "+"];
  expect(rows(parseUnifiedDiff(blank.join("\n")).files[0]?.lines ?? [])).toEqual([
    ["hunk", "@@ create file @@"],
    ["add", "a"],
    ["add", ""],
  ]);
  // Focused hunks share the final newline as context and are left alone.
  const focused = ["--- a/a.ts", "+++ b/a.ts", "@@ 2 @@", " one", "-", "+two", " three"];
  expect(parseUnifiedDiff(focused.join("\n")).files[0]?.lines).toHaveLength(5);
  // The last row of a cut diff may stop mid-text, so it is kept.
  const cut = parseUnifiedDiff(
    ["--- /dev/null", "+++ b/a.txt", "@@ create file @@", "+a", "+"].join("\n"),
    { truncated: true },
  );
  expect(cut.additions).toBe(2);
});

test("removed lines that look like headers stay content inside a review hunk", () => {
  const parsed = parseUnifiedDiff(
    ["--- a/notes.md", "+++ b/notes.md", "@@ exact replacement 1 @@", "--- a/x", "+++ b/y"].join(
      "\n",
    ),
  );
  expect(parsed.files).toHaveLength(1);
  expect(content(parsed.files[0]?.lines ?? [])).toEqual([
    ["hunk", "@@ exact replacement 1 @@"],
    ["del", "-- a/x"],
    ["add", "++ b/y"],
  ]);
});

test("standard git diffs: counted hunks, renames, new files, binaries and no-newline markers", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,4 +10,4 @@ export function app() {",
    " const a = 1;",
    "--- a dashed comment line",
    "+-- a dashed comment line, edited",
    " const b = 2;",
    "",
    "\\ No newline at end of file",
    "diff --git a/old name.txt b/new name.txt",
    "similarity index 90%",
    "rename from old name.txt",
    "rename to new name.txt",
    "diff --git a/assets/logo.png b/assets/logo.png",
    "new file mode 100644",
    "index 0000000..3333333",
    "Binary files /dev/null and b/assets/logo.png differ",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
  ].join("\r\n");
  const parsed = parseUnifiedDiff(diff);
  expect(
    parsed.files.map(({ path, previousPath, status, binary }) => [
      path,
      previousPath ?? null,
      status,
      binary,
    ]),
  ).toEqual([
    ["src/app.ts", null, "modified", false],
    ["new name.txt", "old name.txt", "renamed", false],
    ["assets/logo.png", null, "added", true],
    ["gone.txt", null, "deleted", false],
  ]);
  const [app, renamed, , gone] = parsed.files;
  expect(numbers(app?.lines ?? [])).toEqual([
    ["context", 10, 10],
    ["del", 11, null],
    ["add", null, 11],
    ["context", 12, 12],
    ["context", 13, 13],
  ]);
  expect(app?.lines.find((line) => line.kind === "del")?.text).toBe("-- a dashed comment line");
  expect(app?.lines.at(-1)).toEqual({ kind: "meta", text: "\\ No newline at end of file" });
  expect(app?.lines[0]).toMatchObject({ kind: "hunk", label: "第 10 行起" });
  expect(renamed?.lines.map((line) => line.text)).toEqual(["similarity index 90%"]);
  expect(numbers(gone?.lines ?? [])).toEqual([["del", 1, null]]);
  expect([parsed.additions, parsed.deletions]).toEqual([1, 2]);
});

test("quoted git paths are decoded, timestamps dropped", () => {
  const parsed = parseUnifiedDiff(
    [
      '--- "a/\\346\\226\\207\\344\\273\\266 1.txt"\t2026-10-06 10:00:00',
      '+++ "b/\\346\\226\\207\\344\\273\\266 1.txt"\t2026-10-06 10:00:01',
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n"),
  );
  expect(parsed.files[0]?.path).toBe("文件 1.txt");
  expect(parsed.files[0]?.status).toBe("modified");
});

test("truncation passes through and marks the incomplete last file", () => {
  const parsed = parseUnifiedDiff(
    [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ 1 @@",
      "-a",
      "+b",
      "",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ 1 @@",
      "-lo",
    ].join("\n"),
    { truncated: true },
  );
  expect(parsed.truncated).toBe(true);
  expect(parsed.files.map((file) => [file.path, file.truncated])).toEqual([
    ["a.txt", false],
    ["b.txt", true],
  ]);
  expect(parseUnifiedDiff("--- a/a\n+++ b/a\n@@ 1 @@\n-a\n+b").truncated).toBe(false);
});

test("input without headers falls back to one readable section", () => {
  const parsed = parseUnifiedDiff("+added\n-removed\n kept\nnot a diff line");
  expect(parsed.files).toHaveLength(1);
  expect(parsed.files[0]).toMatchObject({
    path: "",
    status: "modified",
    additions: 1,
    deletions: 1,
  });
  expect(content(parsed.files[0]?.lines ?? [])).toEqual([
    ["add", "added"],
    ["del", "removed"],
    ["context", "kept"],
  ]);
  expect(parsed.files[0]?.lines.at(-1)).toEqual({ kind: "meta", text: "not a diff line" });
  expect(parseUnifiedDiff("")).toEqual({ files: [], additions: 0, deletions: 0, truncated: false });
});

test("paths split into directory and file name for display", () => {
  expect(diffPathParts("packages/app/src/main.ts")).toEqual({
    directory: "packages/app/src/",
    name: "main.ts",
  });
  expect(diffPathParts("README.md")).toEqual({ directory: "", name: "README.md" });
});
