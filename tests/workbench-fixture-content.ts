import type {
  Command,
  FileChange,
  SearchResult,
  Snapshot,
} from "../packages/protocol/src/index.ts";

// Synthetic content for the ?timeline=1 workbench preview: command output, diffs, folders,
// files and search hits. Everything is invented text; nothing reads a disk or runs a command.

const failingTest = {
  stdout: [
    "bun test v1.4.2",
    "",
    "tests/render.test.ts:",
    "✓ 歡迎訊息包含產品名稱 [0.41ms]",
    "✗ render 會輸出歡迎訊息 [1.02ms]",
    "",
    " 1 pass",
    " 1 fail",
    " 2 expect() calls",
    "Ran 2 tests across 1 files. [86.00ms]",
  ].join("\n"),
  stderr: [
    "error: expect(received).toBe(expected)",
    'Expected: "Kairomes 已就緒"',
    'Received: "Kairomes"',
    "      at tests/render.test.ts:9:18",
  ].join("\n"),
};

/** Output for a timeline command; running commands have a partial tail. */
export function commandOutput(command: Command) {
  if (command.state === "pending" || command.state === "denied") return { stdout: "", stderr: "" };
  if (command.state === "failed") return failingTest;
  if (command.state === "running")
    return {
      stdout: Array.from(
        { length: 18 },
        (_, index) =>
          `tests/module-${String(index + 1).padStart(2, "0")}.test.ts: ✓ 合成測試 ${index + 1}`,
      ).join("\n"),
      stderr: "",
    };
  return { stdout: "Checked 275 files in 513ms. No fixes applied.", stderr: "" };
}

/** A two-file review diff for pending changes; a single edit for the others. */
export function changeDiff(change: FileChange) {
  if (change.files.length === 2)
    return [
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -12,7 +12,8 @@",
      ' import { render } from "./view.ts";',
      "",
      '-export const message = "Kairomes";',
      '+export const message = "Kairomes 已就緒";',
      '+export const version = "0.3.0";',
      " ",
      " export function start() {",
      "   render(message);",
      "",
      "--- /dev/null",
      "+++ b/src/view.ts",
      "@@ create file @@",
      "+export function render(text: string) {",
      '+  const node = document.createElement("p");',
      "+  node.textContent = text;",
      "+  document.body.append(node);",
      "+}",
    ].join("\n");
  return change.files
    .map((file) =>
      [
        `--- a/${file.path}`,
        `+++ b/${file.path}`,
        "@@ exact replacement 1 @@",
        "-舊的段落說明。",
        "+新的段落說明，補上設定步驟。",
      ].join("\n"),
    )
    .join("\n\n");
}

const tree: Record<string, Snapshot["entries"]> = {
  "": [
    { name: "apps", path: "apps", kind: "directory" },
    { name: "docs", path: "docs", kind: "directory" },
    { name: "packages", path: "packages", kind: "directory" },
    { name: "README.md", path: "README.md", kind: "file" },
    { name: "package.json", path: "package.json", kind: "file" },
  ],
  apps: [
    { name: "extension", path: "apps/extension", kind: "directory" },
    { name: "widget", path: "apps/widget", kind: "directory" },
  ],
  "apps/extension": [{ name: "src", path: "apps/extension/src", kind: "directory" }],
  "apps/extension/src": [
    { name: "icons", path: "apps/extension/src/icons", kind: "directory" },
    ...[
      "access-panel.ts",
      "active-work-panel.ts",
      "approval-panel.ts",
      "approval-state.ts",
      "mcp-panel.ts",
      "sidepanel.ts",
      "workspace-selection.ts",
      "connection.ts",
      "countdown.ts",
      "diff-view.ts",
      "settings-panel.ts",
      "toolbar.ts",
    ].map((name) => ({ name, path: `apps/extension/src/${name}`, kind: "file" as const })),
    { name: "preview.png", path: "apps/extension/src/preview.png", kind: "file" },
  ],
};

export function folder(path: string): Snapshot["entries"] {
  return tree[path] ?? [];
}

/**
 * 148 numbered synthetic lines ending in a newline; file_read pages them like the daemon
 * (max_lines per page, default 150; split on newlines, so the final newline counts as an
 * empty 149th line).
 */
export function fileContent(path: string, start: number, maxLines = 150) {
  const total = 148;
  const hits = new Map(
    searchLines.filter(([file]) => file === path).map(([, line, text]) => [line, text]),
  );
  const lines = Array.from({ length: total }, (_, index) => {
    const line = index + 1;
    const hit = hits.get(line);
    if (hit) return hit.replace(/^…/, "");
    return line % 7 === 0 ? "" : `  // ${path} 的第 ${line} 行合成內容`;
  });
  const elements = [...lines, ""];
  const first = Math.max(1, Math.min(start, elements.length));
  const page = elements.slice(first - 1, first - 1 + maxLines);
  return { content: page.join("\n"), start_line: first, total_lines: elements.length };
}

const searchLines: [string, number, string][] = [
  [
    "apps/extension/src/approval-panel.ts",
    16,
    "const titles: Record<Kind, string> = { // approval titles",
  ],
  [
    "apps/extension/src/approval-panel.ts",
    175,
    "…risk.textContent = describeRisk(approval.scope); // keeps the risk strip first in every decision view so the reviewer reads it before the diff",
  ],
  [
    "apps/extension/src/approval-panel.ts",
    321,
    "label.append(approvalTitle(item), workspaceTag(item));",
  ],
  ["apps/extension/src/approval-panel.ts", 402, "if (!approval) return renderEmpty();"],
  ["apps/extension/src/approval-panel.ts", 455, "approvalList.replaceChildren(...rows);"],
  [
    "apps/extension/src/approval-state.ts",
    42,
    "export function nextApproval(queue: PendingApproval[]) {",
  ],
  [
    "apps/extension/src/approval-state.ts",
    88,
    'if (!isTrusted) throw new Error("approval requires a user gesture");',
  ],
  ["README.md", 12, "## Approval（核准）流程"],
];

export function searchMatches(query: string, caseSensitive: boolean): SearchResult["matches"] {
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  return searchLines
    .filter(([, , text]) => (caseSensitive ? text : text.toLocaleLowerCase()).includes(needle))
    .map(([path, line, text]) => ({ path, line, text }));
}
