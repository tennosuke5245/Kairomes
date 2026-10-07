import type { UiDataTone } from "@kairomes/protocol/ui-state";
import { visibleSegments } from "./approval-view.ts";
import { icon, type PanelIcon } from "./icons.ts";

// Thin DOM builders for the approval page. Every value is set through textContent or text
// nodes; nothing here parses markup, and no inline style is ever written (CSP style-src 'self').

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function textButton(label: string, className: string, iconName?: PanelIcon) {
  const button = el("button", className);
  button.type = "button";
  if (iconName) button.append(icon(iconName));
  button.append(el("span", undefined, label));
  return button;
}

export function iconButton(iconName: PanelIcon, label: string, className = "") {
  const button = el("button", `k-btn k-btn--quiet k-btn--icon ${className}`.trim());
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.append(icon(iconName, { size: "lg" }));
  return button;
}

/** Sets a button's visible label (the last span) without rebuilding its icon. */
export function setButtonLabel(button: HTMLButtonElement, label: string) {
  const span = button.querySelector("span:last-of-type");
  if (span && span.textContent !== label) span.textContent = label;
}

export function pill(
  tone: UiDataTone,
  iconName: PanelIcon | undefined,
  label: string,
  spin = false,
) {
  const element = el("span", "k-pill");
  element.dataset.tone = tone;
  if (iconName) element.append(icon(iconName, { spin }));
  element.append(el("span", undefined, label));
  return element;
}

/**
 * Appends reviewed text. Invisible, control and reordering characters are shown as marked
 * escapes (`U+202E`, `\n`) so a reviewer sees exactly what will run or be written.
 */
export function appendVisible(
  parent: HTMLElement,
  text: string,
  options: { keepTabs?: boolean; keepNewlines?: boolean; emptyLabel?: string } = {},
) {
  const segments = visibleSegments(text, options);
  if (!segments.length && options.emptyLabel) {
    parent.append(escapeMark(options.emptyLabel, "空字串"));
    return parent;
  }
  for (const segment of segments)
    parent.append(
      segment.escape
        ? escapeMark(segment.text, "不可見字元")
        : document.createTextNode(segment.text),
    );
  return parent;
}

function escapeMark(label: string, title: string) {
  const mark = el("span", "rq-esc", label);
  mark.title = title;
  return mark;
}

/** `<dl class="k-dl">` entry: label above, value below. */
export function fact(label: string, ...content: (Node | string)[]) {
  const wrapper = el("div");
  const term = el("dt", undefined, label);
  const value = el("dd");
  value.append(...content);
  wrapper.append(term, value);
  return wrapper;
}

/** A full, wrapping monospace value (never truncated). */
export function codebox(text: string) {
  return appendVisible(el("div", "k-codebox"), text, { emptyLabel: "空字串" });
}

/** Indexed argv cells; spaces inside an element stay visible, nothing is shortened. */
export function argvList(argv: readonly string[]) {
  const list = el("ol", "k-argv");
  argv.forEach((value, index) => {
    const item = el("li", "k-argv__item");
    item.append(
      el("span", "k-argv__idx", String(index)),
      appendVisible(el("span", "k-argv__val"), value, { emptyLabel: "空字串" }),
    );
    list.append(item);
  });
  return list;
}

export function workspaceTag(name: string, hue: number) {
  const tag = el("span", "k-tag");
  tag.dataset.ws = String(hue);
  tag.append(el("span", "rq-tag__name", name));
  return tag;
}

export function separator() {
  const dot = el("span", "k-sep", "·");
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

/**
 * A meta item after the first in an `.sp-meta` line: it carries its own leading ·, so a
 * wrapped line never ends with one, and the · of a line-start item falls in the clipped gutter.
 */
export function metaItem(...content: (Node | string)[]) {
  const item = el("span", "sp-meta__item");
  item.append(separator(), ...content);
  return item;
}

export function diffStatElement(additions: number, deletions: number) {
  const stat = el("span", "k-diff__stat");
  if (additions || !deletions) stat.append(el("span", "k-diff__plus", `+${additions}`));
  if (deletions) stat.append(el("span", "k-diff__minus", `−${deletions}`));
  stat.setAttribute("aria-label", `新增 ${additions} 行，刪除 ${deletions} 行`);
  return stat;
}
