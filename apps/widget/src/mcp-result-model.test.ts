import { expect, test } from "bun:test";
import type { McpCall } from "@kairomes/protocol";
import {
  callEyebrow,
  callNotice,
  callState,
  callText,
  callTitle,
  fieldCount,
  imageBox,
  imageCaption,
  imageSource,
  JSON_TREE_NODES,
  type JsonNode,
  jsonSize,
  jsonTree,
} from "./mcp-result-model.ts";

const tool = {
  ref: "synthetic:tool",
  server_id: "00000006-0000-4000-8000-000000000010",
  server_name: "合成伺服器",
  name: "synthetic_tool",
};
const content: McpCall["content"] = [
  { type: "text", text: "第一段" },
  {
    type: "image",
    media_id: "00000007-0000-4000-8000-000000000010",
    mime_type: "image/png",
    byte_length: 70,
    width: 1,
    height: 1,
  },
  { type: "text", text: "第二段" },
];

test("the JSON tree keeps keys, quotes strings and types every value", () => {
  expect(jsonTree({ a: "x", b: 2, c: true, d: null, e: [1], f: {} })).toEqual([
    { kind: "leaf", key: "a", type: "string", text: '"x"' },
    { kind: "leaf", key: "b", type: "number", text: "2" },
    { kind: "leaf", key: "c", type: "boolean", text: "true" },
    { kind: "leaf", key: "d", type: "null", text: "null" },
    {
      kind: "branch",
      key: "e",
      type: "array",
      size: 1,
      collapsed: false,
      children: [{ kind: "leaf", key: "0", type: "number", text: "1" }],
    },
    { kind: "branch", key: "f", type: "object", size: 0, collapsed: false, children: [] },
  ]);
  // Newlines and quotes stay escaped on one line; long strings are shortened.
  expect(jsonTree({ s: 'a\n"b"' })[0]).toMatchObject({ text: '"a\\n\\"b\\""' });
  expect(jsonTree({ s: "x".repeat(10) }, { maxString: 4 })[0]).toMatchObject({ text: '"xxxx…"' });
});

test("past the depth limit an object shows only its size", () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  let level = jsonTree(deep, { maxDepth: 3 })[0];
  const path: string[] = [];
  while (level?.kind === "branch" && !level.collapsed) {
    path.push(level.key ?? "");
    level = level.children[0];
  }
  expect(path).toEqual(["a", "b"]);
  expect(level).toEqual({
    kind: "branch",
    key: "c",
    type: "object",
    size: 1,
    children: [],
    collapsed: true,
  });
});

test("the node budget caps the tree and summarises what is left", () => {
  const wide = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, index]));
  const nodes = jsonTree(wide);
  expect(nodes).toHaveLength(JSON_TREE_NODES + 1);
  expect(nodes.at(-1)).toEqual({ kind: "more", count: 500 - JSON_TREE_NODES });
  // Nested lists share one budget, so a deep and wide value stays bounded too.
  const nested = { list: Array.from({ length: 50 }, () => ({ x: 1, y: [1, 2, 3] })) };
  const count = (items: JsonNode[]): number =>
    items.reduce(
      (total, item) => total + 1 + (item.kind === "branch" ? count(item.children) : 0),
      0,
    );
  expect(count(jsonTree(nested, { maxNodes: 40 }))).toBeLessThanOrEqual(40 + 10);
  expect(JSON.stringify(jsonTree(nested, { maxNodes: 40 }))).toContain('"kind":"more"');
  expect(jsonTree("plain")).toEqual([{ kind: "leaf", type: "string", text: '"plain"' }]);
});

test("sizes, counts and labels read as short Traditional Chinese", () => {
  expect(jsonSize("object", 3)).toBe("3 個欄位");
  expect(jsonSize("array", 2)).toBe("2 項");
  expect(fieldCount({ a: 1, b: 2 })).toBe(2);
  expect(fieldCount(undefined)).toBe(0);
  expect(callEyebrow({ tool })).toBe("MCP 結果 · 合成伺服器");
  expect(callEyebrow({ tool: { ...tool, server_name: "  " } })).toBe("MCP 結果");
  expect(callTitle({ tool })).toEqual({ text: "synthetic_tool", mono: true });
  expect(callTitle({ tool: { ...tool, title: "合成截圖" } })).toEqual({
    text: "合成截圖",
    mono: false,
  });
  expect(callText({ content })).toBe("第一段\n\n第二段");
  expect(callText({ content: [] })).toBe("");
});

test("the state pill uses the shared tone map and never claims verification", () => {
  expect(callState({ is_error: false })).toMatchObject({
    dataTone: "success",
    icon: "Check",
    label: "呼叫完成",
  });
  expect(callState({ is_error: true })).toMatchObject({
    dataTone: "danger",
    icon: "WarningCircle",
    label: "工具回報錯誤",
  });
  expect(
    JSON.stringify([callState({ is_error: false }), callState({ is_error: true })]),
  ).not.toMatch(/已驗證|安全/);
});

test("omitted media wins over the truncation line; complete results have none", () => {
  expect(callNotice({ content, truncated: false })).toBeUndefined();
  expect(callNotice({ content, truncated: true })).toBe("結果超過顯示上限，已省略部分內容。");
  expect(
    callNotice({
      content: [...content, { type: "media_omitted", media_type: "audio", byte_length: 9 }],
      truncated: true,
    }),
  ).toBe("1 個媒體結果未顯示（格式不支援或超過大小上限）。");
});

test("image sources are inline data for allowed types only", () => {
  expect(imageSource("image/png", "iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
  expect(imageSource("image/webp", "UklGRg")).toBe("data:image/webp;base64,UklGRg");
  expect(imageSource("image/svg+xml", "PHN2Zz4=")).toBeUndefined();
  expect(imageSource("image/png", 'abc" onerror="x')).toBeUndefined();
  expect(imageSource("image/png", "https://example.invalid/a.png")).toBeUndefined();
  expect(imageSource("image/png", "")).toBeUndefined();
});

test("tiny images grow by a whole factor to 64px; others keep their natural size", () => {
  expect(imageBox(1, 1)).toEqual({ width: 64, height: 64, tiny: true });
  expect(imageBox(10, 5)).toEqual({ width: 70, height: 35, tiny: true });
  expect(imageBox(63, 20)).toEqual({ width: 126, height: 40, tiny: true });
  expect(imageBox(64, 2)).toEqual({ width: 64, height: 2, tiny: false });
  expect(imageBox(1280, 720)).toEqual({ width: 1280, height: 720, tiny: false });
  expect(imageCaption({ width: 1280, height: 720, mimeType: "image/png", bytes: 188_416 })).toBe(
    "1280 × 720 · PNG · 184 KB",
  );
  expect(imageCaption({ width: 1, height: 1, mimeType: "image/webp" })).toBe("1 × 1 · WEBP");
});
