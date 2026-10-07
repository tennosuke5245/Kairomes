import { expect, test } from "bun:test";
import type { Artifact, McpCall } from "@kairomes/protocol";
import {
  artifactView,
  callView,
  emptyView,
  mountView,
  TEXT_ID,
  type ViewDocument,
  type ViewElement,
  type ViewNode,
} from "./mcp-result-view.ts";

const call: McpCall = {
  kind: "mcp_call",
  request_id: "00000005-0000-4000-8000-000000000010",
  catalog_revision: "synthetic",
  tool: {
    ref: "synthetic:tool",
    server_id: "00000006-0000-4000-8000-000000000010",
    server_name: "合成伺服器",
    name: "synthetic_capture",
  },
  is_error: false,
  arguments_preview: { tab: "tab-1", options: { full: false } },
  duration_ms: 812,
  content: [
    { type: "text", text: "合成結果" },
    {
      type: "image",
      media_id: "00000007-0000-4000-8000-000000000010",
      mime_type: "image/png",
      byte_length: 70,
      width: 1,
      height: 1,
    },
  ],
  structured_content: { title: "合成", nested: { a: 1 } },
  truncated: false,
};
const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };

/** Depth-first list of nodes matching a class name. */
function find(view: ViewNode, className: string): ViewNode[] {
  const own = view.className?.split(" ").includes(className) ? [view] : [];
  return [...own, ...(view.children ?? []).flatMap((child) => find(child, className))];
}
const texts = (view: ViewNode): string[] => [
  ...(view.text ? [view.text] : []),
  ...(view.children ?? []).flatMap(texts),
];
const order = (view: ViewNode) =>
  (view.children ?? []).map((child) => child.className?.split(" ").at(-1));

test("a completed call leads with images, then the text, then two disclosures", () => {
  const view = callView(call, [png]);
  expect(view.className).toContain("mr-card");
  expect(order(view)).toEqual([
    "mr-head",
    "mr-title",
    "mr-gallery",
    "mr-textblock",
    "mr-disclosures",
  ]);
  const words = texts(view);
  expect(words).toContain("MCP 結果 · 合成伺服器");
  expect(words).toContain("呼叫完成");
  expect(words).toContain("synthetic_capture");
  expect(words).toContain("0.8 秒");
  expect(words).toContain("1 × 1 · PNG · 70 B");
  expect(words).toContain("展開全部");
  expect(words).toContain("複製文字");
  expect(words).toContain("2 個參數");
  expect(words).toContain("JSON · 2 個欄位");
  expect(words.join("")).not.toMatch(/KAIROMES|MCP RESULT|MEDIA PREVIEW|安全預覽/);
  const pill = find(view, "k-pill")[0];
  expect(pill?.attrs?.["data-tone"]).toBe("success");
  expect(pill?.children?.[0]).toMatchObject({ tag: "svg", icon: "Check" });
  // The 1 × 1 image is drawn enlarged with crisp pixels, not stretched to the card.
  const image = find(view, "mr-img__stage")[0]?.children?.[0];
  expect(image?.attrs).toMatchObject({ width: "64", height: "64", "data-tiny": "" });
  expect(image?.attrs?.src).toBe("data:image/png;base64,iVBORw0KGgo=");
});

test("a tool error puts its text first, tinted danger, under a danger pill", () => {
  const view = callView({ ...call, is_error: true, duration_ms: 23 }, [png]);
  expect(order(view)).toEqual([
    "mr-head",
    "mr-title",
    "mr-textblock",
    "mr-gallery",
    "mr-disclosures",
  ]);
  expect(find(view, "k-pill")[0]?.attrs?.["data-tone"]).toBe("danger");
  expect(find(view, "mr-text")[0]?.attrs).toMatchObject({ id: TEXT_ID, "data-tone": "danger" });
  expect(texts(view)).toContain("工具回報錯誤");
  expect(texts(view)).toContain("不到 0.1 秒");
});

test("cut results get one warning line; images the host did not send are left out", () => {
  const view = callView({ ...call, truncated: true, content: [call.content[0] as never] }, []);
  expect(find(view, "mr-gallery")).toEqual([]);
  expect(find(view, "mr-notice")[0]?.attrs?.["data-tone"]).toBe("warning");
  expect(texts(view)).toContain("結果超過顯示上限，已省略部分內容。");
  // An image with a type the card does not allow is dropped, not shown as a broken frame.
  const odd = callView(call, [{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }]);
  expect(find(odd, "mr-img")).toEqual([]);
  // No text, no clamp controls; no arguments reads 沒有參數.
  const bare = callView({ ...call, content: [], arguments_preview: {} }, []);
  expect(find(bare, "mr-textblock")).toEqual([]);
  expect(texts(bare)).toContain("沒有參數");
});

test("artifact previews and empty results stay one short card", () => {
  const artifact: Artifact = {
    kind: "artifact",
    artifact_id: "a".repeat(64),
    workspace_id: "00000000-0000-4000-8000-000000000010",
    path: "assets/cover.png",
    media_kind: "image",
    mime_type: "image/png",
    byte_size: 8126,
    width: 128,
    height: 128,
    version: "b".repeat(64),
    modified_at: 0,
    previewable: true,
  };
  const shown = texts(artifactView(artifact, [png]));
  expect(shown).toEqual(
    expect.arrayContaining(["圖片預覽", "cover.png", "assets", "128 × 128 · PNG · 7.9 KB"]),
  );
  expect(texts(artifactView(artifact, []))).toContain(
    "圖片沒有送到這張卡片；請在 Kairomes 工作台查看。",
  );
  expect(texts(emptyView())).toEqual(["MCP 結果", "沒有可顯示的結果。"]);
});

// ---------------------------------------------------------------------------------------
// A minimal document double: enough to prove mountView only ever sets textContent.

class FakeElement implements ViewElement {
  className = "";
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners: Array<() => void> = [];
  #text: string | null = null;
  constructor(
    readonly tagName: string,
    readonly namespace = "html",
  ) {}
  get textContent() {
    return this.#text ?? this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string | null) {
    this.children.length = 0;
    this.#text = value;
  }
  set innerHTML(_value: string) {
    throw new Error("innerHTML is never used");
  }
  get lastElementChild(): FakeElement | null {
    return this.children.at(-1) ?? null;
  }
  append(...nodes: ViewElement[]) {
    this.children.push(...(nodes as FakeElement[]));
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(_type: "click", listener: () => void) {
    this.listeners.push(listener);
  }
  click() {
    for (const listener of this.listeners) listener();
  }
  all(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}
const fakeDocument: ViewDocument = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_namespace, tag) => new FakeElement(tag, "svg"),
};

test("mounting turns untrusted text into text, never into elements", () => {
  const hostile = "<img src=x onerror=alert(1)><script>alert(2)</script>";
  const view = callView(
    {
      ...call,
      tool: { ...call.tool, server_name: hostile, name: hostile },
      content: [{ type: "text", text: hostile }],
      arguments_preview: { [hostile]: hostile },
    },
    [],
  );
  const root = mountView(fakeDocument, view, async () => true) as FakeElement;
  const tags = new Set(root.all().map((element) => element.tagName));
  expect(tags.has("img")).toBe(false);
  expect(tags.has("script")).toBe(false);
  expect(root.textContent).toContain(hostile);
  const svgs = root.all().filter((element) => element.namespace === "svg");
  expect(svgs.length).toBeGreaterThan(0);
  expect(svgs.every((element) => ["svg", "path"].includes(element.tagName))).toBe(true);
});

test("mounting refuses attributes and image sources outside the allow list", () => {
  const card = (attrs: Record<string, string>): ViewNode => ({ tag: "div", attrs });
  expect(() => mountView(fakeDocument, card({ onclick: "x" }), async () => true)).toThrow(
    "Attribute not allowed",
  );
  expect(() => mountView(fakeDocument, card({ style: "x" }), async () => true)).toThrow(
    "Attribute not allowed",
  );
  expect(() =>
    mountView(
      fakeDocument,
      { tag: "img", attrs: { src: "https://example.invalid/x.png" } },
      async () => true,
    ),
  ).toThrow("Image source not allowed");
  expect(() =>
    mountView(
      fakeDocument,
      { tag: "img", attrs: { src: "data:image/svg+xml;base64,PHN2Zz4=" } },
      async () => true,
    ),
  ).toThrow("Image source not allowed");
});

test("展開全部 toggles the clamp and 複製文字 copies the whole text once per press", async () => {
  const copied: string[] = [];
  const root = mountView(fakeDocument, callView(call, []), async (value) => {
    copied.push(value);
    return true;
  }) as FakeElement;
  const elements = root.all();
  const block = elements.find((element) => element.getAttribute("id") === TEXT_ID);
  const toggle = elements.find((element) => element.className.includes("mr-toggle"));
  const copy = elements.find((element) => element.className.includes("mr-copy"));
  const status = elements.find((element) => element.getAttribute("role") === "status");
  expect(block?.getAttribute("data-expanded")).toBe("false");
  toggle?.click();
  expect(block?.getAttribute("data-expanded")).toBe("true");
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  expect(toggle?.lastElementChild?.textContent).toBe("收合");
  toggle?.click();
  expect(block?.getAttribute("data-expanded")).toBe("false");
  expect(toggle?.lastElementChild?.textContent).toBe("展開全部");
  copy?.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(copied).toEqual(["合成結果"]);
  expect(copy?.lastElementChild?.textContent).toBe("已複製");
  expect(status?.textContent).toBe("已複製");
});
