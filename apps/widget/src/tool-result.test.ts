import { expect, test } from "bun:test";
import { decodeResult } from "./tool-result.ts";

test("host result preserves pagination, falls back to valid text, and repairs only EOF null", () => {
  const file = {
    kind: "file" as const,
    workspace_id: "test",
    path: "README.md",
    content: "one\ntwo",
    version: "v",
    start_line: 1,
    total_lines: 2,
    next_line: null,
    truncated: false,
    redacted: false,
  };
  const omitted = { ...file, next_line: undefined };
  expect(decodeResult({ structuredContent: omitted })).toEqual(file);
  expect(
    decodeResult({
      structuredContent: { ...omitted, total_lines: 50 },
      content: [{ type: "text", text: JSON.stringify(file) }],
    }),
  ).toEqual(file);
  expect(() => decodeResult({ structuredContent: { ...omitted, truncated: true } })).toThrow(
    "資料不完整",
  );
  expect(() => decodeResult({ structuredContent: { ...omitted, total_lines: 50 } })).toThrow(
    "資料不完整",
  );
  expect(
    decodeResult({
      structuredContent: { ...file, total_lines: 50, next_line: 3, truncated: true },
    }),
  ).toHaveProperty("next_line", 3);
});
