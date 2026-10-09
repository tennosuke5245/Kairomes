// Reading lock (C7) and workbench shortcuts (C9), kept pure so bun:test can cover them
// without a DOM. The workbench follows the newest activity until the user starts reading.

/** Scrolling the timeline this far from the top is reading, so following pauses. */
export const TIMELINE_SCROLL_PAUSE = 24;

export function timelineScrollPauses(scrollTop: number) {
  return scrollTop > TIMELINE_SCROLL_PAUSE;
}

const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export interface KeyTarget {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** Typing surfaces (input, textarea, select, contenteditable) and the xterm screen. */
  editable: boolean;
}

/** Keyboard scrolling inside the inspector is reading too; typing in a field is not. */
export function readingKey(event: KeyTarget) {
  return !event.editable && !event.ctrlKey && !event.metaKey && scrollKeys.has(event.key);
}

export type WorkbenchShortcut = "toggle-follow" | "back" | "search";

/**
 * `f` toggles following, Esc closes the open detail, `/` focuses search. Ignored while
 * typing or in xterm, so none of them is ever forwarded to terminal_input.
 */
export function workbenchShortcut(
  event: KeyTarget,
  context: { detailOpen: boolean },
): WorkbenchShortcut | undefined {
  if (event.editable || event.ctrlKey || event.metaKey || event.altKey) return undefined;
  if (event.key === "Escape" && context.detailOpen) return "back";
  if (event.key === "f" || event.key === "F") return "toggle-follow";
  if (event.key === "/") return "search";
  return undefined;
}

export function liveStatus(following: boolean) {
  return following
    ? ({ state: "live", label: "即時" } as const)
    : ({ state: "paused", label: "已暫停跟隨" } as const);
}

/** Whether a DOM-like target is a typing surface. Structural so tests need no DOM. */
export function isEditableTarget(
  target: {
    closest?(selector: string): unknown;
    isContentEditable?: boolean;
  } | null,
) {
  if (!target?.closest) return false;
  return (
    !!target.isContentEditable ||
    !!target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], .xterm",
    )
  );
}
