// MCP result card view (design spec §5.4, C12). Builders return plain nodes so bun:test can
// check the card without a DOM; mountView creates elements with textContent only (never
// innerHTML) and allows a fixed attribute list. The card never calls back to the server.
import type { Artifact, McpCall } from "@kairomes/protocol";
import type { UiState, UiStateIcon } from "@kairomes/protocol/ui-state";
import { copyAnnouncement } from "./copy.ts";
import { CARD_ICON_PATHS, type CardIcon, K_MARK_PATHS } from "./icon-paths.ts";
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
  type JsonNode,
  jsonSize,
  jsonTree,
} from "./mcp-result-model.ts";
import { formatDuration } from "./time-format.ts";

export type ViewAction = { kind: "toggle"; target: string } | { kind: "copy"; text: string };

export interface ViewNode {
  tag: string;
  className?: string;
  /** Set with textContent; a node has text or children, not both. */
  text?: string;
  attrs?: Record<string, string>;
  children?: ViewNode[];
  /** For tag "svg": a card icon, or the K mark. */
  icon?: CardIcon | "KMark";
  action?: ViewAction;
}

/** An image the host delivered with the tool result (base64, never a URL). */
export interface HostImage {
  mimeType: string;
  data: string;
}

export const TEXT_ID = "mr-text";
const COPY_STATUS_ID = "mr-copy-status";

const node = (
  tag: string,
  className?: string,
  children?: ViewNode[],
  extra: Partial<ViewNode> = {},
): ViewNode => ({ tag, className, children, ...extra });
const text = (tag: string, className: string | undefined, value: string, extra = {}) =>
  node(tag, className, undefined, { text: value, ...extra });
const icon = (name: CardIcon, size?: "sm"): ViewNode => ({
  tag: "svg",
  className: "k-icon",
  icon: name,
  attrs: size ? { "data-size": size } : undefined,
});

const stateIcons: Partial<Record<UiStateIcon, CardIcon>> = {
  Check: "Check",
  WarningCircle: "WarningCircle",
};

function pill(state: UiState): ViewNode {
  return node(
    "span",
    "k-pill mr-pill",
    [icon(stateIcons[state.icon] ?? "Info"), text("span", undefined, state.label)],
    {
      attrs: { "data-tone": state.dataTone },
    },
  );
}

function head(eyebrow: string, state?: UiState): ViewNode {
  return node("div", "mr-head", [
    { tag: "svg", className: "k-logo", icon: "KMark" },
    text("span", "mr-eyebrow", eyebrow, { attrs: { title: eyebrow } }),
    ...(state ? [pill(state)] : []),
  ]);
}

function title(value: { text: string; mono: boolean }, meta?: string): ViewNode {
  return node("h1", "mr-title", [
    text("span", value.mono ? "mr-title__text k-mono" : "mr-title__text", value.text),
    ...(meta ? [text("span", "k-meta mr-title__meta", meta)] : []),
  ]);
}

function figure(
  image: HostImage,
  size: { width: number; height: number; mimeType: string; bytes?: number } | undefined,
  alt: string,
): ViewNode | undefined {
  const source = imageSource(image.mimeType, image.data);
  if (!source) return undefined;
  const box = size ? imageBox(size.width, size.height) : undefined;
  return node("figure", "mr-img", [
    node("div", "mr-img__stage", [
      node("img", undefined, undefined, {
        attrs: {
          src: source,
          alt,
          ...(box
            ? {
                width: String(box.width),
                height: String(box.height),
                ...(box.tiny ? { "data-tiny": "" } : {}),
              }
            : {}),
        },
      }),
    ]),
    text(
      "figcaption",
      "mr-img__caption",
      size ? imageCaption(size) : image.mimeType.replace("image/", "").toUpperCase(),
    ),
  ]);
}

/** Long text is clamped with a fade; 展開全部／收合 and 複製文字 sit under it. */
function textBlock(value: string, error: boolean): ViewNode {
  return node("div", "mr-textblock", [
    node("div", "mr-text", [text("div", "mr-text__body", value)], {
      attrs: { id: TEXT_ID, "data-tone": error ? "danger" : "neutral", "data-expanded": "false" },
    }),
    node("div", "mr-actions", [
      node(
        "button",
        "k-btn k-btn--quiet k-btn--sm mr-toggle",
        [icon("CaretDown", "sm"), text("span", undefined, "展開全部")],
        {
          attrs: {
            type: "button",
            id: `${TEXT_ID}-toggle`,
            "aria-expanded": "false",
            "aria-controls": TEXT_ID,
          },
          action: { kind: "toggle", target: TEXT_ID },
        },
      ),
      node(
        "button",
        "k-btn k-btn--quiet k-btn--sm mr-copy",
        [icon("Copy", "sm"), text("span", undefined, "複製文字")],
        { attrs: { type: "button" }, action: { kind: "copy", text: value } },
      ),
      text("span", "k-sr-only", "", {
        attrs: { id: COPY_STATUS_ID, role: "status", "aria-live": "polite" },
      }),
    ]),
  ]);
}

function notice(tone: "warning" | "neutral", value: string): ViewNode {
  return node(
    "p",
    "k-notice mr-notice",
    [icon(tone === "warning" ? "WarningCircle" : "Info"), text("span", "k-notice__body", value)],
    { attrs: { "data-tone": tone, role: "status" } },
  );
}

function treeNodes(nodes: JsonNode[]): ViewNode[] {
  return nodes.map((item): ViewNode => {
    if (item.kind === "more") return text("div", "mr-more", `其餘 ${item.count} 項未顯示`);
    const key = item.key === undefined ? [] : [text("span", "mr-key", item.key)];
    if (item.kind === "leaf")
      return node("div", "mr-leaf", [
        ...key,
        text("span", "mr-val", item.text, { attrs: { "data-type": item.type } }),
      ]);
    const open = item.type === "array" ? "[" : "{";
    if (!item.size)
      return node("div", "mr-leaf", [
        ...key,
        text("span", "mr-val", item.type === "array" ? "[]" : "{}", {
          attrs: { "data-type": "null" },
        }),
      ]);
    if (item.collapsed)
      return node("div", "mr-leaf", [
        ...key,
        text(
          "span",
          "mr-count",
          `${open}…${open === "[" ? "]" : "}"} ${jsonSize(item.type, item.size)}`,
        ),
      ]);
    return node("details", "mr-node", [
      node("summary", undefined, [
        icon("CaretRight", "sm"),
        ...key,
        text("span", "mr-count", jsonSize(item.type, item.size)),
      ]),
      node("div", "mr-node__children", treeNodes(item.children)),
    ]);
  });
}

function disclosure(label: string, meta: string, value: Record<string, unknown>): ViewNode {
  const nodes = jsonTree(value);
  return node("details", "mr-details", [
    node("summary", undefined, [
      icon("CaretRight", "sm"),
      text("span", "mr-details__label", label),
      text("span", "k-meta", meta),
    ]),
    nodes.length
      ? node("div", "mr-json", treeNodes(nodes))
      : text("p", "mr-json mr-json--empty", "沒有內容"),
  ]);
}

function card(children: (ViewNode | undefined)[]): ViewNode {
  return node(
    "article",
    "k-card k-card--flat mr-card",
    children.filter((item): item is ViewNode => !!item),
  );
}

/**
 * An MCP tool result. A tool error puts its text first (right under the title); otherwise
 * images lead. Arguments and structured content are disclosures with depth-limited trees.
 */
export function callView(call: McpCall, images: readonly HostImage[]): ViewNode {
  const state = callState(call);
  const label = callTitle(call);
  const sizes = call.content
    .filter(
      (item): item is Extract<McpCall["content"][number], { type: "image" }> =>
        item.type === "image",
    )
    .map((item) => ({
      width: item.width,
      height: item.height,
      mimeType: item.mime_type,
      bytes: item.byte_length,
    }));
  const gallery = images.length
    ? node(
        "div",
        "mr-gallery",
        images
          .map((image, index) =>
            figure(image, sizes[index], `${label.text} 的圖片結果 ${index + 1}`),
          )
          .filter((item): item is ViewNode => !!item),
      )
    : undefined;
  const output = callText(call);
  const outputBlock = output ? textBlock(output, call.is_error) : undefined;
  const cut = callNotice(call);
  const argumentCount = fieldCount(call.arguments_preview);
  return card([
    head(callEyebrow(call), state),
    title(label, formatDuration(call.duration_ms)),
    ...(call.is_error ? [outputBlock, gallery] : [gallery, outputBlock]),
    cut ? notice("warning", cut) : undefined,
    node("div", "mr-disclosures", [
      disclosure(
        "呼叫內容",
        argumentCount ? `${argumentCount} 個參數` : "沒有參數",
        call.arguments_preview,
      ),
      ...(call.structured_content
        ? [
            disclosure(
              "結構化結果",
              `JSON · ${fieldCount(call.structured_content)} 個欄位`,
              call.structured_content,
            ),
          ]
        : []),
    ]),
  ]);
}

/** artifact_preview: a workspace image shown read-only. */
export function artifactView(artifact: Artifact, images: readonly HostImage[]): ViewNode {
  const slash = Math.max(artifact.path.lastIndexOf("/"), artifact.path.lastIndexOf("\\"));
  const name = artifact.path.slice(slash + 1) || artifact.path;
  const directory = slash > 0 ? artifact.path.slice(0, slash) : "";
  const image = images[0];
  const shown =
    image &&
    figure(
      image,
      {
        width: artifact.width,
        height: artifact.height,
        mimeType: artifact.mime_type,
        bytes: artifact.byte_size,
      },
      `工作區圖片 ${artifact.path}`,
    );
  return card([
    head("圖片預覽"),
    title({ text: name, mono: true }, directory || undefined),
    shown ?? notice("neutral", "圖片沒有送到這張卡片；請在 Kairomes 工作台查看。"),
  ]);
}

/** Neither an MCP call nor an image: one neutral line. */
export function emptyView(): ViewNode {
  return card([head("MCP 結果"), notice("neutral", "沒有可顯示的結果。")]);
}

// ---------------------------------------------------------------------------------------
// Mounting: the only place nodes become elements.

/** The few document methods mountView uses (a real Document, or a test double). */
export interface ViewDocument {
  createElement(tag: string): ViewElement;
  createElementNS(namespace: string, tag: string): ViewElement;
}
export interface ViewElement {
  className: string;
  textContent: string | null;
  append(...nodes: ViewElement[]): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: "click", listener: () => void): void;
  readonly lastElementChild: ViewElement | null;
}

const SVG = "http://www.w3.org/2000/svg";
const ATTRIBUTES =
  /^(?:aria-(?:controls|expanded|live|label)|data-(?:tone|type|tiny|expanded|size)|role|title|alt|src|width|height|type|id)$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function svg(doc: ViewDocument, view: ViewNode): ViewElement {
  const element = doc.createElementNS(SVG, "svg");
  const glyph = view.icon;
  const logo = glyph === "KMark";
  element.setAttribute("viewBox", logo ? "0 0 128 128" : "0 0 256 256");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("focusable", "false");
  element.setAttribute("class", view.className ?? "k-icon");
  if (view.attrs?.["data-size"]) element.setAttribute("data-size", view.attrs["data-size"]);
  const paths = glyph === "KMark" ? K_MARK_PATHS : glyph ? [CARD_ICON_PATHS[glyph]] : [];
  for (const d of paths) {
    const path = doc.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    element.append(path);
  }
  return element;
}

/**
 * Creates the elements for a view. Text goes through textContent, attributes must be on the
 * allow list and an image source must be an inline data: image, so tool output can never
 * become markup, a script or a network request. `copy` writes the clipboard on a click.
 */
export function mountView(
  doc: ViewDocument,
  view: ViewNode,
  copy: (value: string) => Promise<boolean>,
): ViewElement {
  const byId = new Map<string, ViewElement>();
  const actions: Array<[ViewElement, ViewAction]> = [];
  const create = (item: ViewNode): ViewElement => {
    if (item.tag === "svg") return svg(doc, item);
    const element = doc.createElement(item.tag);
    if (item.className) element.className = item.className;
    for (const [name, value] of Object.entries(item.attrs ?? {})) {
      if (!ATTRIBUTES.test(name)) throw new Error(`Attribute not allowed: ${name}`);
      if (name === "src" && !DATA_IMAGE.test(value)) throw new Error("Image source not allowed");
      element.setAttribute(name, value);
    }
    if (item.attrs?.id) byId.set(item.attrs.id, element);
    if (item.text !== undefined) element.textContent = item.text;
    else for (const child of item.children ?? []) element.append(create(child));
    if (item.action) actions.push([element, item.action]);
    return element;
  };
  const root = create(view);
  for (const [button, action] of actions) {
    const label = button.lastElementChild;
    if (action.kind === "toggle") {
      button.addEventListener("click", () => {
        const target = byId.get(action.target);
        const expanded = target?.getAttribute("data-expanded") !== "true";
        target?.setAttribute("data-expanded", String(expanded));
        button.setAttribute("aria-expanded", String(expanded));
        if (label) label.textContent = expanded ? "收合" : "展開全部";
      });
    } else {
      let reset: ReturnType<typeof setTimeout> | undefined;
      button.addEventListener("click", () => {
        void copy(action.text).then((copied) => {
          const status = byId.get(COPY_STATUS_ID);
          if (label) label.textContent = copied ? "已複製" : "無法複製";
          if (status) status.textContent = copyAnnouncement(copied ? "copied" : "failed");
          clearTimeout(reset);
          reset = setTimeout(() => {
            if (label) label.textContent = "複製文字";
            if (status) status.textContent = "";
          }, 2000);
        });
      });
    }
  }
  return root;
}
