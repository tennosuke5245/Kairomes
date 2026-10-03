import { expect, test } from "bun:test";
import type { FileResult } from "@kairomes/protocol";
import { invalidateHostViewerRead, readCurrentResult } from "./read-current-result.ts";

const file: FileResult = {
  kind: "file",
  workspace_id: "00000000-0000-4000-8000-000000000010",
  path: "README.md",
  content: "原先的執行時內容",
  version: "1".repeat(64),
  start_line: 1,
  total_lines: 1,
  next_line: null,
  truncated: false,
  redacted: false,
};
const expected = { kind: "file" as const, workspaceId: file.workspace_id, path: file.path };

test("a failed or superseded current read cannot supply replacement evidence", async () => {
  await expect(
    readCurrentResult(
      expected,
      async () => {
        throw new Error("removed");
      },
      () => true,
    ),
  ).rejects.toThrow("removed");
  let resolve!: (value: FileResult) => void;
  const pending = new Promise<FileResult>((done) => {
    resolve = done;
  });
  let active = true;
  const loading = readCurrentResult(
    expected,
    () => pending,
    () => active,
  );
  active = false; // Returning or unmounting invalidates this read before it replies.
  resolve({ ...file, content: "延遲的新內容", version: "2".repeat(64) });
  expect(await loading).toBeUndefined();
});

test("a fresh read must match the selected workspace, path and result kind", async () => {
  for (const wrong of [
    { ...file, workspace_id: "00000000-0000-4000-8000-000000000020" },
    { ...file, path: "other.md" },
    { kind: "workspaces" as const, workspaces: [] },
  ])
    await expect(
      readCurrentResult(
        expected,
        async () => wrong,
        () => true,
      ),
    ).rejects.toThrow("不符");
  expect(
    await readCurrentResult(
      expected,
      async () => file,
      () => true,
    ),
  ).toBe(file);
});

test("a newer host viewer result invalidates a delayed read in the same workspace", async () => {
  for (const kind of ["file", "search", "artifact", "snapshot"] as const) {
    const request = { current: 1 };
    const current = request.current;
    let resolve!: (value: FileResult) => void;
    const pending = new Promise<FileResult>((done) => {
      resolve = done;
    });
    const reading = readCurrentResult(
      expected,
      () => pending,
      () => current === request.current,
    );
    expect(invalidateHostViewerRead({ kind }, request)).toBe(true);
    resolve({ ...file, content: "較早要求的延遲回覆" });
    expect(await reading).toBeUndefined();
  }
});

test("catalog and non-viewer host updates leave a person's pending read intact", async () => {
  const request = { current: 4 };
  const current = request.current;
  let resolve!: (value: FileResult) => void;
  const pending = new Promise<FileResult>((done) => {
    resolve = done;
  });
  const reading = readCurrentResult(
    expected,
    () => pending,
    () => current === request.current,
  );
  for (const kind of ["mcp_catalog", "workspaces", "status"] as const)
    expect(invalidateHostViewerRead({ kind }, request)).toBe(false);
  resolve(file);
  expect(await reading).toBe(file);
});
