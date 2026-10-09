import { type PanelIcon, setIcon } from "./icons.ts";
import {
  NOTICE_SUCCESS_MS,
  type NoticeTone,
  type PanelNotice,
  sameNotice,
  visibleNotice,
} from "./panel-error.ts";

const toneIcons: Record<NoticeTone, PanelIcon> = {
  danger: "WarningCircle",
  warning: "Warning",
  success: "CheckCircle",
  neutral: "Info",
};

/**
 * The panel's one notice slot under the toolbar. A recovery notice (stale snapshot,
 * unconfirmed result, invalid pairing) outranks a transient one; a new transient notice
 * replaces the old; success dismisses itself; repeats are not re-rendered or re-announced.
 */
export class NoticeSlot {
  private recovery?: PanelNotice;
  private transient?: PanelNotice;
  private shown?: PanelNotice;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly root: HTMLElement,
    private readonly parts: {
      icon: SVGSVGElement;
      message: HTMLElement;
      action: HTMLButtonElement;
      close: HTMLButtonElement;
    },
    /** Where focus goes when the focused notice disappears. */
    private readonly fallbackFocus: () => HTMLElement | undefined = () => undefined,
  ) {
    parts.close.addEventListener("click", () => this.flash(undefined));
  }

  get current() {
    return this.shown;
  }

  /** The persistent recovery state; undefined once it is resolved. */
  setRecovery(notice: PanelNotice | undefined) {
    this.recovery = notice;
    this.render();
  }

  /** A one-off message (pairing errors, unpair result, a success line). */
  flash(notice: PanelNotice | undefined) {
    clearTimeout(this.timer);
    this.transient = notice;
    if (notice?.tone === "success")
      this.timer = setTimeout(() => {
        if (this.transient === notice) this.flash(undefined);
      }, NOTICE_SUCCESS_MS);
    this.render();
  }

  private render() {
    const next = visibleNotice(this.recovery, this.transient);
    if (sameNotice(next, this.shown)) return;
    this.shown = next;
    const { icon, message, action, close } = this.parts;
    const hadFocus = this.root.contains(document.activeElement);
    this.root.hidden = !next;
    if (!next) {
      message.textContent = "";
      action.hidden = close.hidden = true;
      if (hadFocus) this.fallbackFocus()?.focus({ preventScroll: true });
      return;
    }
    this.root.dataset.tone = next.tone;
    setIcon(icon, toneIcons[next.tone]);
    // Danger interrupts; everything else is polite (spec §4 Notice). Set before the text.
    const role = next.tone === "danger" ? "alert" : "status";
    if (message.getAttribute("role") !== role) message.setAttribute("role", role);
    message.textContent = next.message;
    action.hidden = !next.action;
    if (next.action) {
      action.textContent = next.action.label;
      action.dataset.action = next.action.kind;
    } else delete action.dataset.action;
    // Recovery notices stay until resolved; only a transient notice can be dismissed.
    close.hidden = next === this.recovery || next.tone === "success";
  }
}
