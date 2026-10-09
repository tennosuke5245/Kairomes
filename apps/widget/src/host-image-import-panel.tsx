import {
  imagePathProblem,
  imagePathProblemText,
  suggestImagePath,
} from "@kairomes/protocol/image-path";
import { ImageIcon } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";
import { friendlyError } from "./errors.ts";
import {
  downloadUrlOf,
  type HostImage,
  hostFileApi,
  hostImageMime,
  hostImportArguments,
  selectedImage,
  visibleFileName,
} from "./host-image-import.ts";
import { ResultError } from "./tool-result.ts";
import { iconProps } from "./ui-icons.tsx";

type Step =
  | { kind: "idle" }
  | { kind: "choosing" }
  | { kind: "chosen"; image: HostImage }
  | { kind: "sending"; image: HostImage }
  | { kind: "sent"; path: string }
  /** The call's answer was lost: 再試一次 resends the same request ID with a fresh URL. */
  | { kind: "unknown"; image: HostImage; requestId: string; path: string }
  | { kind: "failed"; message: string };

/**
 * 從 ChatGPT 選擇圖片 (ChatGPT host viewer only, feature-detected): pick a conversation image,
 * name its target, and ask Kairomes to import it. The side panel then shows it for review.
 */
export function HostImageImport({
  bridge,
  workspaceId,
  folder,
}: {
  bridge: WorkbenchBridge;
  workspaceId: string;
  folder: string;
}) {
  const api = useMemo(() => (bridge.mode === "host" ? hostFileApi(window) : undefined), [bridge]);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [path, setPath] = useState("");
  const [pathError, setPathError] = useState("");
  const id = useId();
  const chooseButton = useRef<HTMLButtonElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  /** Focus follows each step, so it never falls to <body> when a control unmounts. */
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const target =
      step.kind === "chosen" || step.kind === "sending"
        ? pathInput.current
        : step.kind === "unknown"
          ? retryButton.current
          : step.kind === "sent" || step.kind === "failed"
            ? noticeRef.current
            : step.kind === "idle"
              ? chooseButton.current
              : null;
    target?.focus();
  }, [step]);
  const go = (next: Step) => {
    moveFocus.current = true;
    setStep(next);
  };
  if (!api || !workspaceId) return null;

  async function choose() {
    if (!api) return;
    go({ kind: "choosing" });
    try {
      const image = selectedImage(
        await api.selectFiles({
          multiple: false,
          accept: ["image/png", "image/jpeg", "image/webp"],
        }),
      );
      if (!image) {
        go({ kind: "idle" });
        return;
      }
      const mime = hostImageMime(image) ?? "image/png";
      setPath(suggestImagePath({ name: image.fileName ?? "", mime, now: Date.now(), folder }));
      setPathError("");
      go({ kind: "chosen", image });
    } catch (cause) {
      go({ kind: "failed", message: friendlyError(cause, "無法開啟 ChatGPT 的檔案選擇。") });
    }
  }

  async function send(image: HostImage, target: string, requestId: string) {
    if (!api) return;
    go({ kind: "sending", image });
    let url: string | undefined;
    try {
      url = downloadUrlOf(await api.getFileDownloadUrl({ fileId: image.fileId }));
    } catch {
      url = undefined;
    }
    if (!url) {
      go({ kind: "failed", message: "ChatGPT 沒有交出這張圖片，請改在 Kairomes 側欄貼上。" });
      return;
    }
    try {
      const result = await bridge.call(
        "image_import_request",
        hostImportArguments({ workspaceId, path: target, requestId, image, downloadUrl: url }),
      );
      url = undefined;
      // The import's later states (pending, applied…) show in the activity list and the side
      // panel; this note only says where to go next, so it never shows a stale state.
      go(
        result.kind === "image_import"
          ? { kind: "sent", path: target }
          : { kind: "failed", message: "Kairomes 沒有回報匯入狀態。" },
      );
    } catch (cause) {
      url = undefined;
      // A refusal is final; anything else may have been received, so keep the request ID.
      go(
        cause instanceof ResultError
          ? { kind: "failed", message: friendlyError(cause, "Kairomes 沒有接受這個匯入。") }
          : { kind: "unknown", image, requestId, path: target },
      );
    }
  }

  function submit(image: HostImage) {
    const target = path.trim();
    const problem = imagePathProblem(target, hostImageMime(image));
    if (problem) {
      setPathError(imagePathProblemText(problem, hostImageMime(image)));
      return;
    }
    void send(image, target, crypto.randomUUID());
  }

  const busy = step.kind === "choosing" || step.kind === "sending";
  return (
    <section className="hv-import" aria-label="從 ChatGPT 匯入圖片">
      {(step.kind === "idle" ||
        step.kind === "choosing" ||
        step.kind === "sent" ||
        step.kind === "failed") && (
        <button
          ref={chooseButton}
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          disabled={busy}
          onClick={() => void choose()}
        >
          <ImageIcon {...iconProps("sm")} />從 ChatGPT 選擇圖片
        </button>
      )}
      {(step.kind === "chosen" || step.kind === "sending") && (
        <form
          className="hv-import__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (step.kind === "chosen") submit(step.image);
          }}
        >
          {step.image.fileName && (
            <p className="hv-import__file">
              已選擇 <span className="k-mono">{visibleFileName(step.image.fileName)}</span>
            </p>
          )}
          <label className="k-label" htmlFor={`${id}-path`}>
            儲存為
          </label>
          <input
            ref={pathInput}
            id={`${id}-path`}
            className="k-input k-input--mono"
            value={path}
            spellCheck={false}
            autoComplete="off"
            maxLength={1024}
            readOnly={step.kind === "sending"}
            aria-invalid={pathError ? true : undefined}
            aria-describedby={`${id}-hint ${id}-error`}
            onChange={(event) => {
              setPath(event.target.value);
              setPathError("");
            }}
          />
          <p id={`${id}-hint`} className="k-hint">
            資料夾須已存在；送出後請在 Kairomes 側欄核對並匯入。
          </p>
          <p id={`${id}-error`} className="k-error" role="alert" hidden={!pathError}>
            {pathError}
          </p>
          <div className="hv-import__actions">
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              disabled={step.kind === "sending"}
              onClick={() => go({ kind: "idle" })}
            >
              取消
            </button>
            <button
              type="submit"
              className="k-btn k-btn--primary k-btn--sm"
              disabled={step.kind === "sending"}
            >
              {step.kind === "sending" ? "送出中…" : "送出匯入"}
            </button>
          </div>
        </form>
      )}
      {step.kind === "sent" && (
        <p ref={noticeRef} tabIndex={-1} className="k-notice" data-tone="brand" role="status">
          <span className="k-notice__body">
            <span className="k-notice__title">已送出</span>{" "}
            <span className="k-mono">{step.path}</span>：請在 Kairomes 側欄核對並匯入。
          </span>
        </p>
      )}
      {step.kind === "unknown" && (
        <p className="k-notice" data-tone="warning" role="status">
          <span className="k-notice__body">
            結果待確認；再試一次會沿用同一個請求，不會重複匯入。
          </span>
          <button
            ref={retryButton}
            type="button"
            className="k-btn k-btn--secondary k-btn--sm k-notice__action"
            onClick={() => void send(step.image, step.path, step.requestId)}
          >
            再試一次
          </button>
        </p>
      )}
      {step.kind === "failed" && (
        <p ref={noticeRef} tabIndex={-1} className="k-notice" data-tone="danger" role="alert">
          <span className="k-notice__body">{step.message}</span>
        </p>
      )}
    </section>
  );
}
