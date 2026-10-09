import type {
  ArtifactImportApproval,
  PanelImportCreate,
  PanelImportResponse,
} from "@kairomes/protocol";
import { imagePathProblem, parentFolder, suggestImagePath } from "@kairomes/protocol/image-path";
import { el, textButton } from "./approval-dom.ts";
import {
  imageHeader,
  imageSummary,
  importErrorField,
  importErrorText,
  type PreparedImage,
  prepareImage,
  sha256Hex,
} from "./image-file.ts";
import { verifyPreview } from "./image-preview.ts";
import { ImportRequestError } from "./import-client.ts";
import { type DialogPhase, dialogCancelAction, pathEnterAction } from "./import-dialog-state.ts";
import {
  decodeToCanvas,
  dropZone,
  imageFileInput,
  pasteShortcutText,
  releaseCanvas,
  statusLine,
} from "./import-view.ts";

// The user's own import, without any model: choose a project and a path, paste, drop or
// choose an image, then 匯入. One trusted click creates the import, uploads the bytes, reads
// them back through the pending preview, checks that they are exactly the image shown here,
// and approves that content. Enter in the path field never does that by itself. A failure
// stops at its step with one line; nothing is retried without another click, and a retry
// reuses the same request and upload identity. 取消 and Esc abandon any step but the decision.

export interface ImportDialogOptions {
  client: {
    create(input: PanelImportCreate, signal: AbortSignal): Promise<PanelImportResponse>;
    upload(
      item: ArtifactImportApproval,
      image: PreparedImage,
      signal: AbortSignal,
    ): Promise<PanelImportResponse>;
    content(
      item: ArtifactImportApproval,
      signal: AbortSignal,
    ): Promise<{ bytes: ArrayBuffer; type: string }>;
  };
  workspaces(): readonly { id: string; name: string }[];
  defaultWorkspace(): string | null;
  available(): boolean;
  /** The live import from the latest snapshot. */
  find(id: string): ArtifactImportApproval | undefined;
  decide(item: ArtifactImportApproval, action: "approve" | "stop"): Promise<void>;
  /** The decision was sent (`approved`: and accepted); show this import in the approval page. */
  finished(
    id: string,
    approved: boolean,
    image?: { canvas: HTMLCanvasElement; version: string },
  ): void;
  announce(message: string): void;
  now?: () => number;
}

type Phase = DialogPhase;

const phaseText: Record<Exclude<Phase, "edit">, string> = {
  creating: "正在建立匯入…",
  uploading: "正在上傳…",
  verifying: "正在核對圖片…",
  approving: "正在寫入…",
};

export class ImportDialog {
  readonly dialog = el("dialog", "k-dialog ii-dialog");
  private readonly project = el("select", "k-input ii-select");
  /** A wrapping single-line field, so a long target path is always readable in full. */
  private readonly path = el("textarea", "k-textarea k-input--mono ii-path-input");
  private readonly pathError = el("p", "k-error ii-field__error");
  private readonly imageSlot = el("div", "ii-dialog__image");
  private readonly imageError = el("p", "k-error ii-field__error");
  private readonly status = el("div", "ii-dialog__status");
  private readonly cancel = textButton("取消", "k-btn k-btn--secondary");
  private readonly submitButton = textButton("匯入", "k-btn k-btn--primary", "Check");
  private readonly fileInput = imageFileInput((file) => this.offer(file));
  private readonly zone: HTMLElement;
  /** The chosen image, built once and updated in place so focus on 換一張 survives renders. */
  private readonly figure = el("figure", "ii-figure ii-figure--dialog");
  private readonly figureFrame = el("div", "ii-frame");
  private readonly figureText = el("span", "ii-caption__text");
  private readonly replace = textButton(
    "換一張",
    "k-btn k-btn--quiet k-btn--sm",
    "ArrowsClockwise",
  );
  /** An input method is composing in the path field (its Enter picks a candidate). */
  private composing = false;
  private phase: Phase = "edit";
  private image: { prepared: PreparedImage; canvas: HTMLCanvasElement } | undefined;
  private checking = false;
  /** The path was typed by the user; a new image then keeps it. */
  private pathEdited = false;
  private suggested = "";
  private lastFolder = "images";
  /** A create whose answer was lost: the next 匯入 resends it with the same request ID. */
  private intent: (PanelImportCreate & { request_id: string }) | undefined;
  /** The import this dialog opened (still awaiting its image, or pending). */
  private created: { id: string; workspace_id: string; path: string } | undefined;
  private abort: AbortController | undefined;
  private returnFocus: HTMLElement | undefined;
  private generalError: { text: string; tone: "danger" | "warning" | "neutral" } | undefined;

  constructor(private readonly options: ImportDialogOptions) {
    const dialog = this.dialog;
    dialog.id = "import-dialog";
    dialog.setAttribute("aria-labelledby", "import-dialog-title");
    const head = el("div", "k-dialog__head");
    const title = el("h2", "k-dialog__title", "匯入圖片");
    title.id = "import-dialog-title";
    head.append(title);
    const body = el("div", "k-dialog__body ii-dialog__body");

    const projectField = el("div", "ii-field");
    const projectLabel = el("label", "k-label", "專案");
    projectLabel.htmlFor = "import-project";
    this.project.id = "import-project";
    projectField.append(projectLabel, this.project);

    const imageField = el("div", "ii-field");
    const imageLabel = el("p", "k-label", "圖片");
    imageLabel.id = "import-image-label";
    this.imageSlot.setAttribute("role", "group");
    this.imageSlot.setAttribute("aria-labelledby", imageLabel.id);
    this.imageError.id = "import-image-error";
    this.imageError.setAttribute("role", "alert");
    const zone = dropZone({ onChoose: () => this.fileInput.click(), compact: true });
    this.zone = zone.zone;
    const caption = el("figcaption", "ii-caption");
    caption.append(this.figureText, this.replace);
    this.figure.append(this.figureFrame, caption);
    this.replace.addEventListener("click", () => this.fileInput.click());
    imageField.append(imageLabel, this.imageSlot, this.imageError, this.fileInput);

    const pathField = el("div", "ii-field");
    const pathLabel = el("label", "k-label", "儲存為");
    pathLabel.htmlFor = "import-path";
    this.path.id = "import-path";
    this.path.rows = 2;
    this.path.spellcheck = false;
    this.path.setAttribute("autocomplete", "off");
    this.path.setAttribute("autocapitalize", "off");
    this.path.maxLength = 1024;
    this.path.placeholder = "images/cover.png";
    const hint = el("p", "k-hint", "專案內的相對路徑；資料夾須已存在，不會覆寫既有檔案。");
    hint.id = "import-path-hint";
    this.pathError.id = "import-path-error";
    this.path.setAttribute("aria-describedby", "import-path-hint import-path-error");
    pathField.append(pathLabel, this.path, hint, this.pathError);

    // Focus waits here while a step runs and every control is disabled.
    this.status.tabIndex = -1;
    body.append(projectField, imageField, pathField, this.status);
    const actions = el("div", "k-dialog__actions");
    actions.append(this.cancel, this.submitButton);
    dialog.append(head, body, actions);

    this.path.addEventListener("input", () => {
      // One line by contract: a pasted line break is dropped, never sent.
      const single = this.path.value.replace(/[\r\n\u2028\u2029]+/g, "");
      if (single !== this.path.value) this.path.value = single;
      this.pathEdited = this.path.value !== this.suggested;
      this.setPathError(undefined);
      this.generalError = undefined;
      this.render();
    });
    this.path.addEventListener("blur", () => this.validatePath());
    this.path.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.path.addEventListener("compositionend", () => {
      this.composing = false;
    });
    this.path.addEventListener("keydown", (event) => {
      // Enter picking an IME candidate (封面, 圖片…) is left to the input method.
      if (pathEnterAction(event, this.composing) !== "check") return;
      // One line: Enter never inserts a break, and never imports by itself. It checks the
      // path and moves to 匯入, which takes its own deliberate press.
      event.preventDefault();
      if (this.busy || this.checking) return;
      if (this.validatePath() && !this.submitButton.disabled) this.submitButton.focus();
    });
    this.project.addEventListener("change", () => {
      this.generalError = undefined;
      this.render();
    });
    this.cancel.addEventListener("click", () => this.close());
    // The one-step import needs the user's own click (or Enter/Space on the focused button).
    this.submitButton.addEventListener("click", (event) => {
      if (event.isTrusted) void this.submit();
    });
    dialog.addEventListener("cancel", (event) => {
      // Esc follows 取消: it abandons any step except the decision, whose result must be seen.
      event.preventDefault();
      if (dialogCancelAction(this.phase) === "wait") {
        this.options.announce("正在寫入，完成後會關閉。");
        return;
      }
      this.close();
    });
    this.render();
  }

  get isOpen() {
    return this.dialog.open;
  }

  /** The dialog's own drop highlight (the modal covers the panel overlay). */
  get dropZone() {
    return this.dialog;
  }

  private get busy() {
    return this.phase !== "edit";
  }

  /**
   * Opens the dialog, optionally with an image the user just pasted or dropped. `pasteAgain`:
   * the image was pasted into the workbench frame, whose bytes never reach this panel, so the
   * dialog asks for the same paste here.
   */
  open(options: { file?: File; returnFocus?: HTMLElement; pasteAgain?: boolean } = {}) {
    if (this.dialog.open) {
      if (options.file) this.offer(options.file);
      return;
    }
    this.returnFocus = options.returnFocus;
    this.fillProjects();
    this.generalError = options.pasteAgain
      ? { text: `請在這裡再按一次 ${pasteShortcutText()} 貼上圖片。`, tone: "neutral" }
      : undefined;
    this.setPathError(undefined);
    this.imageError.hidden = true;
    if (!this.dialog.isConnected) document.body.append(this.dialog);
    this.dialog.showModal();
    this.render();
    (this.image ? this.path : this.zone.querySelector<HTMLButtonElement>("button"))?.focus();
    if (options.file) this.offer(options.file);
  }

  /** A pasted, dropped or chosen image for the open dialog. */
  offer(file: File) {
    if (!this.dialog.open || this.busy || this.checking) return;
    void this.accept(file);
  }

  private fillProjects() {
    const workspaces = this.options.workspaces();
    const current =
      this.project.value || this.options.defaultWorkspace() || workspaces[0]?.id || "";
    this.project.replaceChildren(
      ...workspaces.map((workspace) => {
        const option = el("option", undefined, workspace.name);
        option.value = workspace.id;
        return option;
      }),
    );
    this.project.value = workspaces.some((workspace) => workspace.id === current)
      ? current
      : (workspaces[0]?.id ?? "");
  }

  private async accept(file: File) {
    // Checking disables the chooser (or 換一張) that had focus; it is given back afterwards.
    const active = document.activeElement;
    const hadFocus =
      !active ||
      active === document.body ||
      active === this.dialog ||
      this.imageSlot.contains(active);
    let accepted = false;
    this.checking = true;
    this.imageError.hidden = true;
    this.generalError = undefined;
    this.render();
    try {
      const prepared = await prepareImage(file);
      if (!prepared.ok) {
        this.setImageError(prepared.code);
        return;
      }
      const canvas = await decodeToCanvas(prepared.image.blob, prepared.image);
      if (!canvas) {
        this.setImageError("DECODE_FAILED");
        return;
      }
      canvas.setAttribute("aria-label", "要匯入的圖片");
      this.setImage({ prepared: prepared.image, canvas });
      if (!this.pathEdited || !this.path.value) {
        this.suggested = suggestImagePath({
          name: prepared.image.name,
          mime: prepared.image.mime,
          now: (this.options.now ?? Date.now)(),
          folder: this.lastFolder,
        });
        this.path.value = this.suggested;
        this.pathEdited = false;
      }
      this.setPathError(undefined);
      this.options.announce(`已選擇圖片：${imageSummary(prepared.image)}`);
      accepted = true;
    } finally {
      this.checking = false;
      this.render();
      const now = document.activeElement;
      if (hadFocus && this.dialog.open && (!now || now === document.body || now === this.dialog))
        // Accepted: the next step is the name it will be saved as. Refused: back to the
        // chooser (or 換一張), with the reason read out by the alert under it.
        (accepted
          ? this.path
          : this.image
            ? this.replace
            : this.zone.querySelector("button")
        )?.focus();
    }
  }

  private setImage(image: { prepared: PreparedImage; canvas: HTMLCanvasElement } | undefined) {
    if (this.image && this.image.canvas !== image?.canvas) releaseCanvas(this.image.canvas);
    this.image = image;
  }

  private setImageError(code: string | undefined) {
    this.imageError.hidden = !code;
    this.imageError.textContent = code
      ? importErrorText(code, { mime: this.image?.prepared.mime })
      : "";
  }

  private setPathError(code: string | undefined) {
    this.pathError.hidden = !code;
    this.pathError.textContent = code
      ? importErrorText(code, { path: this.path.value.trim(), mime: this.image?.prepared.mime })
      : "";
    this.path.setAttribute("aria-invalid", String(Boolean(code)));
  }

  /** Same rules as the daemon; only it can tell whether the folder exists or the name is free. */
  private validatePath() {
    const value = this.path.value.trim();
    if (!value) return false;
    const problem = imagePathProblem(value, this.image?.prepared.mime);
    this.setPathError(problem);
    return !problem;
  }

  private render() {
    const busy = this.busy;
    const image = this.image;
    if (image) {
      if (this.figureFrame.firstChild !== image.canvas)
        this.figureFrame.replaceChildren(image.canvas);
      const summary = imageSummary(image.prepared);
      if (this.figureText.textContent !== summary) this.figureText.textContent = summary;
      this.replace.disabled = busy || this.checking;
      if (this.imageSlot.firstChild !== this.figure) this.imageSlot.replaceChildren(this.figure);
    } else {
      for (const button of this.zone.querySelectorAll("button"))
        button.disabled = busy || this.checking;
      if (this.imageSlot.firstChild !== this.zone) this.imageSlot.replaceChildren(this.zone);
    }
    const hasProject = this.options.workspaces().length > 0;
    this.project.disabled = busy || !hasProject;
    this.path.readOnly = busy;
    const line =
      this.phase !== "edit"
        ? statusLine("running", phaseText[this.phase])
        : this.checking
          ? statusLine("running", "正在檢查圖片…")
          : this.generalError
            ? statusLine(this.generalError.tone, this.generalError.text)
            : !hasProject
              ? statusLine("neutral", "還沒有專案；請先在 Desktop 加入專案。")
              : !this.options.available()
                ? statusLine("neutral", "本機工作台恢復連線後才能匯入。")
                : undefined;
    this.status.replaceChildren(...(line ? [line] : []));
    this.status.hidden = !line;
    this.dialog.setAttribute("aria-busy", String(busy));
    this.submitButton.disabled =
      busy ||
      this.checking ||
      !image ||
      !hasProject ||
      !this.options.available() ||
      !this.path.value.trim();
    this.cancel.disabled = dialogCancelAction(this.phase) === "wait";
    const label = this.submitButton.querySelector("span:last-of-type");
    if (label) label.textContent = busy ? "匯入中…" : "匯入";
    this.submitButton.querySelector("svg")?.toggleAttribute("hidden", busy);
  }

  /** While a step runs, focus stays inside the modal: on 取消 or the status line, never <body>. */
  private keepFocus() {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== this.dialog &&
      this.dialog.contains(active) &&
      !(active instanceof HTMLButtonElement && active.disabled)
    )
      return;
    this.status.focus({ preventScroll: true });
  }

  /** Moves to the next step; false once the dialog was closed (the step was abandoned). */
  private step(phase: Exclude<Phase, "edit">, abort: AbortController) {
    if (abort.signal.aborted) return false;
    this.phase = phase;
    this.render();
    this.keepFocus();
    return true;
  }

  private fail(code: string, unknown = false) {
    this.phase = "edit";
    const field = unknown ? "general" : importErrorField(code);
    if (field === "path") this.setPathError(code);
    else if (field === "image") this.setImageError(code);
    else
      this.generalError = unknown
        ? { text: "結果待確認；再按一次「匯入」會沿用同一次請求，不會重複匯入。", tone: "warning" }
        : { text: importErrorText(code, { path: this.path.value.trim() }), tone: "danger" };
    this.render();
    this.options.announce(
      unknown
        ? "結果待確認"
        : importErrorText(code, { path: this.path.value.trim(), mime: this.image?.prepared.mime }),
    );
    (field === "path"
      ? this.path
      : this.submitButton.disabled
        ? this.cancel
        : this.submitButton
    ).focus();
  }

  private async submit() {
    const image = this.image?.prepared;
    if (this.busy || this.checking || !image || !this.options.available()) return;
    const workspaceId = this.project.value;
    const path = this.path.value.trim();
    if (!workspaceId) return;
    this.path.value = path;
    if (!this.validatePath()) {
      this.path.focus();
      return;
    }
    this.generalError = undefined;
    this.imageError.hidden = true;
    // One controller for the whole chain: 取消 or Esc aborts whichever request is in flight.
    const abort = new AbortController();
    this.abort = abort;
    try {
      await this.run(image, workspaceId, path, abort);
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private async run(
    image: PreparedImage,
    workspaceId: string,
    path: string,
    abort: AbortController,
  ) {
    const stopped = () => abort.signal.aborted;
    // 1. The import itself: reuse ours when it still waits for this target.
    let item = this.created ? this.options.find(this.created.id) : undefined;
    // Our import is reused only for the same target, while it still waits for an image or
    // holds exactly this image; otherwise it is withdrawn and a new one is opened.
    const reusable =
      item !== undefined &&
      this.created?.workspace_id === workspaceId &&
      this.created.path === path &&
      (item.state === "awaiting_file" ||
        (item.state === "pending" && item.version === image.sha256));
    if (this.created && !reusable) {
      this.withdraw();
      item = undefined;
    }
    if (!item) {
      const same = this.intent?.workspace_id === workspaceId && this.intent.path === path;
      const input =
        same && this.intent
          ? this.intent
          : { workspace_id: workspaceId, request_id: crypto.randomUUID(), path };
      this.intent = input;
      if (!this.step("creating", abort)) return;
      try {
        const response = await this.options.client.create(input, abort.signal);
        if (stopped()) return;
        item = response.import;
        this.intent = undefined;
        this.created = { id: item.id, workspace_id: workspaceId, path };
        this.lastFolder = parentFolder(path);
      } catch (cause) {
        // Closed while creating: the import may exist and simply expires unused.
        if (stopped()) return;
        const error = asImportError(cause);
        // A refused create never consumed its request ID; only a lost answer keeps it.
        if (!error.unknown) this.intent = undefined;
        this.fail(error.code, error.unknown);
        return;
      }
    }

    // 2. The bytes, unless the daemon already holds them.
    if (item.state === "awaiting_file") {
      if (!this.step("uploading", abort)) return;
      try {
        const response = await this.options.client.upload(item, image, abort.signal);
        if (stopped()) return;
        item = response.import;
      } catch (cause) {
        // Closed while uploading: the upload stays unconfirmed and close() withdrew the import.
        if (stopped()) return;
        const error = asImportError(cause);
        const live = this.options.find(item.id);
        if (error.code === "IMPORT_NOT_AWAITING_FILE" && live?.state === "pending") item = live;
        else {
          this.fail(error.code, error.unknown);
          return;
        }
      }
    }
    if (item.state !== "pending" || item.version !== image.sha256) {
      // Not the bytes shown here (another image, or still receiving): review it in 需確認.
      this.phase = "edit";
      this.generalError = {
        text: "這筆匯入的圖片與這裡顯示的不同，請到需確認核對。",
        tone: "danger",
      };
      this.render();
      this.keepFocus();
      return;
    }

    // 3. Read the pending bytes back and check they are exactly this image.
    if (!this.step("verifying", abort)) return;
    try {
      const received = await this.options.client.content(item, abort.signal);
      const bytes = new Uint8Array(received.bytes);
      const problem = verifyPreview(item, {
        size: bytes.length,
        type: received.type,
        sha256: await sha256Hex(bytes),
        header: imageHeader(bytes),
      });
      bytes.fill(0);
      if (stopped()) return;
      if (problem) {
        this.phase = "edit";
        this.generalError = { text: "收到的圖片與這裡顯示的不同，因此沒有匯入。", tone: "danger" };
        this.render();
        this.keepFocus();
        return;
      }
    } catch (cause) {
      if (stopped()) return;
      this.fail(asImportError(cause).code);
      return;
    }

    // 4. Approve exactly that content. The coordinator tracks an unconfirmed result.
    if (!this.step("approving", abort)) return;
    const decided = item;
    let approved = false;
    try {
      await this.options.decide(decided, "approve");
      approved = true;
    } catch {
      // decide() already reported the outcome in the notice slot; show the import itself.
    }
    this.phase = "edit";
    this.created = undefined;
    // The verified image goes with the record (匯入時的圖片) instead of being freed here.
    const shown = approved && this.image ? this.image.canvas : undefined;
    if (shown) this.image = undefined;
    this.close(false);
    this.options.finished(
      decided.id,
      approved,
      shown ? { canvas: shown, version: image.sha256 } : undefined,
    );
  }

  /** Cancels this dialog's own unfinished import; a lost answer only leaves it to expire. */
  private withdraw() {
    const created = this.created;
    this.created = undefined;
    const item = created ? this.options.find(created.id) : undefined;
    if (item && ["awaiting_file", "preparing", "pending"].includes(item.state))
      void this.options.decide(item, "stop").catch(() => {});
  }

  /** The pairing ended: drop everything this dialog started, without sending anything. */
  dispose() {
    this.abort?.abort();
    this.phase = "edit";
    this.created = undefined;
    this.intent = undefined;
    this.close(false);
  }

  close(restoreFocus = true) {
    // Only the decision is waited for; an earlier step in flight is abandoned.
    if (!this.dialog.open || dialogCancelAction(this.phase) === "wait") return;
    this.abort?.abort();
    this.abort = undefined;
    this.phase = "edit";
    this.withdraw();
    this.intent = undefined;
    this.setImage(undefined);
    this.path.value = "";
    this.pathEdited = false;
    this.suggested = "";
    this.setPathError(undefined);
    this.imageError.hidden = true;
    this.generalError = undefined;
    this.dialog.close();
    this.render();
    if (restoreFocus) this.returnFocus?.focus();
  }
}

function asImportError(cause: unknown) {
  return cause instanceof ImportRequestError
    ? cause
    : new ImportRequestError("UNKNOWN", undefined, true);
}
