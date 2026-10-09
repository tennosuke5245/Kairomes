import type { ArtifactImportApproval } from "@kairomes/protocol";
import {
  type ImageMime,
  imageFormatName,
  imageMimeForPath,
  withImageExtension,
} from "@kairomes/protocol/image-path";
import { quote } from "./approval-detail.ts";
import { appendVisible, el, fact, textButton, workspaceTag } from "./approval-dom.ts";
import { importRequester, importSourceText, preparingText, workspaceHue } from "./approval-view.ts";
import { icon } from "./icons.ts";
import {
  type ImageProblem,
  imageHeader,
  imageSummary,
  importErrorText,
  type PreparedImage,
  prepareImage,
  sha256Hex,
} from "./image-file.ts";
import {
  decodedMatches,
  type PreviewProblem,
  type PreviewState,
  previewKey,
  previewNeeded,
  previewProblemText,
  previewReady,
  previewScale,
  verifyPreview,
} from "./image-preview.ts";
import { copyImageMenuLabel } from "./image-transfer.ts";
import type { UploadAttempt } from "./image-upload.ts";
import { ImportRequestError } from "./import-client.ts";

// The body of an image import in the native approval page: target, the image (a drop zone
// while ChatGPT has not handed it over, a receiving state, then the verified preview), facts
// and the model's unverified summary. Pixels are drawn on a canvas from bytes this panel
// fetched and hashed itself: the extension CSP allows no image URLs, not even blob:, and no
// URL is ever created or shown. Untrusted text goes through textContent only.

/** What the approval page needs from the coordinator for imports. */
export interface ImportBackend {
  /** GET /api/panel/imports/:id/content with this panel's pairing. */
  content(
    item: ArtifactImportApproval,
    signal: AbortSignal,
  ): Promise<{ bytes: ArrayBuffer; type: string }>;
  /** POST /api/panel/imports/:id/file; resolves once the daemon accepted the bytes. */
  upload(item: ArtifactImportApproval, image: PreparedImage): Promise<void>;
  /** The latest upload attempt for this import (its unknown state survives a reopen). */
  uploadStatus(item: ArtifactImportApproval): UploadAttempt | undefined;
}

type LocalImage =
  | { status: "checking"; name: string }
  | { status: "refused"; code: ImageProblem | "DECODE_FAILED" }
  | { status: "mismatch"; image: PreparedImage; canvas: HTMLCanvasElement; target: ImageMime }
  | { status: "sending"; image: PreparedImage; canvas?: HTMLCanvasElement }
  | { status: "sent"; image: PreparedImage; canvas?: HTMLCanvasElement }
  | {
      status: "failed";
      image: PreparedImage;
      canvas?: HTMLCanvasElement;
      error: ImportRequestError;
    };

const PREVIEW_MAX = 2048;
const isMac = /Mac|iPhone|iPad/.test(
  globalThis.navigator?.platform || globalThis.navigator?.userAgent || "",
);
/** 複製圖片 (Chrome) or 複製影像 (Edge): the menu item the user will actually see. */
export const copyImageLabel = copyImageMenuLabel(globalThis.navigator?.userAgent ?? "");

class PreviewFailure extends Error {
  constructor(readonly problem: PreviewProblem) {
    super(problem);
  }
}

/** Decodes bytes into a canvas (no URL). Undefined when the browser cannot decode them. */
export async function decodeToCanvas(blob: Blob, size: { width: number; height: number }) {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      blob,
      previewScale(size.width, size.height, PREVIEW_MAX) ?? {},
    );
  } catch {
    return undefined;
  }
  try {
    const scaled = Math.max(size.width, size.height) > PREVIEW_MAX;
    if (!scaled && !decodedMatches(size, bitmap)) return undefined;
    const canvas = el("canvas", "ii-canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    canvas.setAttribute("role", "img");
    // Small images stay crisp instead of blurring when they are enlarged.
    if (Math.max(bitmap.width, bitmap.height) < 256) canvas.dataset.pixelated = "";
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** Frees a canvas's pixel memory right away instead of waiting for collection. */
export function releaseCanvas(canvas: HTMLCanvasElement | undefined) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

/** Re-encodes an image to another format at full size (a JPEG gets a white background). */
async function convertImage(image: PreparedImage, mime: ImageMime) {
  const bitmap = await createImageBitmap(image.blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    if (mime === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, bitmap.width, bitmap.height);
    }
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: mime, quality: 0.92 });
    return Object.assign(blob, { name: withImageExtension(image.name || "image", mime) });
  } catch {
    return undefined;
  } finally {
    bitmap.close();
  }
}

/** The paste shortcut as plain text, for one-line notices. */
export const pasteShortcutText = () => (isMac ? "⌘V" : "Ctrl+V");

/** `Ctrl` + `V` (or `⌘` + `V`) as key caps inside a sentence. */
function pasteKeys() {
  const keys = el("span", "ii-keys");
  keys.append(el("kbd", "k-kbd", isMac ? "⌘" : "Ctrl"), "+", el("kbd", "k-kbd", "V"));
  return keys;
}

/** The drop zone shared by the approval detail and the import dialog. */
export function dropZone(options: { onChoose(): void; compact?: boolean }) {
  const zone = el("div", "ii-drop");
  if (options.compact) zone.dataset.compact = "";
  const tile = el("span", "ii-drop__icon");
  tile.append(icon("ClipboardText", { size: "xl" }));
  const title = el("p", "ii-drop__title");
  // The menu item and the key combo never break across lines.
  const keep = (...content: (Node | string)[]) => {
    const span = el("span", "ii-nowrap");
    span.append(...content);
    return span;
  };
  title.append(
    "在 ChatGPT 的圖片上按右鍵 → ",
    keep(copyImageLabel),
    "，",
    keep("再到這裡按 ", pasteKeys()),
  );
  const actions = el("div", "ii-drop__actions");
  const choose = textButton("選擇檔案", "k-btn k-btn--secondary k-btn--sm", "UploadSimple");
  choose.addEventListener("click", () => options.onChoose());
  actions.append(choose, el("span", "ii-drop__or", "或把圖片檔拖到這裡"));
  zone.append(tile, title, actions, el("p", "ii-drop__hint", "PNG、JPEG 或 WebP，最大 25 MiB"));
  return { zone, choose };
}

/** A hidden `<input type=file>` limited to the three importable formats. */
export function imageFileInput(onFile: (file: File) => void) {
  const input = el("input", "ii-file");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.hidden = true;
  input.tabIndex = -1;
  input.addEventListener("change", (event) => {
    const file = input.files?.[0];
    input.value = "";
    // Only the user's own choice in the file picker; a script setting `files` sends nothing.
    if (file && event.isTrusted) onFile(file);
  });
  return input;
}

/** Status line under the drop zone or in a dialog: one sentence, a tone and an optional action. */
export function statusLine(
  tone: "running" | "danger" | "warning" | "neutral" | "success",
  text: string,
  action?: { label: string; run(): void; trusted?: boolean },
) {
  const line = el("div", "ii-status");
  line.dataset.tone = tone;
  // Danger interrupts; progress and warnings are polite.
  line.setAttribute("role", tone === "danger" ? "alert" : "status");
  const glyph =
    tone === "running"
      ? icon("CircleNotch", { spin: true })
      : icon(
          tone === "danger"
            ? "WarningCircle"
            : tone === "warning"
              ? "Question"
              : tone === "success"
                ? "CheckCircle"
                : "Info",
        );
  line.append(glyph, el("span", "ii-status__text", text));
  if (action) {
    const button = textButton(action.label, "k-btn k-btn--secondary k-btn--sm");
    // An action that sends something runs only on the user's own click.
    button.addEventListener("click", (event) => {
      if (action.trusted && !event.isTrusted) return;
      action.run();
    });
    line.append(button);
  }
  return line;
}

export class ImportView {
  private id: string | undefined;
  private live: ArtifactImportApproval | undefined;
  private mode: "review" | "record" = "review";
  private readonly root = el("div", "ii");
  private readonly target = el("dl", "k-dl ii-target");
  private readonly stage = el("div", "ii-stage");
  private readonly facts = el("dl", "k-dl ii-facts");
  private readonly summary = el("div", "ii-summary");
  private tech = el("details", "sp-disclosure ii-tech");
  private readonly techBody = el("dl", "k-dl ii-tech__list");
  private readonly fileInput = imageFileInput((file) => this.offer(file));
  private preview: PreviewState = { status: "idle" };
  private abort: AbortController | undefined;
  private canvas: { key: string; element: HTMLCanvasElement } | undefined;
  /** The verified preview of an approved import, shown again in its record. */
  private kept: { id: string; version: string; element: HTMLCanvasElement } | undefined;
  private local: (LocalImage & { importId: string }) | undefined;
  private zoom = false;
  private stageKey = "";
  private itemKey = "";
  private summaryText: string | undefined;

  constructor(
    private readonly options: {
      backend?: ImportBackend;
      announce(message: string): void;
      /** Something that affects the decision changed (a preview loaded, an upload settled). */
      changed(): void;
      available(): boolean;
    },
  ) {
    // Focus can rest on the stage while no control in it is usable (an upload is checked or
    // sent); it moves on to the next action as soon as one appears.
    this.stage.tabIndex = -1;
    this.root.append(this.target, this.stage, this.facts, this.summary, this.tech, this.fileInput);
  }

  /** The body for one import. A new import resets everything; the same one updates in place. */
  show(item: ArtifactImportApproval, mode: "review" | "record") {
    if (item.id !== this.id) this.reset(item.id);
    this.mode = mode;
    this.live = item;
    this.sync();
    return this.root;
  }

  /** The same import moved on (awaiting_file → preparing → pending); redraw what changed. */
  update(item: ArtifactImportApproval) {
    if (item.id !== this.id) return;
    this.live = item;
    this.sync();
  }

  /** The connection changed: redraw what depends on it and load a preview that can now load. */
  refresh() {
    if (this.live) this.sync();
  }

  /** Leaves the detail: stops loads and frees pixels, except an approved image's record copy. */
  release() {
    this.reset(undefined);
  }

  /** True when this panel holds a verified preview of exactly this pending content. */
  ready(item: ArtifactImportApproval) {
    return item.id === this.id && previewReady(this.preview, item);
  }

  /** The open import waits for an image and this panel can send one. */
  get accepting() {
    return (
      this.mode === "review" &&
      this.live?.state === "awaiting_file" &&
      Boolean(this.options.backend) &&
      this.options.available() &&
      !this.sending
    );
  }

  /** A pasted, dropped or chosen file for the open import; false when it cannot take one. */
  offer(file: File) {
    if (!this.accepting || !this.live) return false;
    void this.accept(this.live, file);
    return true;
  }

  /** Keeps the verified preview for the record view once the user approved it. */
  keep(item: ArtifactImportApproval) {
    if (!this.canvas || !item.version || this.canvas.key !== previewKey(item)) return;
    if (this.kept && this.kept.element !== this.canvas.element) releaseCanvas(this.kept.element);
    this.kept = { id: item.id, version: item.version, element: this.canvas.element };
  }

  /** An image approved elsewhere in this panel (the dialog), kept for the import's record. */
  adopt(id: string, version: string, canvas: HTMLCanvasElement) {
    if (this.kept && this.kept.element !== canvas) releaseCanvas(this.kept.element);
    this.kept = { id, version, element: canvas };
  }

  /** The daemon refused an approve without this panel's preview: load it again. */
  reloadPreview() {
    this.preview = { status: "idle" };
    this.sync();
  }

  private get sending() {
    return this.local?.status === "sending" || this.local?.status === "checking";
  }

  private reset(id: string | undefined) {
    this.abort?.abort();
    this.abort = undefined;
    if (this.canvas && this.canvas.element !== this.kept?.element)
      releaseCanvas(this.canvas.element);
    this.canvas = undefined;
    this.releaseLocal();
    this.preview = { status: "idle" };
    this.zoom = false;
    this.stageKey = "";
    this.itemKey = "";
    this.summaryText = undefined;
    this.id = id;
    this.live = undefined;
    // A fresh disclosure per import, so one import's open 技術資訊 does not carry over.
    const tech = el("details", "sp-disclosure ii-tech");
    this.tech.replaceWith(tech);
    this.tech = tech;
    this.stage.replaceChildren();
    // The approved image stays for its record until another import is opened.
    if (this.kept && id !== undefined && this.kept.id !== id) {
      releaseCanvas(this.kept.element);
      this.kept = undefined;
    }
  }

  private releaseLocal() {
    const local = this.local;
    if (local && "canvas" in local) releaseCanvas(local.canvas);
    this.local = undefined;
  }

  private sync() {
    const item = this.live;
    if (!item) return;
    if (this.local && this.local.importId !== item.id) this.releaseLocal();
    // Text sections are rebuilt only when the import itself changed (selection survives frames).
    const key = JSON.stringify([this.mode, item]);
    if (key !== this.itemKey) {
      this.itemKey = key;
      this.renderTarget(item);
      this.renderFacts(item);
      this.renderSummary(item);
      this.renderTech(item);
    }
    this.renderStage(item);
    if (
      this.mode === "review" &&
      this.options.backend &&
      previewNeeded(this.preview, item) &&
      this.options.available()
    )
      void this.load(item);
  }

  private renderTarget(item: ArtifactImportApproval) {
    const path = fact("儲存為", appendVisible(el("div", "k-codebox ii-path"), item.path));
    // A promise about the decision ahead; a finished record states its own outcome instead.
    if (this.mode === "review")
      path.append(el("p", "k-dl__note", "只建立新檔，不會覆寫既有檔案。"));
    this.target.replaceChildren(
      path,
      fact("專案", workspaceTag(item.workspace_name, workspaceHue(item.workspace_id))),
      // From the daemon's record, so a model cannot pass its request off as the user's own.
      fact("提出", importRequester(item)),
    );
  }

  private renderFacts(item: ArtifactImportApproval) {
    const rows: HTMLElement[] = [];
    // Only verified bytes have a source to name; an import that never received an image has none.
    const sourceLabel = importSourceText(item);
    if (sourceLabel) {
      const source = el("span");
      source.append(sourceLabel);
      // A display name from the host: untrusted, shown verbatim with escapes, never a path.
      if (item.source_file_name)
        source.append(" · ", appendVisible(el("span", "ii-name"), item.source_file_name));
      rows.push(fact("來源", source));
    }
    if (
      item.mime_type !== null &&
      item.width !== null &&
      item.height !== null &&
      item.byte_size !== null
    )
      rows.unshift(
        fact(
          "圖片",
          imageSummary({
            mime: item.mime_type,
            width: item.width,
            height: item.height,
            size: item.byte_size,
          }),
        ),
      );
    // The content hash is stated once, in full, under 技術資訊.
    this.facts.replaceChildren(...rows);
    this.facts.hidden = !rows.length;
  }

  private renderSummary(item: ArtifactImportApproval) {
    // The panel's own imports carry the daemon's default summary, not model text. Only the
    // daemon's recorded origin decides that: a model can send any summary, including that one.
    const text = item.origin === "panel" ? "" : item.summary.trim();
    if (this.summaryText === text) return;
    this.summaryText = text;
    this.summary.replaceChildren(...(text ? [quote(text)] : []));
    this.summary.hidden = !text;
  }

  private renderTech(item: ArtifactImportApproval) {
    if (!this.tech.firstChild) {
      const summary = el("summary");
      summary.append(icon("CaretDown", { className: "sp-disclosure__caret" }), "技術資訊");
      const body = el("div", "sp-disclosure__body");
      body.append(this.techBody);
      this.tech.append(summary, body);
    }
    const mono = (value: string) => el("span", "k-mono ii-tech__value", value);
    this.techBody.replaceChildren(
      ...(item.version ? [fact("SHA-256", mono(item.version))] : []),
      fact("匯入 ID", mono(item.id)),
      fact("請求 ID", mono(item.request_id)),
      fact("工作區 ID", mono(item.workspace_id)),
    );
  }

  // ---------- Stage: drop zone, receiving, preview, record ----------

  private renderStage(item: ArtifactImportApproval) {
    const local = this.local;
    const upload = this.options.backend?.uploadStatus(item);
    const key = JSON.stringify([
      this.mode,
      item.state,
      item.fingerprint,
      item.error_code,
      this.preview,
      this.zoom,
      local?.status,
      upload?.status,
      upload?.uploadId,
      this.options.available(),
      this.kept?.id === item.id,
    ]);
    if (key === this.stageKey) return;
    this.stageKey = key;
    const hadFocus = this.stage.contains(document.activeElement);
    const parts: HTMLElement[] = [];
    if (this.mode === "record") parts.push(...this.recordStage(item));
    else if (item.state === "awaiting_file") parts.push(...this.dropStage(item));
    else if (item.state === "preparing") parts.push(...this.receivingStage(item));
    else if (item.state === "pending") parts.push(this.previewStage(item));
    this.stage.replaceChildren(...parts);
    this.stage.hidden = !parts.length;
    // Focus never falls to <body> when the control it was on is replaced, and it does not stay
    // parked on the stage once a usable action (convert, retry, 放大) is there again.
    const active = document.activeElement;
    if (hadFocus && (active === this.stage || !this.stage.contains(active))) {
      // The next step first (convert, retry, 放大), then the chooser again.
      const next =
        this.stage.querySelector<HTMLElement>(".ii-status button:not(:disabled)") ??
        this.stage.querySelector<HTMLElement>(".ii-caption button:not(:disabled)") ??
        this.stage.querySelector<HTMLElement>("button:not(:disabled)");
      (next ?? this.stage).focus({ preventScroll: true });
    }
  }

  private dropStage(item: ArtifactImportApproval) {
    const backend = this.options.backend;
    const { zone } = dropZone({ onChoose: () => this.fileInput.click() });
    const usable = Boolean(backend) && this.options.available();
    zone.toggleAttribute("data-disabled", !usable);
    for (const button of zone.querySelectorAll("button")) button.disabled = !usable || this.sending;
    const parts: HTMLElement[] = [zone];
    const local = this.local;
    const upload = backend?.uploadStatus(item);
    if (local?.status === "checking") parts.push(statusLine("running", "正在檢查圖片…"));
    else if (local?.status === "refused")
      parts.push(statusLine("danger", importErrorText(local.code)));
    else if (local?.status === "mismatch") {
      const format = imageFormatName(local.target);
      parts.push(
        this.thumbnail(local.canvas, local.image),
        statusLine(
          "danger",
          `這張是 ${imageFormatName(local.image.mime)}，但要存成 ${format}。`,
          usable
            ? {
                label: `轉成 ${format} 後上傳`,
                run: () => void this.convertAndSend(item, local.image, local.target),
                trusted: true,
              }
            : undefined,
        ),
      );
    } else if (local?.status === "sending") {
      if (local.canvas) parts.push(this.thumbnail(local.canvas, local.image));
      parts.push(statusLine("running", "正在上傳…"));
    } else if (local?.status === "failed" && local.error.unknown) {
      if (local.canvas) parts.push(this.thumbnail(local.canvas, local.image));
      parts.push(
        usable
          ? statusLine("warning", "上傳結果待確認。", {
              label: "再試一次",
              // Same bytes, same upload ID: the daemon replays the first outcome.
              run: () => void this.send(item, local.image, local.canvas),
              trusted: true,
            })
          : // Offline nothing can be sent; the same upload ID waits for the connection.
            statusLine("warning", "上傳結果待確認；連線恢復後可再試一次。"),
      );
    } else if (local?.status === "failed")
      parts.push(
        statusLine(
          "danger",
          importErrorText(local.error.code, { path: item.path, mime: local.image.mime }),
        ),
      );
    else if (upload?.status === "unknown")
      parts.push(
        statusLine("warning", "上一次上傳的結果待確認；再放入同一張圖片會沿用同一次上傳。"),
      );
    else if (item.error_code)
      // The daemon refused the previous image; this import is waiting for another one.
      parts.push(
        statusLine(
          "danger",
          `${importErrorText(item.error_code, { path: item.path })}請換一張圖片。`,
        ),
      );
    else if (!usable)
      parts.push(
        statusLine("neutral", backend ? "連線恢復後才能提供圖片。" : "這個畫面無法提供圖片。"),
      );
    return parts;
  }

  private receivingStage(item: ArtifactImportApproval) {
    const parts: HTMLElement[] = [];
    const local = this.local;
    if (local && "canvas" in local && local.canvas)
      parts.push(this.thumbnail(local.canvas, local.image));
    const line = statusLine("running", preparingText(item));
    line.setAttribute("aria-busy", "true");
    parts.push(line);
    return parts;
  }

  private thumbnail(canvas: HTMLCanvasElement, image: PreparedImage) {
    const figure = el("figure", "ii-thumb");
    const frame = el("div", "ii-frame ii-frame--thumb");
    canvas.setAttribute("aria-label", "你選擇的圖片");
    frame.append(canvas);
    figure.append(frame, el("figcaption", "ii-thumb__caption", imageSummary(image)));
    return figure;
  }

  private previewStage(item: ArtifactImportApproval) {
    const figure = el("figure", "ii-figure");
    const frame = el("div", "ii-frame");
    const caption = el("figcaption", "ii-caption");
    caption.append(el("span", "ii-caption__text", "待審圖片"));
    const state = this.preview;
    const key = previewKey(item);
    if (state.status === "ready" && this.canvas?.key === key) {
      const canvas = this.canvas.element;
      canvas.setAttribute("aria-label", `待匯入至 ${item.path} 的圖片`);
      frame.append(canvas);
      if (this.zoom) frame.dataset.zoom = "";
      // A toggle keeps one name; aria-pressed (and the icon) say which way it is.
      const zoom = textButton(
        "放大",
        "k-btn k-btn--quiet k-btn--sm",
        this.zoom ? "ArrowsIn" : "ArrowsOut",
      );
      zoom.setAttribute("aria-pressed", String(this.zoom));
      zoom.addEventListener("click", () => {
        this.zoom = !this.zoom;
        if (this.live) this.renderStage(this.live);
        this.stage.querySelector<HTMLButtonElement>(".ii-caption button")?.focus();
      });
      caption.append(zoom);
    } else if (state.status === "failed" && state.key === key) {
      frame.dataset.state = "failed";
      const retry =
        state.problem === "network" && this.options.available()
          ? { label: "重新載入預覽", run: () => this.reloadPreview() }
          : undefined;
      frame.append(
        statusLine(
          state.problem === "network" ? "warning" : "danger",
          previewProblemText(state.problem),
          retry,
        ),
      );
    } else {
      frame.dataset.state = "loading";
      frame.setAttribute("aria-busy", "true");
      const line = statusLine(
        "running",
        this.options.available() ? "正在載入並核對預覽…" : "連線恢復後會載入預覽。",
      );
      frame.append(line);
    }
    figure.append(frame, caption);
    return figure;
  }

  private recordStage(item: ArtifactImportApproval) {
    const kept = this.kept;
    if (!kept || kept.id !== item.id || kept.version !== item.version) return [];
    if (!["applying", "applied"].includes(item.state)) return [];
    const figure = el("figure", "ii-figure");
    const frame = el("div", "ii-frame");
    kept.element.setAttribute("aria-label", `匯入至 ${item.path} 的圖片`);
    frame.append(kept.element);
    const caption = el("figcaption", "ii-caption");
    caption.append(el("span", "ii-caption__text", "匯入時的圖片"));
    figure.append(frame, caption);
    return [figure];
  }

  // ---------- Preview loading ----------

  private async load(item: ArtifactImportApproval) {
    const backend = this.options.backend;
    if (!backend) return;
    const key = previewKey(item);
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.preview = { status: "loading", key };
    this.renderStage(item);
    const stale = () =>
      abort.signal.aborted ||
      this.id !== item.id ||
      this.preview.status !== "loading" ||
      this.preview.key !== key;
    let canvas: HTMLCanvasElement | undefined;
    try {
      const received = await backend.content(item, abort.signal);
      if (stale()) return;
      const bytes = new Uint8Array(received.bytes);
      const problem = verifyPreview(item, {
        size: bytes.length,
        type: received.type,
        sha256: await sha256Hex(bytes),
        header: imageHeader(bytes),
      });
      if (stale()) return;
      if (problem) throw new PreviewFailure(problem);
      canvas = await decodeToCanvas(new Blob([bytes], { type: item.mime_type ?? "" }), {
        width: item.width ?? 0,
        height: item.height ?? 0,
      });
      bytes.fill(0);
      if (stale()) return;
      if (!canvas) throw new PreviewFailure("decode");
      if (this.canvas && this.canvas.element !== this.kept?.element)
        releaseCanvas(this.canvas.element);
      this.canvas = { key, element: canvas };
      canvas = undefined;
      this.preview = { status: "ready", key };
      // The verified preview replaces the local copy that was shown while uploading.
      this.releaseLocal();
      this.options.announce("待審圖片已載入");
    } catch (cause) {
      if (stale()) return;
      const problem: PreviewProblem =
        cause instanceof PreviewFailure
          ? cause.problem
          : cause instanceof ImportRequestError && cause.code === "ARTIFACT_IMPORT_NOT_FOUND"
            ? "gone"
            : cause instanceof ImportRequestError && cause.code === "PANEL_UNAUTHORIZED"
              ? "unauthorized"
              : "network";
      this.preview = { status: "failed", key, problem };
      this.options.announce(previewProblemText(problem));
    } finally {
      releaseCanvas(canvas);
      if (this.abort === abort) this.abort = undefined;
    }
    if (this.live?.id === item.id) this.renderStage(this.live);
    this.options.changed();
  }

  // ---------- Local image ----------

  private setLocal(importId: string, local: LocalImage) {
    const previous = this.local;
    if (
      previous &&
      "canvas" in previous &&
      previous.canvas &&
      !("canvas" in local && local.canvas === previous.canvas)
    )
      releaseCanvas(previous.canvas);
    this.local = { ...local, importId };
    if (this.live?.id === importId) this.renderStage(this.live);
    this.options.changed();
  }

  private async accept(item: ArtifactImportApproval, file: File) {
    this.setLocal(item.id, { status: "checking", name: file.name });
    const prepared = await prepareImage(file);
    if (this.id !== item.id) return;
    if (!prepared.ok) {
      this.setLocal(item.id, { status: "refused", code: prepared.code });
      this.options.announce(importErrorText(prepared.code));
      return;
    }
    const image = prepared.image;
    const canvas = await decodeToCanvas(image.blob, image);
    if (this.id !== item.id) {
      releaseCanvas(canvas);
      return;
    }
    if (!canvas) {
      this.setLocal(item.id, { status: "refused", code: "DECODE_FAILED" });
      this.options.announce(importErrorText("DECODE_FAILED"));
      return;
    }
    // The target's extension is fixed by the request; a pasted image is usually PNG.
    const target = imageMimeForPath(item.path);
    if (target && target !== image.mime) {
      this.setLocal(item.id, { status: "mismatch", image, canvas, target });
      return;
    }
    await this.send(item, image, canvas);
  }

  private async convertAndSend(
    item: ArtifactImportApproval,
    image: PreparedImage,
    target: ImageMime,
  ) {
    this.setLocal(item.id, { status: "checking", name: image.name });
    const converted = await convertImage(image, target);
    const prepared = converted ? await prepareImage(converted) : undefined;
    if (this.id !== item.id) return;
    if (!prepared?.ok) {
      this.setLocal(item.id, {
        status: "refused",
        code: prepared?.ok === false ? prepared.code : "DECODE_FAILED",
      });
      return;
    }
    const canvas = await decodeToCanvas(prepared.image.blob, prepared.image);
    if (this.id !== item.id) {
      releaseCanvas(canvas);
      return;
    }
    await this.send(item, prepared.image, canvas);
  }

  private async send(
    item: ArtifactImportApproval,
    image: PreparedImage,
    canvas: HTMLCanvasElement | undefined,
  ) {
    const backend = this.options.backend;
    const live = this.live;
    if (!backend || !live || live.id !== item.id || live.state !== "awaiting_file") return;
    if (!this.options.available()) return;
    const before = this.local;
    this.setLocal(item.id, { status: "sending", image, canvas });
    this.options.announce("正在上傳圖片");
    try {
      await backend.upload(live, image);
      if (this.id !== item.id) return;
      this.setLocal(item.id, { status: "sent", image, canvas });
      this.options.announce("圖片已送出，正在核對");
    } catch (cause) {
      if (this.id !== item.id) return;
      const error =
        cause instanceof ImportRequestError
          ? cause
          : new ImportRequestError("UNKNOWN", undefined, true);
      // Refused before anything was sent (the connection dropped): an unconfirmed earlier try
      // stays exactly as it was, with its own retry.
      if (!error.sent && before?.status === "failed" && before.error.unknown) {
        this.setLocal(item.id, { ...before, canvas });
        this.options.announce("連線中斷，沒有送出；上傳結果仍待確認。");
        return;
      }
      this.setLocal(item.id, { status: "failed", image, canvas, error });
      this.options.announce(error.unknown ? "上傳結果待確認" : importErrorText(error.code));
    }
  }
}
