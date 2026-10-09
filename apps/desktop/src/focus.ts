import { useEffect } from "react";

/**
 * Keyboard focus when a control disappears. An action can replace the button that ran it (a
 * new pairing link, a stopped Tunnel, the next setup step) and a status update can remove one;
 * the browser then drops focus to <body>. These helpers put it back on purpose.
 *
 * Markup: a region whose controls replace one another carries `data-focus-scope`; inside it,
 * `data-focus-target="1"` marks a control focus may land on and `data-focus-target="2"` a
 * heading or sentence (with tabIndex -1) to fall back to.
 */
export const FOCUS_SCOPE = "data-focus-scope";
export const FOCUS_TARGET = "data-focus-target";

/** Spread on a region's root. */
export const focusScope = { [FOCUS_SCOPE]: "" } as const;
/** Spread on a control focus may move to inside its region. */
export const focusControl = { [FOCUS_TARGET]: "1" } as const;
/** Spread on a heading or sentence focus falls back to; it needs tabIndex -1. */
export const focusHeading = { [FOCUS_TARGET]: "2", tabIndex: -1 } as const;

export type FocusCandidate = { priority: number; usable: boolean };

/** The candidate to focus: the lowest priority that can take focus, the first one in order. */
export function pickFocusTarget<T extends FocusCandidate>(candidates: readonly T[]): T | null {
  let best: T | null = null;
  for (const candidate of candidates)
    if (candidate.usable && (best === null || candidate.priority < best.priority)) best = candidate;
  return best;
}

/**
 * Whether focus was lost rather than moved: the element that had it has left the document and
 * nothing else holds it. A press on empty space clears the remembered element first, so focus
 * the user put down on purpose is never taken back.
 */
export function focusLost(
  remembered: { isConnected: boolean } | null,
  active: unknown,
  body: unknown,
): boolean {
  return remembered !== null && !remembered.isConnected && (active === null || active === body);
}

function usable(element: HTMLElement) {
  return (
    element.isConnected &&
    !element.matches(":disabled") &&
    element.getAttribute("aria-hidden") !== "true" &&
    element.getClientRects().length > 0
  );
}

/**
 * Watches the document while mounted. When the focused element is removed, focus moves to the
 * best target left in its region, else to `fallback` (the page title). It waits one frame, so
 * a component that moves focus itself (a dialog, the handoff steps) goes first.
 */
export function useFocusRescue(fallback: string) {
  useEffect(() => {
    let remembered: HTMLElement | null = null;
    let scope: HTMLElement | null = null;
    let frame = 0;
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === document.body) return;
      remembered = target;
      scope = target.closest<HTMLElement>(`[${FOCUS_SCOPE}]`);
    };
    const forget = () => {
      remembered = null;
      scope = null;
    };
    const rescue = () => {
      frame = 0;
      if (!focusLost(remembered, document.activeElement, document.body)) return;
      const region = scope?.isConnected ? scope : null;
      const candidates = [
        ...(region?.querySelectorAll<HTMLElement>(`[${FOCUS_TARGET}]`) ?? []),
      ].map((element) => ({
        element,
        priority: Number(element.getAttribute(FOCUS_TARGET)) || 9,
        usable: usable(element),
      }));
      const target = pickFocusTarget(candidates)?.element ?? document.querySelector(fallback);
      forget();
      if (target instanceof HTMLElement) target.focus();
    };
    const observer = new MutationObserver(() => {
      if (remembered && !remembered.isConnected && !frame) frame = requestAnimationFrame(rescue);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("focusin", remember);
    document.addEventListener("pointerdown", forget, true);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("focusin", remember);
      document.removeEventListener("pointerdown", forget, true);
    };
  }, [fallback]);
}
