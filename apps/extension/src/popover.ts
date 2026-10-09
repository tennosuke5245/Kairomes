const MOVES_FOCUS =
  "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe, label, [contenteditable], [tabindex]:not([tabindex='-1'])";

/**
 * A nonmodal `.k-popover` anchored under the toolbar with position: fixed, so it can never
 * be clipped by a toolbar column (X5). Escape closes it and returns focus to the trigger;
 * Tab or a click elsewhere closes it without stealing focus back.
 */
export class Popover {
  private openState = false;

  constructor(
    private readonly trigger: HTMLButtonElement,
    private readonly panel: HTMLElement,
    private readonly options: {
      onOpen?: () => void;
      onClose?: () => void;
      /** Element focused on open; defaults to the panel. */
      initialFocus?: () => HTMLElement | null | undefined;
    } = {},
  ) {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", panel.id);
    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.openState) return;
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.openState) return;
      event.preventDefault();
      this.close(false);
    });
    document.addEventListener("focusin", (event) => {
      if (!this.openState || !(event.target instanceof Node)) return;
      if (!panel.contains(event.target) && !trigger.contains(event.target)) this.close(false);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!this.openState || !(event.target instanceof Node)) return;
      if (panel.contains(event.target) || trigger.contains(event.target)) return;
      const movingFocus = event.target instanceof Element && event.target.closest(MOVES_FOCUS);
      const restore = !movingFocus && panel.contains(document.activeElement);
      this.close(restore);
    });
    window.addEventListener("blur", () => {
      // Focusing the cross-origin workbench does not bubble focusin into this document.
      queueMicrotask(() => {
        if (this.openState && document.activeElement instanceof HTMLIFrameElement)
          this.close(false);
      });
    });
  }

  get isOpen() {
    return this.openState;
  }

  open() {
    if (this.openState || this.trigger.hidden) return;
    this.openState = true;
    this.panel.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    this.options.onOpen?.();
    (this.options.initialFocus?.() ?? this.panel).focus({ preventScroll: true });
  }

  close(restoreFocus = false) {
    if (!this.openState) return;
    this.openState = false;
    this.panel.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
    this.options.onClose?.();
    if (restoreFocus && !this.trigger.hidden) this.trigger.focus({ preventScroll: true });
  }

  toggle() {
    if (this.openState) this.close(true);
    else this.open();
  }
}
