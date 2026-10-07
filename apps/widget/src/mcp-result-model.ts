// MCP result card (design spec §5.4, C12): pure data for the ChatGPT result card. No DOM;
// mcp-result-view.ts turns this into nodes and mounts them with textContent only.
import type { McpCall } from "@kairomes/protocol";
import { toneFor, type UiState } from "@kairomes/protocol/ui-state";
import { formatBytes, formatDimensions } from "./file-model.ts";

/** Nested levels shown in a JSON tree; deeper objects show only their size. */
export const JSON_TREE_DEPTH = 4;
/** Values rendered per tree; the rest is summarised as 其餘 N 項未顯示. */
export const JSON_TREE_NODES = 200;
/** Characters shown per string value. */
export const JSON_STRING_MAX = 400;
/** Below this edge length (both sides) an image is enlarged with crisp pixels. */
export const TINY_IMAGE = 64;

export type JsonLeafType = "string" | "number" | "boolean" | "null";
export type JsonNode =
  | { kind: "leaf"; key?: string; type: JsonLeafType; text: string }
  | {
      kind: "branch";
      key?: string;
      type: "object" | "array";
      size: number;
      children: JsonNode[];
      /** Past the depth limit: the size is shown, the children are not. */
      collapsed: boolean;
    }
  | { kind: "more"; count: number };

/** 3 個欄位 for objects, 3 項 for arrays. */
export function jsonSize(type: "object" | "array", size: number) {
  return type === "array" ? `${size} 項` : `${size} 個欄位`;
}

function leaf(key: string | undefined, value: unknown, maxString: number): JsonNode {
  if (typeof value === "string") {
    const shown = value.length > maxString ? `${value.slice(0, maxString)}…` : value;
    return { kind: "leaf", key, type: "string", text: JSON.stringify(shown) };
  }
  if (typeof value === "number" || typeof value === "boolean")
    return { kind: "leaf", key, type: typeof value as "number" | "boolean", text: String(value) };
  return { kind: "leaf", key, type: "null", text: "null" };
}

/**
 * A depth- and size-limited tree of a JSON value. Strings are quoted and shortened, objects
 * past `maxDepth` keep only their size, and once `maxNodes` values are used every remaining
 * sibling list ends in one `more` entry.
 */
export function jsonTree(
  value: unknown,
  {
    maxDepth = JSON_TREE_DEPTH,
    maxNodes = JSON_TREE_NODES,
    maxString = JSON_STRING_MAX,
  }: { maxDepth?: number; maxNodes?: number; maxString?: number } = {},
): JsonNode[] {
  let budget = maxNodes;
  const entries = (item: object): [string, unknown][] =>
    Array.isArray(item) ? item.map((child, index) => [String(index), child]) : Object.entries(item);
  const build = (key: string | undefined, item: unknown, depth: number): JsonNode => {
    budget--;
    if (item === null || typeof item !== "object") return leaf(key, item, maxString);
    const children = entries(item);
    const type = Array.isArray(item) ? "array" : "object";
    if (depth >= maxDepth && children.length)
      return { kind: "branch", key, type, size: children.length, children: [], collapsed: true };
    return {
      kind: "branch",
      key,
      type,
      size: children.length,
      children: list(children, depth + 1),
      collapsed: false,
    };
  };
  const list = (items: [string, unknown][], depth: number): JsonNode[] => {
    const nodes: JsonNode[] = [];
    for (const [index, [key, item]] of items.entries()) {
      if (budget <= 0) {
        nodes.push({ kind: "more", count: items.length - index });
        break;
      }
      nodes.push(build(key, item, depth));
    }
    return nodes;
  };
  if (value === null || typeof value !== "object") return [build(undefined, value, 1)];
  return list(entries(value), 1);
}

/** Top-level field count of a record (arguments, structured content). */
export function fieldCount(value: Record<string, unknown> | undefined) {
  return value ? Object.keys(value).length : 0;
}

/** 呼叫完成 or 工具回報錯誤, with the shared tone and icon (colour is never the only signal). */
export function callState(call: Pick<McpCall, "is_error">): UiState {
  return call.is_error
    ? { ...toneFor("tool", "error"), label: "工具回報錯誤" }
    : { ...toneFor("tool", "completed"), label: "呼叫完成" };
}

/** MCP 結果 · <server>: one line, ellipsized by the card. */
export function callEyebrow(call: Pick<McpCall, "tool">) {
  const server = call.tool.server_name.trim();
  return server ? `MCP 結果 · ${server}` : "MCP 結果";
}

/** The human title when the server gives one, else the tool name in mono. */
export function callTitle(call: Pick<McpCall, "tool">) {
  const title = call.tool.title?.trim();
  return title ? { text: title, mono: false } : { text: call.tool.name, mono: true };
}

/** The text a tool returned, joined in order; empty when it returned none. */
export function callText(call: Pick<McpCall, "content">) {
  return call.content
    .filter(
      (item): item is Extract<McpCall["content"][number], { type: "text" }> => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n\n");
}

/** One warning line for omitted media or a truncated result; none when nothing was cut. */
export function callNotice(call: Pick<McpCall, "content" | "truncated">) {
  const omitted = call.content.filter((item) => item.type === "media_omitted").length;
  if (omitted) return `${omitted} 個媒體結果未顯示（格式不支援或超過大小上限）。`;
  if (call.truncated) return "結果超過顯示上限，已省略部分內容。";
  return undefined;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A data: URL only for an allowed image type with well-formed base64; never a remote URL. */
export function imageSource(mimeType: string, data: string) {
  return IMAGE_TYPES.has(mimeType) && BASE64.test(data)
    ? `data:${mimeType};base64,${data}`
    : undefined;
}

/**
 * The box an image is drawn in: its natural size (the card caps the width and keeps the
 * aspect ratio), or, when both sides are under 64px, an integer enlargement drawn with crisp
 * pixels instead of a stretched blur.
 */
export function imageBox(width: number, height: number, min = TINY_IMAGE) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w >= min || h >= min) return { width: w, height: h, tiny: false };
  const scale = Math.ceil(min / Math.max(w, h));
  return { width: w * scale, height: h * scale, tiny: true };
}

/** 1280 × 720 · PNG · 184 KB (the size only when it is known). */
export function imageCaption(image: {
  width: number;
  height: number;
  mimeType: string;
  bytes?: number;
}) {
  return [
    formatDimensions(image.width, image.height),
    image.mimeType.replace("image/", "").toUpperCase(),
    ...(image.bytes ? [formatBytes(image.bytes)] : []),
  ].join(" · ");
}
