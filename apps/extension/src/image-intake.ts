import { el } from "./approval-dom.ts";
import { icon } from "./icons.ts";
import {
  copyImageMenuLabel,
  type DragKind,
  dragKind,
  dropEffectFor,
  imageFromTransfer,
} from "./image-transfer.ts";

// Panel-wide paste and drag-and-drop of images. Real user events only: a paste needs the
// clipboard's own files, a drop needs the dragged files; a link or markup (an <img> dragged out
// of a web page) carries no bytes, so it gets a one-line instruction instead of an upload.

/** Where an image goes right now: the open import detail, the dialog, or a new import. */
export interface ImageTarget {
  offer(file: File): void;
  /** Overlay text while files are dragged over the panel. */
  dropLabel: string;
  /** The target draws its own drop highlight (a modal dialog covers the overlay). */
  ownZone?: HTMLElement;
}

export const LINK_DROP_TEXT = `這張圖片無法直接拖入，請在圖片上按右鍵 → ${copyImageMenuLabel(
  globalThis.navigator?.userAgent ?? "",
)}後貼上`;
const NOT_IMAGE_TEXT = "只能匯入 PNG、JPEG 或 WebP 圖片。";
const ONE_IMAGE_TEXT = "一次匯入一張圖片，已使用第一張。";

function editableText(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly;
  return (
    target instanceof HTMLInputElement &&
    !target.readOnly &&
    ["text", "search", "url", "password", "email", ""].includes(target.type)
  );
}

export class ImageIntake {
  readonly overlay = el("div", "ii-overlay");
  private readonly overlayText = el("p", "ii-overlay__text");
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private zone: HTMLElement | undefined;

  constructor(
    private readonly options: {
      target(): ImageTarget | undefined;
      /** One-line notice (for example a link-only drop or an unpaired panel). */
      notify(message: string): void;
      /** Why no target can take an image now, when `target()` is undefined. */
      unavailable(): string;
    },
    root: Document = document,
  ) {
    this.overlay.hidden = true;
    this.overlay.setAttribute("aria-hidden", "true");
    const card = el("div", "ii-overlay__card");
    card.append(icon("Image", { size: "2xl" }), this.overlayText);
    this.overlay.append(card);
    root.addEventListener("paste", (event) => this.paste(event));
    root.addEventListener("dragenter", (event) => this.drag(event));
    root.addEventListener("dragover", (event) => this.drag(event));
    root.addEventListener("dragleave", (event) => {
      // Leaving the panel entirely (no element under the pointer) ends the overlay.
      if (!event.relatedTarget) this.hide();
    });
    root.addEventListener("drop", (event) => this.drop(event));
    root.addEventListener("dragend", () => this.hide());
  }

  /**
   * The workbench iframe saw files dragged over it. The iframe is another origin and would
   * swallow the drop, so the trusted overlay covers it; the drop then lands here.
   */
  hint() {
    const target = this.options.target();
    this.show("files", target);
  }

  private paste(event: ClipboardEvent) {
    if (!event.isTrusted) return;
    const data = event.clipboardData;
    const content = imageFromTransfer(data);
    if (content.kind !== "image") return;
    // Text pasted into a field stays text, even when the clipboard also holds a picture.
    if (editableText(event.target) && data?.types.includes("text/plain")) return;
    event.preventDefault();
    this.deliver(content.file, content.ignored);
  }

  private deliver(file: File, ignored: number) {
    const target = this.options.target();
    if (!target) {
      this.options.notify(this.options.unavailable());
      return;
    }
    target.offer(file);
    if (ignored) this.options.notify(ONE_IMAGE_TEXT);
  }

  private drag(event: DragEvent) {
    const kind = dragKind(event.dataTransfer?.types);
    if (kind === "none") return;
    // Without this the browser would open a dropped file in place of the panel.
    event.preventDefault();
    const target = kind === "files" ? this.options.target() : undefined;
    if (event.dataTransfer) event.dataTransfer.dropEffect = dropEffectFor(kind, Boolean(target));
    this.show(kind, target);
  }

  private drop(event: DragEvent) {
    const kind = dragKind(event.dataTransfer?.types);
    if (kind === "none") return;
    event.preventDefault();
    this.hide();
    if (!event.isTrusted) return;
    const content = imageFromTransfer(event.dataTransfer);
    if (content.kind === "link") {
      this.options.notify(LINK_DROP_TEXT);
      return;
    }
    if (content.kind === "not-image") {
      this.options.notify(NOT_IMAGE_TEXT);
      return;
    }
    if (content.kind !== "image") return;
    this.deliver(content.file, content.ignored);
  }

  private show(kind: DragKind, target: ImageTarget | undefined) {
    clearTimeout(this.hideTimer);
    // A drag that stops reporting (dropped outside, cancelled with Esc) clears itself.
    this.hideTimer = setTimeout(() => this.hide(), 1500);
    if (target?.ownZone && kind === "files") {
      this.overlay.hidden = true;
      this.setZone(target.ownZone);
      return;
    }
    this.setZone(undefined);
    const text =
      kind === "link" ? LINK_DROP_TEXT : target ? target.dropLabel : this.options.unavailable();
    if (this.overlayText.textContent !== text) this.overlayText.textContent = text;
    this.overlay.dataset.kind = kind === "link" || !target ? "blocked" : "files";
    this.overlay.hidden = false;
  }

  private setZone(zone: HTMLElement | undefined) {
    if (this.zone && this.zone !== zone) delete this.zone.dataset.drag;
    this.zone = zone;
    if (zone) zone.dataset.drag = "";
  }

  hide() {
    clearTimeout(this.hideTimer);
    this.overlay.hidden = true;
    this.setZone(undefined);
  }
}
