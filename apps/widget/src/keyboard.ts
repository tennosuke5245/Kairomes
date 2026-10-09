import type { KeyTarget } from "./follow-model.ts";

// Keyboard navigation for the timeline and record lists (C9): a roving tabindex moved with
// ↑/↓ or j/k, Home and End; Enter is the row button's own activation. Ignored while typing
// and inside xterm, so a list key is never forwarded to terminal_input.

export type ListMove = "next" | "previous" | "first" | "last";

export function listMove(event: KeyTarget): ListMove | undefined {
  if (event.editable || event.ctrlKey || event.metaKey || event.altKey) return undefined;
  switch (event.key) {
    case "ArrowDown":
    case "j":
      return "next";
    case "ArrowUp":
    case "k":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return undefined;
  }
}

/** The index to focus after a move; stops at the ends instead of wrapping. */
export function movedIndex(move: ListMove, index: number, count: number) {
  if (count <= 0) return -1;
  if (move === "first") return 0;
  if (move === "last") return count - 1;
  const next = index + (move === "next" ? 1 : -1);
  return Math.max(0, Math.min(count - 1, next));
}

/** Which item keeps tabindex 0: the one the user last moved to, else the current, else the first. */
export function rovingIndex(items: readonly { active: boolean; current: boolean }[]) {
  if (!items.length) return -1;
  const active = items.findIndex((item) => item.active);
  if (active >= 0) return active;
  const current = items.findIndex((item) => item.current);
  return current >= 0 ? current : 0;
}
